import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueListRow } from "./types";
import { api, issuePagePath, type IssuePageQuery } from "./api";
import { cachedGet } from "./cache";

/**
 * The issue list's rows, pulled a page at a time and accumulated locally.
 *
 * The list used to read every matching issue in one response, which is a fixed idea of what a
 * tracker costs to open — 341 KB gzipped at ten thousand issues, before a row could be drawn. Here
 * the first page arrives at a size that does not depend on how big the tracker is, the table draws
 * it, and further pages are fetched when something actually wants them.
 *
 * That last part is the difference between this and a background loader. Pulling to the cap on
 * arrival cost 25 requests and 179 KB on a ten-thousand-issue tracker, all of it after the page
 * was already drawn and readable, and all of it competing for a slow link with the route's own
 * code, the markdown parser and the fonts. Almost none of it was ever looked at: the table shows
 * twenty-five rows at a time. So the consumer says how many rows it needs (`ensure`), typically
 * one page ahead of what it is showing, and the feed fetches to there and stops.
 *
 * Searching stays local where it can. Typing filters the rows already held, with no request at
 * all; a server search reaches what is *not* held — see `shouldAskServer` for the conditions that
 * have to hold before one is sent, all of which exist to keep that rare.
 */

/** Rows per request. Large enough that a tracker of a few hundred arrives in one or two, small
    enough that the first one paints promptly on a slow link — about 7 KB gzipped. */
export const PAGE_SIZE = 200;

/** How many rows to accumulate before the feed stops fetching at all.
 *
 *  Past this the tracker is large enough that holding all of it costs more than it saves: the
 *  filtering it enables is over a set nobody scrolls, and the memory and parse time are real. The
 *  cap is what makes the server search necessary rather than merely available — beyond it, the
 *  rows that match a query may simply not be here. */
export const FEED_CAP = 5000;

/** How long typing has to stop before the tail is searched. */
const SEARCH_DEBOUNCE_MS = 350;

/** Where the first page's path is left for the next page load.
 *
 *  `index.html` fires the list's read before the bundle arrives, and the query depends on filters
 *  and a sort that only this code knows how to build. Rather than reimplement that derivation in
 *  the page — where it would drift — the derivation writes down its answer and the page replays
 *  it. A stale entry costs one page fetched under a name nobody asks for; nothing breaks. */
export const LIST_QUERY_STORAGE_KEY = "taxis:list-query";

export interface IssueFeed {
  /** Every row held, in server order. */
  rows: IssueListRow[];
  /** Ids the server returned for the current query — these match it however the client's own text
      filter would judge them, so a row found by its description still shows. */
  serverMatched: Set<number>;
  /** Total matching the server-side filters, as of the first page. */
  total: number | null;
  /** True once every matching row is held, so no server search can add anything. */
  complete: boolean;
  /** True when loading stopped at `FEED_CAP` rather than at the end. */
  capped: boolean;
  /** Nothing to show yet. A background page does not count. */
  loading: boolean;
  /** A further page is on its way. */
  streaming: boolean;
  searching: boolean;
  error: string | null;
  reload: () => void;
  /** Ask for at least `n` rows to be held, fetching pages until there are (or the result set ends).
      What the list is about to show, plus a page of slack, so paging forward is instant without
      pulling rows nobody asked for. */
  ensure: (n: number) => void;
}

/** Whether the tail is worth asking the server about.
 *
 *  Each condition removes a class of pointless request, and together they are what keeps typing
 *  from becoming a request per keystroke:
 *
 *  - nothing to search for, or too short to be selective;
 *  - every matching row is already here, so the server cannot know more;
 *  - this exact query was already asked;
 *  - a *prefix* of it was asked and came back short. If "foo" returned fewer rows than a full page,
 *    then everything matching "foobar" was in that answer, because a match for "foobar" is a match
 *    for "foo". Typing further into a narrowing search therefore costs nothing.
 */
function shouldAskServer(query: string, complete: boolean, asked: Map<string, number>): boolean {
  const q = query.trim();
  if (q.length < 2 || complete || asked.has(q)) return false;
  for (const [prev, count] of asked) {
    if (q.startsWith(prev) && count < PAGE_SIZE) return false;
  }
  return true;
}

const EMPTY_ROWS: IssueListRow[] = [];

/** `enabled` false holds the feed at rest without breaking the rules of hooks — the tree view
    reads its own levels and has no use for the flat list, and pulling it anyway cost a few hundred
    kilobytes of rows nothing was going to draw. */
