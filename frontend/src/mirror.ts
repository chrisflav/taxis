/**
 * The whole tracker, on the device.
 *
 * `readCache.ts` keeps the *answers this reader has already asked for*, which is the right thing
 * for a cache and the wrong thing for a phone that is about to go into a tunnel. What it holds is
 * whatever happened to be read: the first page of one filter combination, the issues that were
 * opened. Everything else — the other 9,800 rows, the same list under a different filter, the issue
 * somebody mentions in a meeting — was a connection error over a blank table.
 *
 * So this is the other half: not a cache of responses but a *copy of the issues*, filled by walking
 * the tracker rather than by reading it, and queried locally. Offline the list, its filters, its
 * sorts and its search all work over every issue the reader can see, because every one of them is
 * here. `sync.ts` is what fills it; this module is what holds it and answers questions from it.
 *
 * Three things are worth knowing about the shape.
 *
 * **List rows, not whole issues.** What is mirrored is `IssueListRow` — what the list, the tree and
 * the pickers draw. An issue's description, comments, events and artifacts are not: those live
 * behind `GET /issues/:id`, one request each, so mirroring them would be a crawl of the tracker
 * rather than a sync of it — a request per issue, where the walk below costs one per five hundred.
 * Detail for issues actually opened is what the read cache is for, and it still does that.
 *
 * **IndexedDB, not `localStorage`.** `offline.ts` names this as the upgrade path and this is the
 * thing that needed it: an origin gets about 5 MB of `localStorage` in total, a full mirror is well
 * over a megabyte of it, and the two neighbours in that quota are a read cache and — the one that
 * must never be squeezed — the only copy of somebody's unsent writes. IndexedDB is a different, far
 * larger quota, so the mirror competes with none of them.
 *
 * **The packaged app only.** In a browser the tracker serves the page: there is no launch without a
 * connection, and a walk of the whole tracker on every page load would be a large cost in aid of a
 * situation that cannot arise. `isNativeApp` is a build-time constant, so the web build folds all
 * of this away and the bundler drops it.
 */

import type { IssuePage, IssueListRow, IssueState } from "./types";
import type { IssuePageQuery } from "./api";
import { isNativeApp, onServerForgotten, serverScope } from "./server";

/** How many issues are kept. Past this the walk stops, so a tracker larger than this mirrors its
 *  most recently updated rows and says so (`complete: false` in the meta) rather than pretending.
 *  The order the walk goes in is what makes that the right N to keep: newest first, so what is
 *  dropped is the far end of a list nobody scrolls to, not a random slice.
 *
 *  Deliberately the same number as `FEED_CAP` in `useIssueFeed.ts`: answering a query means holding
 *  the mirrored rows in memory, and that is exactly the budget the list has already decided it is
 *  willing to spend on rows. Storing more than the list will ever hold would buy reach it cannot
 *  use, and cost a phone the difference. */
export const MIRROR_CAP = 5_000;

/** One issue as stored. The row is kept whole rather than spread into columns — nothing here
 *  queries by anything but the scope, and reassembling a row from columns on every read would cost
 *  more than the flat copy saves. */
interface StoredRow {
  /** `<scope>|<id>`, so one tracker's issues cannot collide with another's. */
  key: string;
  scope: string;
  id: number;
  row: IssueListRow;
}

/** Where a sync got to, per tracker. Read before a sync to decide what kind of sync it is. */
export interface MirrorMeta {
  scope: string;
  /** The actor the mirror was filled for. Issues are visibility-filtered per actor, so a mirror
      built by somebody else is not this reader's to show — it is rebuilt rather than extended. */
  actorId: number | null;
  /** The server's change-log cursor: everything at or below it is already here. Null before the
      first full read, which is the state that asks for one. */
  cursor: number | null;
  /** How many issues are stored. Shown, not relied on — deletions arrive as changes now, so this
      is no longer evidence of anything. */
  count: number;
  /** False when the first read stopped at `MIRROR_CAP` rather than at the end of the tracker. */
  complete: boolean;
  /** When the last successful sync finished. */
  syncedAt: number;
}

// -----------------------------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------------------------

