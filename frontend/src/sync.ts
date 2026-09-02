/**
 * Keeping the copy true: following the tracker rather than re-reading it.
 *
 * `mirror.ts` holds a copy of every issue and answers list queries from it. This is the half that
 * makes the copy true, and it does so by asking the server the only question worth asking —
 * *what has changed since I last asked?* — rather than reconstructing the answer.
 *
 * ## Two modes, and the join between them
 *
 * **The first read** walks `/issues/page?sort=updated` five hundred rows at a time. Nothing else
 * can fill an empty mirror. What matters is the order of two steps: the change-log cursor is taken
 * *before* the walk starts, not after it finishes, so anything that moves while the walk is running
 * is replayed by the first follow rather than falling between the two reads.
 *
 * **Every sync after that** is `GET /api/changes?since=<cursor>`: the issues that moved, each
 * carrying its current row — or null, meaning drop it. In a tracker where a handful of issues moved
 * since this morning that is one request, and unlike the walk it can say that an issue was
 * *deleted*, which is the thing no ordinary query can report. The count-reconciliation this module
 * used to do — compare a total, re-walk the tracker when it disagreed — is gone with it.
 *
 * `reset` is the server saying the cursor is older than the log it still holds. There is no
 * incremental answer to give, so the first read happens again. That is the only thing that can
 * cost a large read after the first one.
 *
 * ## When
 *
 * "When there is a connection" is not something to poll for, and now not something to ask about
 * either. `/api/changes/stream` is an open connection that says when the tracker moved, so the
 * mirror follows a live tracker without a timer anywhere. The rest of the triggers are events that
 * already happen: the app finishing its load, the session resolving, connectivity returning, the
 * offline write queue draining. `offline.ts` knows all of those, so this subscribes to it.
 *
 * ## Whose issues
 *
 * Issues are visibility-filtered per actor, so a mirror is a copy of *one reader's* tracker. The
 * actor it was built for is recorded, and a different one reads again from scratch rather than
 * extending somebody else's copy.
 */

import { useSyncExternalStore } from "react";
import { api } from "./api";
import { isNetworkError } from "./netError";
import { offlineSnapshot, subscribeOffline } from "./offline";
import { apiBase, isConfigured, serverScope } from "./server";
import {
  MIRROR_CAP, allRows, mirrorAvailable, putRows, readMeta, removeRows, retainOnly, storedCount,
  writeMeta, type MirrorMeta,
} from "./mirror";
import type { IssueListRow } from "./types";

/** Rows per request of the first read. The server's ceiling, and the right end of the trade for a
 *  background walk: nothing is waiting on any single response. */
const READ_PAGE_SIZE = 500;

/** Log rows the server resolves per follow request. Well above what an ordinary day produces, so
 *  following is one request; `more` pages the rest when it is not. */
const FOLLOW_PAGE_SIZE = 500;

/** How long after a sync an *opportunistic* trigger is ignored. A reconnect, a nudge from the
 *  stream and an explicit request all bypass it — those are news, not evidence. */
const MIN_INTERVAL_MS = 5 * 60_000;

/** How long after the app has loaded the first sync waits. The screen is drawn from the mirror
 *  long before this; a read starting immediately would compete with what the visible page needs. */
const STARTUP_DELAY_MS = 2_000;

/** How long a burst of stream nudges is allowed to collect before one sync answers all of them. */
const NUDGE_DEBOUNCE_MS = 250;

export interface SyncState {
  /** A sync is in progress. */
  syncing: boolean;
  /** How many issues are on the device for the current tracker. */
  stored: number;
  /** False when the tracker is larger than `MIRROR_CAP` and only its most recently updated issues
      are held — so the interface can say "most of it" rather than implying all of it. */
  complete: boolean;
  /** When the last successful sync finished, or null if there has never been one. */
  syncedAt: number | null;
  /** Whether the change stream is connected, i.e. whether changes arrive by themselves. */
  live: boolean;
  /** Whether what is on the device has been looked at yet. False for the moment between the app
      starting and the first read of local storage returning — which the issue list waits out
      rather than guessing, because guessing "nothing stored" costs a request per launch for a
      tracker that is sitting right there. */
  known: boolean;
  /** Why the last attempt failed, where it failed for a reason worth repeating. Being unable to
      reach the server is not one of those: that is the offline indicator's line, once, for the
      whole app. */
  error: string | null;
}

const IDLE: SyncState = {
  syncing: false, stored: 0, complete: true, syncedAt: null, live: false, known: false, error: null,
};

let state: SyncState = IDLE;
const listeners = new Set<() => void>();

function set(next: Partial<SyncState>): void {
  state = { ...state, ...next };
  listeners.forEach((f) => f());
}

