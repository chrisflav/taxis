import { useEffect, useMemo, useRef, useState } from "react";
import type { IssueIndexEntry } from "./types";
import { api, issueIndexPath } from "./api";
import { REFERENCE_MAX_AGE, cachedGet } from "./cache";

/**
 * What issues are called, learned as they are needed.
 *
 * Naming an issue — in a breadcrumb, a `#123` reference, a parent chip, a picker — needs three
 * fields, and the application used to get them by downloading three fields for *every* issue in
 * the tracker, on every page load, before anything could be drawn. That was 140 KB gzipped at ten
 * thousand issues and it grew with the tracker; the Labels page paid it to draw twelve labels.
 *
 * Here nothing is fetched ahead of a question. Names arrive three ways:
 *
 *   - free, from responses that carry them anyway (list rows, graph nodes, an issue's ancestors);
 *   - by id, for the handful a page actually names — batched into one request per tick, so a rail
 *     with a parent and six dependencies asks once;
 *   - by search, for a picker, where the query goes to the server and the answer is bounded.
 *
 * Entries are kept for the life of the tab. A title that changed under us is a cosmetic staleness
 * in a label, and the pages that display an issue read it properly.
 */

const known = new Map<number, IssueIndexEntry>();
/** Ids the server did not return — deleted, or not visible to this reader. Remembered so a page
    referring to one does not ask for it again on every render. */
const absent = new Set<number>();
const subscribers = new Set<() => void>();

let pending = new Set<number>();
let flushing = false;

/** How many ids to name in one request. Long enough that a page asks once, short enough that the
    URL stays a URL. */
const BATCH = 100;

function notify(): void {
  subscribers.forEach((f) => f());
}

/** Record names carried by a response that had them anyway. Cheap, and it is what makes most
    lookups cost nothing: a list row names its own issue, and a `#123` pointing at a row on screen
    resolves without asking anybody. */
export function learnIssueNames(entries: Iterable<IssueIndexEntry>): void {
  let added = false;
  for (const e of entries) {
    if (e == null) continue;
    const prev = known.get(e.id);
    if (prev && prev.title === e.title && prev.parent === e.parent) continue;
    known.set(e.id, { id: e.id, title: e.title, parent: e.parent ?? null });
    absent.delete(e.id);
    added = true;
  }
  if (added) notify();
}

/** Fetch every pending id, in batches, and wake whoever is waiting. */
function flush(): void {
  flushing = false;
  const ids = [...pending];
  pending = new Set();
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    // Through the shared cache, so two views mounting on the same ids in the same navigation make
    // one request between them.
    cachedGet(issueIndexPath({ ids: chunk }), () => api.issueIndex({ ids: chunk }), REFERENCE_MAX_AGE)
      .then((entries) => {
        const returned = new Set(entries.map((e) => e.id));
        chunk.forEach((id) => { if (!returned.has(id)) absent.add(id); });
        // Always notify: an id that came back absent settles a placeholder just as an id that came
        // back named does.
        learnIssueNames(entries);
        notify();
      })
      .catch(() => { /* the ids stay unknown and render as bare numbers */ });
  }
}

/** Ask for the names of `ids` that are not already held, collapsing everything requested in the
    same tick into one request. */
export function requestIssueNames(ids: Iterable<number>): void {
  let queued = false;
  for (const id of ids) {
    if (!Number.isFinite(id) || known.has(id) || absent.has(id) || pending.has(id)) continue;
    pending.add(id);
    queued = true;
  }
  if (!queued || flushing) return;
  flushing = true;
  // A tick, not a microtask: a component tree mounting spreads its lookups over its own render
  // pass, and this batches the whole pass rather than the first component in it.
  setTimeout(flush, 0);
}

/** Re-render this component whenever a name is learned.
 *
 *  `active` is not a nicety. The graph draws a card per issue and every card renders markdown, so
 *  a subscription per rendered title is ten thousand callbacks to run each time anything at all is
 *  learned — for ten thousand components, nearly none of which are waiting on a name. A component
 *  with nothing to look up subscribes to nothing. */
function useIssueNameStore(active = true): number {
  const [version, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const wake = () => bump((n) => n + 1);
    subscribers.add(wake);
    return () => { subscribers.delete(wake); };
  }, [active]);
  return version;
}

/** The names of `ids`, fetching whichever are not held yet. Re-renders as they arrive. */
export function useIssueNames(ids: number[]): Map<number, IssueIndexEntry> {
  const version = useIssueNameStore(ids.length > 0);
  // Sorted and joined, so an array rebuilt on every render does not re-run the fetch: what is
  // being asked for is a set of ids, not the array that happens to carry them.
  const key = ids.slice().sort((a, b) => a - b).join(",");
  useEffect(() => {
    requestIssueNames(key ? key.split(",").map(Number) : []);
  }, [key]);
  return useMemo(() => {
    const out = new Map<number, IssueIndexEntry>();
    for (const id of key ? key.split(",").map(Number) : []) {
      const hit = known.get(id);
      if (hit) out.set(id, hit);
    }
    return out;
  }, [key, version]);
}

/** One name, for the many callers that want exactly one. */
export function useIssueName(id: number | null | undefined): IssueIndexEntry | undefined {
  useIssueNameStore(id != null);
  useEffect(() => { if (id != null) requestIssueNames([id]); }, [id]);
  return id == null ? undefined : known.get(id);
}

/** One name if it is already held — never fetched.
 *
 *  For a caller that is *about* to be told the answer: the issue page's skeleton names the issue
 *  it is loading, and asking for that name is asking for a copy of what the response in flight
 *  already carries. Known-or-placeholder is the right trade there. */
export function useKnownIssueName(id: number | null | undefined): IssueIndexEntry | undefined {
  useIssueNameStore(id != null);
  return id == null ? undefined : known.get(id);
}

/** How long typing stops before a picker asks the server. */
const SEARCH_DEBOUNCE_MS = 200;
/** How many matches a picker shows. The server caps this too. */
export const SEARCH_LIMIT = 50;

export interface IssueSearch {
  options: IssueIndexEntry[];
  loading: boolean;
}

/**
 * The issues matching what someone has typed into a picker.
 *
 * The picker used to filter a local copy of the whole tracker, which is why there was a local copy
 * of the whole tracker. Searching where the issues are costs one small request per pause in typing
 * and reaches every issue rather than the ones that happened to be downloaded.
 *
 * With an empty query it asks for the most recently updated issues, which is what the list this
 * replaced showed at the top anyway.
 */
export function useIssueSearch(query: string, enabled = true): IssueSearch {
  const [options, setOptions] = useState<IssueIndexEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const q = query.trim();

  useEffect(() => {
    if (!enabled) { setOptions([]); setLoading(false); return; }
    const gen = ++generation.current;
    setLoading(true);
    const timer = setTimeout(() => {
      const request = { q: q || undefined, limit: SEARCH_LIMIT };
      cachedGet(issueIndexPath(request), () => api.issueIndex(request), REFERENCE_MAX_AGE)
        .then((entries) => {
          if (generation.current !== gen) return;
          // Everything a picker offers is a name the rest of the page can now use for free.
          learnIssueNames(entries);
          setOptions(entries);
        })
        .catch(() => { if (generation.current === gen) setOptions([]); })
        .finally(() => { if (generation.current === gen) setLoading(false); });
      // An empty query is not typing, so it does not wait for typing to stop.
    }, q ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [q, enabled]);

  return { options, loading };
}