const DB_NAME = "taxis";
const DB_VERSION = 1;
const ISSUES = "issues";
const META = "meta";

/** Whether there is anywhere to put a mirror. False on the web by construction, and false in the
 *  app only if IndexedDB is unavailable — in which case everything below degrades to "no mirror",
 *  which is exactly how the app behaved before this module existed. */
export const mirrorAvailable: boolean =
  isNativeApp && typeof indexedDB !== "undefined";

let opening: Promise<IDBDatabase | null> | null = null;

/** The database, opened once. A failure to open is cached as `null` rather than retried on every
 *  call: it means the environment has no IndexedDB to give (private mode, storage blocked), which
 *  is not a condition that changes within a session. */
function openDb(): Promise<IDBDatabase | null> {
  if (!mirrorAvailable) return Promise.resolve(null);
  if (opening) return opening;
  opening = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ISSUES)) {
        const store = db.createObjectStore(ISSUES, { keyPath: "key" });
        // The only question ever asked of this store: everything belonging to one tracker.
        store.createIndex("scope", "scope", { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "scope" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return opening;
}

/** Run `fill` against a transaction and resolve when the transaction itself completes.
 *
 *  `fill` sets up its requests and returns a thunk read *after* the transaction commits, which is
 *  what makes a value assembled across several `onsuccess` callbacks safe to return. Resolving on
 *  the transaction rather than on the last request is also what makes a write durable before the
 *  caller believes it is — and `fill` is synchronous by contract, because an `await` between two
 *  requests of one IndexedDB transaction lets it auto-close underneath them. */
function inTransaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  fill: (tx: IDBTransaction) => () => T,
  fallback: T,
): Promise<T> {
  return openDb().then((db) => {
    if (!db) return fallback;
    return new Promise<T>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(stores, mode);
      } catch {
        resolve(fallback);
        return;
      }
      let read: () => T;
      try {
        read = fill(tx);
      } catch {
        try { tx.abort(); } catch { /* already gone */ }
        resolve(fallback);
        return;
      }
      tx.oncomplete = () => {
        try {
          resolve(read());
        } catch {
          resolve(fallback);
        }
      };
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    });
  });
}

/** Bumped whenever what is stored changes.
 *
 *  The mirror is what the issue list reads in the packaged app, so "the sync applied something" has
 *  to reach a mounted view somehow. This is that signal, in the shape `useSyncExternalStore`
 *  wants — the same arrangement `offline.ts` uses, and for the same reason. */
let revision = 0;
const watchers = new Set<() => void>();

export function mirrorRevision(): number {
  return revision;
}

export function subscribeMirror(fn: () => void): () => void {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

/** Note that stored rows changed: drop the in-memory copy and tell anyone reading it. */
function changed(): void {
  held = null;
  revision += 1;
  watchers.forEach((f) => f());
}

/** The rows of the current scope, held in memory once read.
 *
 *  The feed pages through the mirror — a page at a time, the same way it pages through the server —
 *  so without this a single offline scroll would deserialise every stored issue once per page. The
 *  copy is dropped whenever a sync changes what is stored, so it cannot go stale. */
let held: { scope: string; rows: IssueListRow[] } | null = null;

/** Every issue stored for the current tracker, in no particular order. */
export function allRows(scope: string = serverScope()): Promise<IssueListRow[]> {
  if (held && held.scope === scope) return Promise.resolve(held.rows);
  return inTransaction<IssueListRow[]>(
    [ISSUES],
    "readonly",
    (tx) => {
      const out: IssueListRow[] = [];
      const req = tx.objectStore(ISSUES).index("scope").getAll(scope);
      req.onsuccess = () => {
        for (const stored of req.result as StoredRow[]) out.push(stored.row);
      };
      return () => out;
    },
    [],
  ).then((rows) => {
    held = { scope, rows };
    return rows;
  });
}

/** How many records one transaction writes.
 *
 *  Bounded rather than "all of them" because a transaction is a queue of individual requests, each
 *  with its own callback: twenty thousand in one goes from a write to a stall, and the batches cost
 *  nothing — they are sequential either way. It also makes an interrupted rebuild leave a partial
 *  mirror rather than none, which is the same trade the walk itself makes. */
const WRITE_BATCH = 500;

/** One transaction's worth of rows. */
function putBatch(rows: IssueListRow[], scope: string): Promise<boolean> {
  return inTransaction<boolean>(
    [ISSUES],
    "readwrite",
    (tx) => {
      const store = tx.objectStore(ISSUES);
      for (const row of rows) store.put({ key: `${scope}|${row.id}`, scope, id: row.id, row });
      return () => true;
    },
    false,
  );
}

/** Store or replace rows. Used by the walk, which knows what changed and nothing more. */
export async function putRows(rows: IssueListRow[], scope: string = serverScope()): Promise<boolean> {
  if (rows.length === 0) return true;
  changed();
  let ok = true;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    ok = (await putBatch(rows.slice(i, i + WRITE_BATCH), scope)) && ok;
  }
  return ok;
}

