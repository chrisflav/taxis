import { useCallback, useEffect, useState } from "react";

// A small stale-while-revalidate cache over the API.
//
// Views are unmounted and remounted on every navigation (list -> detail -> back), so without this
// each one re-issues the same reads from scratch and shows a spinner while a slow link answers.
// Here the last response for a key is kept, so a revisit paints immediately and the network fetch
// only updates what's already on screen. Responses carry an `ETag` and `Cache-Control: no-cache`,
// so a revalidation the browser turns into a `304` costs a round trip but no payload.

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
  if (prefix == null) {
    entries.clear();
    return;
  }
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) entries.delete(key);
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
  /** Discard this key's cached value and fetch it again. */
  reload: () => void;
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
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (key == null) {
      setData(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const cached = peekCached<T>(key);
    setData(cached);
    setLoading(cached === undefined);
    cachedGet(key, fetcher, maxAgeMs)
      .then((fresh) => {
        if (cancelled) return;
        setData(fresh);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, maxAgeMs]);

  const reload = useCallback(() => {
    if (key != null) invalidateCache(key);
    setNonce((n) => n + 1);
  }, [key]);

  return { data, loading, error, reload };
}