export function useIssueFeed(query: IssuePageQuery, search: string, enabled = true): IssueFeed {
  // The server-side filters, as a string, so the effect restarts exactly when they change and not
  // when the caller happens to rebuild the object.
  const key = JSON.stringify(query);

  const [rows, setRows] = useState<IssueListRow[]>(EMPTY_ROWS);
  const [total, setTotal] = useState<number | null>(null);
  const [complete, setComplete] = useState(false);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverMatched, setServerMatched] = useState<Set<number>>(() => new Set());
  const [nonce, setNonce] = useState(0);
  /** How many rows have been asked for. Only ever raised, and reset with the filters. */
  const [want, setWant] = useState(PAGE_SIZE);

  // Ids held, so a page or a search result can be merged without rescanning the array.
  const held = useRef<Set<number>>(new Set());
  // Queries already put to the server for this filter set, and how many rows each returned.
  const asked = useRef<Map<string, number>>(new Map());
  // Where the next page resumes, and whether there is one.
  const cursor = useRef<string | undefined>(undefined);
  const exhausted = useRef(false);
  const fetching = useRef(false);
  // Bumped on every restart; an in-flight response carrying a stale generation is discarded.
  const generation = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const ensure = useCallback((n: number) => setWant((w) => (n > w ? n : w)), []);

  // Start over: new filters, or an explicit reload.
  useEffect(() => {
    generation.current++;
    held.current = new Set();
    asked.current = new Map();
    cursor.current = undefined;
    exhausted.current = false;
    fetching.current = false;
    setRows(EMPTY_ROWS);
    setServerMatched(new Set());
    setTotal(null);
    setComplete(false);
    setCapped(false);
    setError(null);
    setWant(PAGE_SIZE);
    setLoading(enabled);
    setStreaming(false);
  }, [key, nonce, enabled]);

  // Pull one page whenever fewer rows are held than have been asked for. Re-running as `rows`
  // grows is what makes this a loop; stopping when the demand is met is what makes it a short one.
  useEffect(() => {
    if (!enabled) { setLoading(false); setStreaming(false); return; }
    if (fetching.current || exhausted.current) return;
    if (rows.length >= want || rows.length >= FEED_CAP) { setStreaming(false); return; }

    const gen = generation.current;
    fetching.current = true;
    setStreaming(true);
    const first = cursor.current == null;
    const path = issuePagePath({ ...query, limit: PAGE_SIZE });
    if (first) {
      try {
        localStorage.setItem(LIST_QUERY_STORAGE_KEY, path);
      } catch { /* private mode: the page falls back to the default query */ }
    }
    // The first page goes through the cache so it can adopt the request `index.html` already
    // started — which is the difference between the rows arriving with the bundle and arriving a
    // round trip after it. Later pages are plain reads: nothing preloads a cursor.
    const pending = first
      ? cachedGet(path, () => api.issuePage({ ...query, limit: PAGE_SIZE }))
      : api.issuePage({ ...query, limit: PAGE_SIZE, cursor: cursor.current });
    pending
      .then((page) => {
        if (generation.current !== gen) return;
        const fresh = page.issues.filter((r) => !held.current.has(r.id));
        fresh.forEach((r) => held.current.add(r.id));
        setRows((prev) => (prev === EMPTY_ROWS ? fresh : prev.concat(fresh)));
        if (page.total != null) setTotal(page.total);
        // A page that added nothing means the cursor is not advancing. That should be impossible,
        // and when it was possible — an order whose cursor the server ignored — this loop asked for
        // the same page several thousand times before anyone noticed. Termination should not rest
        // on the server and the client agreeing about the order.
        if (!page.nextCursor || fresh.length === 0) {
          exhausted.current = true;
          setComplete(true);
        } else {
          cursor.current = page.nextCursor;
          if (held.current.size >= FEED_CAP) { exhausted.current = true; setCapped(true); }
        }
      })
      .catch((e) => { if (generation.current === gen) setError(String(e)); })
      .finally(() => {
        if (generation.current !== gen) return;
        fetching.current = false;
        setLoading(false);
        setStreaming(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, enabled, want, rows]);

  // Reach the rows the feed has not pulled, once typing has stopped. This is what makes fetching
  // on demand safe rather than a way to lose rows: what is not held is one request away, and the
  // request only happens when a query is specific enough to be worth it.
  useEffect(() => {
    const q = search.trim();
    if (!enabled || !shouldAskServer(q, complete, asked.current)) return;
    const gen = generation.current;
    const timer = setTimeout(() => {
      setSearching(true);
      api.issuePage({ ...query, q, limit: PAGE_SIZE })
        .then((page) => {
          if (generation.current !== gen) return;
          asked.current.set(q, page.issues.length);
          const fresh = page.issues.filter((r) => !held.current.has(r.id));
          fresh.forEach((r) => held.current.add(r.id));
          if (fresh.length) setRows((prev) => prev.concat(fresh));
          setServerMatched(new Set(page.issues.map((r) => r.id)));
        })
        .catch(() => { /* the local rows are still shown; a failed tail search is not fatal */ })
        .finally(() => { if (generation.current === gen) setSearching(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, key, complete, enabled]);

  return {
    rows, serverMatched, total, complete, capped, loading, streaming, searching, error, reload, ensure,
  };
}