/** Every stored key for a tracker. One request, where a cursor would be one per issue. */
function allKeys(scope: string): Promise<string[]> {
  return inTransaction<string[]>(
    [ISSUES],
    "readonly",
    (tx) => {
      let keys: string[] = [];
      const req = tx.objectStore(ISSUES).index("scope").getAllKeys(scope);
      req.onsuccess = () => { keys = req.result as string[]; };
      return () => keys;
    },
    [],
  );
}

async function deleteKeys(keys: string[]): Promise<boolean> {
  let ok = true;
  for (let i = 0; i < keys.length; i += WRITE_BATCH) {
    const batch = keys.slice(i, i + WRITE_BATCH);
    ok = (await inTransaction<boolean>(
      [ISSUES],
      "readwrite",
      (tx) => {
        const store = tx.objectStore(ISSUES);
        for (const key of batch) store.delete(key);
        return () => true;
      },
      false,
    )) && ok;
  }
  return ok;
}

/**
 * Drop every stored issue whose id is not in `keep` — which is how a deletion finally lands.
 *
 * The counterpart to `putRows` rather than a replacement for it: a full walk has already stored
 * every row it saw, page by page, so all that is left to reconcile is what it *did not* see. Asking
 * this to re-store the rows as well would rewrite the whole mirror to change nothing, and rewriting
 * a record is the expensive kind of write — every index entry for it has to move.
 *
 * The removals are found by reading the stored keys and taking a set difference rather than by
 * walking a cursor and deleting as it goes: a cursor is a request per stored issue, to discover
 * that usually none of them has gone anywhere, where this is one request plus one per issue that
 * actually went.
 */
/** Remove exactly these issues, because the feed said they are gone or no longer visible. */
export async function removeRows(ids: number[], scope: string = serverScope()): Promise<boolean> {
  if (ids.length === 0) return true;
  changed();
  return deleteKeys(ids.map((id) => `${scope}|${id}`));
}

export async function retainOnly(keep: Iterable<number>, scope: string = serverScope()): Promise<boolean> {
  const wanted = new Set<string>();
  for (const id of keep) wanted.add(`${scope}|${id}`);
  const stale = (await allKeys(scope)).filter((key) => !wanted.has(key));
  if (stale.length === 0) return true;
  changed();
  return deleteKeys(stale);
}

/** How many issues are stored for a tracker — the count a sync compares against the server's. */
export function storedCount(scope: string = serverScope()): Promise<number> {
  if (held && held.scope === scope) return Promise.resolve(held.rows.length);
  return inTransaction<number>(
    [ISSUES],
    "readonly",
    (tx) => {
      let n = 0;
      const req = tx.objectStore(ISSUES).index("scope").count(scope);
      req.onsuccess = () => { n = req.result; };
      return () => n;
    },
    0,
  );
}

export function readMeta(scope: string = serverScope()): Promise<MirrorMeta | null> {
  return inTransaction<MirrorMeta | null>(
    [META],
    "readonly",
    (tx) => {
      let meta: MirrorMeta | null = null;
      const req = tx.objectStore(META).get(scope);
      req.onsuccess = () => { meta = (req.result as MirrorMeta) ?? null; };
      return () => meta;
    },
    null,
  );
}

