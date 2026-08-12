import { useCallback, useEffect, useRef, useState } from "react";
import { describeReadFailure, isNetworkError } from "./netError";
import { forget, forgetPrefix, hydrate, remember } from "./readCache";

// A small stale-while-revalidate cache over the API.
//
// Views are unmounted and remounted on every navigation (list -> detail -> back), so without this
// each one re-issues the same reads from scratch and shows a spinner while a slow link answers.
// Here the last response for a key is kept, so a revisit paints immediately and the network fetch
// only updates what's already on screen. Responses carry an `ETag` and `Cache-Control: no-cache`,
// so a revalidation the browser turns into a `304` costs a round trip but no payload.
//
// In memory only in a browser, and deliberately. Mirroring it into `sessionStorage` made a reload
// behave unlike a load: a fresh page came up with every issue the tab had ever opened already in
// hand, which is not what loading a page should mean. A page load fetches what that page needs and
// nothing else; the cache exists to make *navigation within* the session cheap, which is where the
// repeat reads actually are.
//
// The packaged app is the exception, and `readCache.ts` says why at length: there a cold page load
// is not somebody asking for the page, it is the system having reclaimed the WebView, so starting
// empty every time meant an offline launch showed a connection error over a blank list for issues
// that had been read a dozen times. Persisting changes when data is thrown away, not whether it is
// trusted — a restored entry keeps its original timestamp and is therefore stale on arrival, to be
// painted at once and revalidated at once, exactly like an old in-memory one.

interface Entry {
  data: unknown;
  /** When this entry was last written, for the `maxAgeMs` freshness check. */
  at: number;
}

const entries = new Map<string, Entry>(hydrate());
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

/** Replace the cached value for `key` without fetching it.
 *
 *  For the offline queue, and only for it: a write that could not be sent still has to be visible
 *  to a reader who navigates away and comes back, and while there is no connection there is no
 *  request that could tell them. Nothing else should write here — a cached entry is otherwise a
 *  copy of what the server said, and the moment it stops being that it stops being a cache.
 *
 *  Deliberately silent: mounted components hold their own copy of what they read, so this changes
 *  what the *next* read of the key sees and not what is currently on screen. */
export function writeCached<T>(key: string, data: T): void {
  const entry = { data, at: Date.now() };
  entries.set(key, entry);
  remember(key, entry);
}

/** Drop exactly one key, where `invalidateCache` drops a prefix.
 *
 *  The difference matters to any caller holding a path rather than a namespace: `"/issues/12"` is a
 *  prefix of `"/issues/120"` and of `"/issues/12/ancestors"`, so dropping "just that issue" through
 *  `invalidateCache` takes nine of its neighbours and its ancestor chain with it. Harmless when a
 *  re-read is a round trip away; not harmless offline, where a dropped entry is data that cannot be
 *  fetched back. */
export function dropCached(key: string): void {
  entries.delete(key);
  forget(key);
}

/** A request the page started before any of this code existed.
 *
 *  `index.html` fires the reads a route needs from an inline script, so they overlap the download
 *  of the bundle instead of waiting for it. Taking one over here is what connects the two: the
 *  first caller for that key gets the response that has been on its way since the first round
 *  trip. Each is claimed once — a second read of the same key is a genuine re-read. */
function claimPreloaded<T>(key: string): Promise<T> | undefined {
  const store = (window as unknown as { __taxisPreload?: Record<string, Promise<unknown>> }).__taxisPreload;
  const hit = store?.["/api" + key];
  if (!hit) return undefined;
  delete store!["/api" + key];
  return hit as Promise<T>;
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

  const request = (claimPreloaded<T>(key) ?? fetcher())
    .then((data) => {
      const entry = { data, at: Date.now() };
      entries.set(key, entry);
      remember(key, entry);
      return data;
    })
    .catch((e) => {
      // Nothing answered, and there is a previous answer: that is what the reader should see. The
      // rule is the one the write queue uses in the other direction — a failure to *reach* the
      // server is not the server saying anything, so it is not news. A 403, a 409, a 500 are the
      // server talking and go on being errors, cached copy or not.
      const held = entries.get(key);
      if (isNetworkError(e) && held) return held.data as T;
      throw e;
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
  forgetPrefix(prefix);
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
  /** Whether `error` is "nothing answered" rather than something the server said. The two want
      different words and a different tone: one is a situation the reader is in and can wait out,
      the other is an answer they have been given. */
  offline: boolean;
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
  const [offline, setOffline] = useState(false);

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
        setOffline(false);
      })
      .catch((e) => {
        if (!live.current) return;
        setError(describeReadFailure(e));
        setOffline(isNetworkError(e));
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

  return { data, loading, error, offline, reload };
}