export function syncSnapshot(): SyncState {
  return state;
}

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Re-render when the mirror's state changes. `useSyncExternalStore` for the reason `offline.ts`
 *  uses it: the snapshot can move between a component's render and the effect that would
 *  subscribe. */
export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, syncSnapshot, syncSnapshot);
}

// -----------------------------------------------------------------------------------------------
// Reading the tracker, and following it
// -----------------------------------------------------------------------------------------------

/**
 * Fill an empty mirror by walking the issue list, storing each page as it arrives.
 *
 * Returns the cursor to follow from — taken *before* the walk, so the join between the two modes
 * has no gap. Storing per page is what makes an interrupted read worth having started: a first
 * read that got eighteen pages in before the tunnel leaves eighteen pages on the device, and
 * because the cursor is only written once the whole thing succeeds, the next attempt simply
 * repeats it.
 */
async function readEverything(scope: string): Promise<{ cursor: number; capped: boolean }> {
  const cursor = (await api.changesHead()).upTo;
  const ids: number[] = [];
  let pageCursor: string | undefined;
  let capped = false;
  for (;;) {
    const page = await api.issuePage({ sort: "updated", limit: READ_PAGE_SIZE, cursor: pageCursor });
    const room = MIRROR_CAP - ids.length;
    const kept = page.issues.length > room ? page.issues.slice(0, room) : page.issues;
    await putRows(kept, scope);
    for (const row of kept) ids.push(row.id);
    if (ids.length >= MIRROR_CAP) { capped = true; break; }
    // A page with nowhere to resume from is the end of the tracker. The empty-page guard is the
    // feed's: termination should not rest on the server and the client agreeing about the order.
    if (!page.nextCursor || page.issues.length === 0) break;
    pageCursor = page.nextCursor;
  }
  // Whatever the walk did not see is not in the tracker any more — the one thing a full read can
  // establish that following cannot.
  await retainOnly(ids, scope);
  return { cursor, capped };
}

/**
 * Apply everything the server has recorded since `cursor`, and return where that leaves us.
 *
 * Null means the server could not answer incrementally and the tracker has to be read again.
 */
async function follow(cursor: number, scope: string): Promise<number | null> {
  let at = cursor;
  for (;;) {
    const page = await api.changes(at, FOLLOW_PAGE_SIZE);
    if (page.reset) return null;
    const upserts: IssueListRow[] = [];
    const drops: number[] = [];
    for (const change of page.changes) {
      if (change.issue) upserts.push(change.issue);
      else drops.push(change.id);
    }
    await putRows(upserts, scope);
    await removeRows(drops, scope);
    at = page.upTo;
    if (!page.more) return at;
  }
}

/**
 * Hold the mirror to `MIRROR_CAP`, keeping the most recently updated issues.
 *
 * Only the first read is bounded as it goes; following adds whatever moved, so a tracker that
 * grows past the cap would otherwise creep over it one change at a time.
 */
async function trimToCap(scope: string): Promise<boolean> {
  const rows = await allRows(scope);
  if (rows.length <= MIRROR_CAP) return false;
  const byRecency = rows.slice().sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  await removeRows(byRecency.slice(MIRROR_CAP).map((r) => r.id), scope);
  return true;
}

let running: Promise<void> | null = null;
let actorId: number | null = null;
let actorKnown = false;
let lastAttempt = 0;

/**
 * Bring the mirror up to date.
 *
 * Collapses onto the sync already in progress rather than starting a second one — several triggers
 * can fire at once (the session resolves just as the queue drains just as the stream nudges) and
 * they all want the same thing done once.
 */
export function syncNow(force = false): Promise<void> {
  if (running) return running;
  if (!mirrorAvailable || !isConfigured()) return Promise.resolve();
  // Nobody to sync as yet. The session decides which issues are visible, so a read before it lands
  // would mirror the signed-out view and then have to be thrown away.
  if (!actorKnown) return Promise.resolve();
  if (offlineSnapshot().offline) return Promise.resolve();
  if (!force && Date.now() - lastAttempt < MIN_INTERVAL_MS) return Promise.resolve();
  lastAttempt = Date.now();
  running = run().finally(() => { running = null; });
  return running;
}