export function writeMeta(meta: MirrorMeta): Promise<boolean> {
  return inTransaction<boolean>(
    [META],
    "readwrite",
    (tx) => { tx.objectStore(META).put(meta); return () => true; },
    false,
  );
}

/** Drop a tracker's mirror because the tracker itself has been forgotten — the same rule the queue
 *  and the read cache follow, for the same reason: it was a copy of that server and there is no
 *  longer a server it is a copy of. */
export function forgetScope(scope: string): Promise<boolean> {
  if (held && held.scope === scope) changed();
  return Promise.all([
    allKeys(scope).then(deleteKeys),
    inTransaction<boolean>([META], "readwrite", (tx) => { tx.objectStore(META).delete(scope); return () => true; }, false),
  ]).then(([a, b]) => a && b);
}

/** Forget the in-memory copy without touching what is stored. For tests, and for the one caller
 *  that changes the store behind this module's back. */
export function dropHeld(): void {
  changed();
}

// -----------------------------------------------------------------------------------------------
// Querying the mirror
// -----------------------------------------------------------------------------------------------
//
// Everything below is a local restatement of `Db.listIssuePage`: the same filters, the same four
// orders, the same cursor encoding. That is deliberate and it is the whole reason the feed needs
// almost no change to read from here — a mirror page and a server page are the same answer, so
// falling back is swapping who computed it, not switching to a different way of listing issues.
//
// Two honest differences, both consequences of what a list row carries:
//
//   - `q` matches titles only. The server also matches descriptions; a list row has no description
//     (that is what makes a row a row), so a local search over one cannot. A search offline is
//     therefore narrower than the same search online, never wider.
//   - Ordering by title approximates SQLite's `COLLATE NOCASE`, which folds ASCII and nothing else.

/** A stored issue against one query's filters. */
export function matches(row: IssueListRow, query: IssuePageQuery): boolean {
  if (query.state && row.state !== (query.state as IssueState)) return false;
  if (query.label != null && !row.labels.includes(query.label)) return false;
  if (query.assignee != null && !row.assignees.includes(query.assignee)) return false;
  if (query.parent === "none") {
    if (row.parent != null) return false;
  } else if (query.parent != null && row.parent !== query.parent) return false;
  const q = query.q?.trim();
  if (q && !row.title.toLowerCase().includes(q.toLowerCase())) return false;
  return true;
}

/** ASCII-folding case-insensitive comparison, which is what `COLLATE NOCASE` does. */
function nocase(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The four orders the server offers, each with the tie-break that makes it total — without one, a
 *  cursor cannot resume, because two rows comparing equal have no defined "after". */
export function sortRows(rows: IssueListRow[], sort: IssuePageQuery["sort"]): IssueListRow[] {
  const out = rows.slice();
  switch (sort ?? "updated") {
    case "title":
      out.sort((a, b) => nocase(a.title, b.title) || a.id - b.id);
      break;
    case "deadline":
      // Nulls last, then earliest first — `i.deadline IS NULL, i.deadline ASC, i.id ASC`.
      out.sort((a, b) => {
        const an = a.deadline == null ? 1 : 0;
        const bn = b.deadline == null ? 1 : 0;
        if (an !== bn) return an - bn;
        if (a.deadline != null && b.deadline != null && a.deadline !== b.deadline) {
          return a.deadline - b.deadline;
        }
        return a.id - b.id;
      });
      break;
    case "id":
      out.sort((a, b) => b.id - a.id);
      break;
    default:
      out.sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  }
  return out;
}

/** A cursor as the server writes it. Decoded here so a page fetched from the server and the page
 *  after it fetched from the mirror line up — which is what a connection dropping mid-scroll is. */
type Cursor =
  | { kind: "updated"; updatedAt: number; id: number }
  | { kind: "id"; id: number }
  | { kind: "offset"; n: number };

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts[0] === "u" && parts.length === 3) {
    const updatedAt = Number(parts[1]);
    const id = Number(parts[2]);
    return Number.isFinite(updatedAt) && Number.isFinite(id) ? { kind: "updated", updatedAt, id } : null;
  }
  if (parts[0] === "i" && parts.length === 2) {
    const id = Number(parts[1]);
    return Number.isFinite(id) ? { kind: "id", id } : null;
  }
  if (parts[0] === "o" && parts.length === 2) {
    const n = Number(parts[1]);
    return Number.isFinite(n) ? { kind: "offset", n } : null;
  }
  return null;
}

