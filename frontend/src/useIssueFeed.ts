import { useCallback, useEffect, useRef, useState } from "react";
import type { IssueListRow } from "./types";
import { api, type IssuePageQuery } from "./api";

/**
 * The issue list's rows, pulled a page at a time and accumulated locally.
 *
 * The list used to read every matching issue in one response, which is a fixed idea of what a
 * tracker costs to open — 341 KB gzipped at ten thousand issues, before a row could be drawn. Here
 * the first page arrives at a size that does not depend on how big the tracker is, the table draws
 * it, and the rest follows in the background.
 *
 * Searching stays local. Typing filters the rows already held, with no request at all, which is
 * both instant and the whole reason for accumulating them. A server search only exists to reach
 * what is *not* held — see `shouldAskServer` for the four conditions that have to hold before one
 * is sent, all of which exist to keep that rare.
 */

/** Rows per request. Large enough that a tracker of a few hundred arrives in one or two, small
    enough that the first one paints promptly on a slow link — about 7 KB gzipped. */
export const PAGE_SIZE = 200;

/** How many rows to accumulate before the background loader stops.
 *
 *  Past this the tracker is large enough that holding all of it costs more than it saves: the
 *  filtering it enables is over a set nobody scrolls, and the memory and parse time are real. The
 *  cap is what makes the server search necessary rather than merely available — beyond it, the
 *  rows that match a query may simply not be here. */
export const FEED_CAP = 5000;

/** How long typing has to stop before the tail is searched. */
const SEARCH_DEBOUNCE_MS = 350;

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
  /** More pages are still arriving. */
  streaming: boolean;
  searching: boolean;
  error: string | null;
  reload: () => void;
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

  // Ids held, so a page or a search result can be merged without rescanning the array.
  const held = useRef<Set<number>>(new Set());
  // Queries already put to the server for this filter set, and how many rows each returned.
  const asked = useRef<Map<string, number>>(new Map());
  // Bumped on every restart; an in-flight response carrying a stale generation is discarded.
  const generation = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // Pull pages until the result set ends or the cap is reached, painting each as it lands.
  useEffect(() => {
    const gen = ++generation.current;
    if (!enabled) { setLoading(false); setStreaming(false); return; }
    held.current = new Set();
    asked.current = new Map();
    setRows(EMPTY_ROWS);
    setServerMatched(new Set());
    setTotal(null);
    setComplete(false);
    setCapped(false);
    setLoading(true);
    setStreaming(true);
    setError(null);

    (async () => {
      let cursor: string | undefined;
      let count = 0;
      try {
        for (;;) {
          const page = await api.issuePage({ ...query, limit: PAGE_SIZE, cursor });
          if (generation.current !== gen) return;
          const fresh = page.issues.filter((r) => !held.current.has(r.id));
          fresh.forEach((r) => held.current.add(r.id));
          count += fresh.length;
          setRows((prev) => (prev === EMPTY_ROWS ? fresh : prev.concat(fresh)));
          if (page.total != null) setTotal(page.total);
          setLoading(false);
          if (!page.nextCursor) { setComplete(true); break; }
          // A page that added nothing means the cursor is not advancing. That should be
          // impossible, and when it was possible — an order whose cursor the server ignored — this
          // loop asked for the same page several thousand times before anyone noticed. Termination
          // should not rest on the server and the client agreeing about the order.
          if (fresh.length === 0) { setComplete(true); break; }
          if (count >= FEED_CAP) { setCapped(true); break; }
          cursor = page.nextCursor;
        }
      } catch (e) {
        if (generation.current === gen) { setError(String(e)); setLoading(false); }
      } finally {
        if (generation.current === gen) setStreaming(false);
      }
    })();

    return () => { generation.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, enabled]);

  // Reach the rows the cap left behind, once typing has stopped.
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

  return { rows, serverMatched, total, complete, capped, loading, streaming, searching, error, reload };
}