async function run(): Promise<void> {
  const scope = serverScope();
  set({ syncing: true, error: null });
  try {
    const meta = await readMeta(scope);
    // A mirror filled for somebody else is not this reader's to extend — see the note on
    // visibility in the header — and one with no cursor has never been read in full.
    const followable = meta != null && meta.actorId === actorId && meta.cursor != null;

    let cursor = followable ? await follow(meta!.cursor!, scope) : null;
    let complete = meta?.complete ?? true;
    if (cursor == null) {
      const read = await readEverything(scope);
      cursor = read.cursor;
      complete = !read.capped;
    } else if (!complete) {
      // Following a capped mirror grows it; hold it to the cap rather than letting it creep.
      await trimToCap(scope);
    }

    const stored = await storedCount(scope);
    const next: MirrorMeta = {
      scope, actorId, cursor, count: stored, complete, syncedAt: Date.now(),
    };
    await writeMeta(next);
    set({ syncing: false, stored, complete, syncedAt: next.syncedAt, error: null });
  } catch (e) {
    // Nothing answered. That is the offline indicator's story to tell, once, for the whole app.
    // The cursor was not moved, so the next sync asks the same question and loses nothing.
    if (isNetworkError(e)) {
      set({ syncing: false });
      return;
    }
    set({ syncing: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Load what is already stored, so the interface can say how much of the tracker is on the device
 *  before any sync happens — including when there is no connection for one. */
async function readStoredState(): Promise<void> {
  const scope = serverScope();
  const [meta, stored] = await Promise.all([readMeta(scope), storedCount(scope)]);
  set({ stored, complete: meta?.complete ?? true, syncedAt: meta?.syncedAt ?? null, known: true });
}

// -----------------------------------------------------------------------------------------------
// Triggers
// -----------------------------------------------------------------------------------------------

/**
 * Tell the mirror who is signed in.
 *
 * Called from `App` beside `setCurrentActor`, off the same resolved session and for the same
 * reason: what a reader may see is a property of who they are, and both the queue and the mirror
 * are wrong to act before they know. It is also the first sync's trigger.
 */
export function setSyncActor(id: number | null): void {
  const changed = !actorKnown || actorId !== id;
  actorId = id;
  actorKnown = true;
  if (!mirrorAvailable || !changed) return;
  void readStoredState();
  // A change of account invalidates the previous cursor, so this sync reads the tracker again; it
  // is worth doing at once rather than waiting out the interval.
  void syncNow(true);
  openStream();
}

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;

/** One sync for a burst of nudges. Several writes in a row are one thing to catch up on. */
function nudged(): void {
  if (nudgeTimer != null) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    void syncNow(true);
  }, NUDGE_DEBOUNCE_MS);
}

let stream: EventSource | null = null;

/**
 * Open the change stream, so changes arrive instead of being asked for.
 *
 * `EventSource` cannot carry an `Authorization` header, which is exactly why the endpoint needs
 * none: the stream says only that *something* moved, and `/api/changes` — which does carry the
 * token — is what says what, filtered to this reader. It also reconnects by itself, with backoff,
 * which is the whole reason to use it rather than a socket: a phone that loses its connection in a
 * tunnel gets the stream back without this module owning a retry loop. Each reconnection syncs,
 * because whatever happened while it was down did not reach us.
 */
function openStream(): void {
  if (!mirrorAvailable || stream != null || typeof EventSource === "undefined") return;
  if (!isConfigured()) return;
  try {
    stream = new EventSource(apiBase() + "/changes/stream");
  } catch {
    return; // No stream: the triggers below still sync, just without the immediacy.
  }
  stream.addEventListener("change", nudged);
  stream.onopen = () => {
    set({ live: true });
    void syncNow(true);
  };
  stream.onerror = () => {
    // Fired on a dropped connection as well as a failed one; `EventSource` retries either way.
    set({ live: false });
  };
}

/** Run `fn` once the page has finished loading — the same rule `offline.ts` follows, so a sync
 *  cannot be counted against the load event. */
function afterPageLoad(fn: () => void): void {
  if (document.readyState === "complete") fn();
  else window.addEventListener("load", fn, { once: true });
}

if (!mirrorAvailable) {
  // Nothing is stored and nothing will be, so no view should ever wait to find out.
  set({ known: true });
}

if (mirrorAvailable && typeof window !== "undefined") {
  void readStoredState();

  afterPageLoad(() => { window.setTimeout(() => { void syncNow(); }, STARTUP_DELAY_MS); });

  // Everything that means "there is a connection now" is already observed by the offline store:
  // the `online` event, and every request the app makes coming back answered.
  let wasOffline = offlineSnapshot().offline;
  let lastDrain = offlineSnapshot().syncCount;
  subscribeOffline(() => {
    const now = offlineSnapshot();
    const reconnected = wasOffline && !now.offline;
    const drained = now.syncCount !== lastDrain;
    wasOffline = now.offline;
    lastDrain = now.syncCount;
    // A drain means writes this reader made are now on the server; the mirror is a copy of the
    // server, so it is behind by exactly those writes.
    if (reconnected || drained) void syncNow(true);
  });
}
