import { useCallback, useEffect, useRef, useState } from "react";

// A small stale-while-revalidate cache over the API.
//
// Views are unmounted and remounted on every navigation (list -> detail -> back), so without this
// each one re-issues the same reads from scratch and shows a spinner while a slow link answers.
// Here the last response for a key is kept, so a revisit paints immediately and the network fetch
// only updates what's already on screen. Responses carry an `ETag` and `Cache-Control: no-cache`,
// so a revalidation the browser turns into a `304` costs a round trip but no payload.
//
// In memory only, and deliberately. Mirroring it into `sessionStorage` made a reload behave unlike
// a load: a fresh page came up with every issue the tab had ever opened already in hand, which is
// not what loading a page should mean. A page load now fetches what that page needs and nothing
// else; the cache exists to make *navigation within* the session cheap, which is where the repeat
// reads actually are.

interface Entry {
  data: unknown;
  /** When this entry was last written, for the `maxAgeMs` freshness check. */
  at: number;
}

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** How long reference data (labels, actors, groups, plugins, the issue index) may be reused
    without asking the server again. It changes rarely and is read by nearly every view. */
export const REFERENCE_MAX_AGE = 5 * 60_000;
/** Issue lists revalidate readily — someone else's edit should show up without a manual reload —
    but not several times within one burst of navigation. */
export const LIST_MAX_AGE = 15_000;

/** The cached value for `key`, if one has been fetched. Used to paint before the network answers. */
export function peekCached<T>(key: string): T | undefined {
  const hit = entries.get(key);
  return hit ? (hit.data as T) : undefined;
}

/**
 * Fetch `key`, reusing the stored value when it is younger than `maxAgeMs` and collapsing
 * concurrent calls for the same key into a single request.
 */
export function cachedGet<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = 0): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.data as T);

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const request = fetcher()
    .then((data) => {
      entries.set(key, { data, at: Date.now() });
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/**
 * Drop cached entries. With no argument the whole cache goes; with a prefix, every key starting
 * with it (so `invalidateCache("/issues")` covers the list, its filtered variants and details).
 */
export function invalidateCache(prefix?: string): void {
  for (const key of [...entries.keys()]) {
    if (prefix == null || key.startsWith(prefix)) entries.delete(key);
  }
}

/** A stable empty array for resources that have not loaded yet, so memoised children compare
    equal instead of seeing a fresh `[]` on every render. */
export const EMPTY: never[] = [];

export interface Resource<T> {
  /** The cached value, if any — present on the first render of a revisit. */
  data: T | undefined;
  /** True only when there is nothing to show yet; a background revalidation does not count. */
  loading: boolean;
  error: string | null;
  /** Discard this key's cached value and fetch it again, leaving the current value on screen until
      the new one lands. Resolves once it has been applied, so a caller that must not act before
      then — an inline editor closing onto the text it just saved — can await it. */
  reload: () => Promise<void>;
}

/**
 * Subscribe a component to one cached key. Passing `null` as the key skips the fetch entirely,
 * which is how a view defers data it only needs once the user opens something.
 *
 * `fetcher` is deliberately not a dependency: callers pass an inline closure, and the key already
 * identifies the request.
 */
export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  maxAgeMs = 0,
): Resource<T> {
  const [data, setData] = useState<T | undefined>(() => (key == null ? undefined : peekCached<T>(key)));
  const [loading, setLoading] = useState(key != null && peekCached<T>(key) === undefined);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref so `reload` can call the current closure without being rebuilt on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // Guards every state write, so a response that arrives after the key changed — or after the
  // component went away — is dropped rather than painted over the newer view.
  const live = useRef(true);

  /** Fetch `k` and apply the result. `keepPrevious` decides what is on screen while that happens:
      a key change has nothing to do with the value being replaced, so it shows that key's cached
      value (or nothing); a reload of the *same* key keeps what is already rendered, which is what
      stops an inline save blanking the page it just edited. */
  const run = useCallback((k: string, maxAge: number, keepPrevious: boolean): Promise<void> => {
    if (!keepPrevious) {
      const cached = peekCached<T>(k);
      setData(cached);
      setLoading(cached === undefined);
    }
    return cachedGet(k, () => fetcherRef.current(), maxAge)
      .then((fresh) => {
        if (!live.current) return;
        setData(fresh);
        setError(null);
      })
      .catch((e) => {
        if (live.current) setError(String(e));
      })
      .finally(() => {
        if (live.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    live.current = true;
    if (key == null) {
      setData(undefined);
      setLoading(false);
    } else {
      void run(key, maxAgeMs, false);
    }
    return () => {
      live.current = false;
    };
  }, [key, maxAgeMs, run]);

  const reload = useCallback((): Promise<void> => {
    if (key == null) return Promise.resolve();
    invalidateCache(key);
    return run(key, 0, true);
  }, [key, run]);

  return { data, loading, error, reload };
}