/** Drop the rows a cursor has already delivered. A cursor of the wrong shape for this order is
 *  ignored rather than trusted — the same reading the server takes, and the harmless one. */
function afterCursor(rows: IssueListRow[], sort: IssuePageQuery["sort"], cursor: Cursor | null): IssueListRow[] {
  if (!cursor) return rows;
  const order = sort ?? "updated";
  if (cursor.kind === "updated" && order === "updated") {
    return rows.filter(
      (r) => r.updatedAt < cursor.updatedAt || (r.updatedAt === cursor.updatedAt && r.id < cursor.id),
    );
  }
  if (cursor.kind === "id" && order === "id") return rows.filter((r) => r.id < cursor.id);
  if (cursor.kind === "offset" && (order === "title" || order === "deadline")) return rows.slice(cursor.n);
  return rows;
}

function encodeNext(rows: IssueListRow[], sort: IssuePageQuery["sort"], cursor: Cursor | null): string | null {
  const last = rows[rows.length - 1];
  if (!last) return null;
  switch (sort ?? "updated") {
    case "id":
      return `i.${last.id}`;
    case "title":
    case "deadline": {
      const sofar = cursor?.kind === "offset" ? cursor.n : 0;
      return `o.${sofar + rows.length}`;
    }
    default:
      return `u.${last.updatedAt}.${last.id}`;
  }
}

/**
 * One page of the mirror, shaped exactly like one page of the server.
 *
 * `total` and `stateCounts` are filled only for the first page of a query, which is what the server
 * does — and here it costs nothing either way, since the whole set was in hand to page it.
 */
export function pageOf(rows: IssueListRow[], query: IssuePageQuery, maxLimit = 500): IssuePage {
  const limit = Math.min(maxLimit, query.limit ?? 100);
  const cursor = decodeCursor(query.cursor);
  const all = sortRows(rows.filter((r) => matches(r, query)), query.sort);
  const remaining = afterCursor(all, query.sort, cursor);
  const page = remaining.slice(0, limit);
  const counts = { open: 0, closed: 0, completed: 0 };
  for (const r of all) counts[r.state] += 1;
  return {
    issues: page,
    // A short page is the end of the set — the server's rule, so the feed's loop terminates here
    // exactly as it does there.
    nextCursor: page.length < limit ? null : encodeNext(page, query.sort, cursor),
    total: cursor ? null : all.length,
    stateCounts: cursor ? null : counts,
  };
}

/**
 * Answer a list query from the device.
 *
 * Null — rather than an empty page — when there is nothing stored: "the tracker has no issues
 * matching this" and "this device has no copy of the tracker" are different answers, and only the
 * first one is something to show a reader. The caller falls back to whatever it would have done.
 */
/**
 * Everything stored that matches a query, up to `limit`.
 *
 * The read the packaged app's issue list is drawn from. It ignores the server's page ceiling on
 * purpose: that number exists to bound a *response*, and there is no response here — the rows are
 * already on the device, so handing back a page at a time would cost several passes over the same
 * array to deliver what one pass could. The bound that matters is the caller's, and it is the same
 * `FEED_CAP` the list has always been willing to hold in memory.
 */
export function mirrorList(query: IssuePageQuery, limit: number): Promise<IssuePage | null> {
  if (!mirrorAvailable) return Promise.resolve(null);
  return allRows()
    .then((rows) => (rows.length === 0 ? null : pageOf(rows, { ...query, limit }, limit)))
    .catch(() => null);
}

export function mirrorPage(query: IssuePageQuery): Promise<IssuePage | null> {
  if (!mirrorAvailable) return Promise.resolve(null);
  return allRows()
    .then((rows) => (rows.length === 0 ? null : pageOf(rows, query)))
    .catch(() => null);
}

if (mirrorAvailable) {
  onServerForgotten((scope) => { void forgetScope(scope); });
}
