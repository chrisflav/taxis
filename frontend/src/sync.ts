/**
 * Filling the mirror: walking the tracker, and knowing when to.
 *
 * `mirror.ts` holds a copy of every issue and answers list queries from it. This is the half that
 * makes the copy true — and the interesting part of it is that the tracker is walked *incrementally*
 * rather than re-read, which is what keeps "keep a whole tracker current on a phone" cheap enough
 * to do whenever a connection appears.
 *
 * ## The walk
 *
 * `GET /issues/page?sort=updated` returns issues newest-changed first, resumable by a cursor over
 * `(updated_at, id)`, and the server seeks that order through an index rather than sorting it. So:
 *
 *   - The **first** sync walks the whole thing, five hundred rows a request — ten requests to the
 *     cap, once.
 *   - Every sync after that walks the same order and **stops at the first issue older than the last
 *     sync's newest one**. Nothing beyond that point can have changed — if it had, it would have
 *     sorted above the stopping point. In a tracker where a handful of issues moved since this
 *     morning, that is one request.
 *
 * The stop is on `<` rather than `<=`, and that strictness is load-bearing twice over.
 *
 * `updated_at` has one-second resolution, so two issues touched in the same second — one of them
 * after the walk passed — would be indistinguishable to a `<=` stop. The whole second is therefore
 * re-read and re-stored; storing a row twice costs nothing, missing one costs correctness.
 *
 * It is also what makes an issue edited *while a walk is running* safe. Such an edit moves the issue
 * to a position the walk has already gone past, so that walk will never deliver it. What saves it is
 * that the server stamps `updated_at = unixepoch()`: an edit during the walk is necessarily *newer*
 * than anything the walk started with, so it lands at or above the mark this walk is about to write,
 * and the next one picks it up. That argument needs the comparison to be strict — at the mark, not
 * merely above it — and it needs the timestamp to come from the server rather than the device.
 *
 * ## What the walk cannot see
 *
 * A deletion. An issue that is gone does not appear in any page, so no incremental walk will ever
 * mention it, and the mirror would keep it for ever. What the walk *does* carry is `total` — the
 * server's count of everything visible to this reader — and comparing that against what is stored
 * is enough: if they disagree, something was removed (or the walk missed something), and a full
 * walk settles it by replacing the mirror with exactly what the server has. That check is a field
 * of a response already being fetched, so noticing a deletion costs no request at all; only acting
 * on one does.
 *
 * ## When
 *
 * "When a connection is available" is not a thing to poll for. Every trigger here is an event that
 * already happens: the app finished loading, the session resolved, connectivity came back, the
 * offline write queue drained. `offline.ts` is already the module that knows all of that — it
 * watches `online`/`offline` and updates its state from every request the app makes — so this
 * subscribes to it rather than asking the network anything.
 *
 * ## Whose issues
 *
 * Issues are visibility-filtered per actor, so a mirror is a copy of *one reader's* tracker. The
 * actor it was built for is recorded, and a different one rebuilds rather than extends it: adding
 * this reader's issues to somebody else's copy would show them rows they cannot see.
 */

import { useSyncExternalStore } from "react";
import { api } from "./api";
import { isNetworkError } from "./netError";
import { offlineSnapshot, subscribeOffline } from "./offline";
import { isConfigured, serverScope } from "./server";
import {
  MIRROR_CAP, mirrorAvailable, putRows, readMeta, retainOnly, storedCount, writeMeta,
  type MirrorMeta,
} from "./mirror";
import type { IssueListRow } from "./types";

/** Rows per request. The server's ceiling, and the right end of the trade for a background walk:
 *  nothing is waiting on any single response, so the fewer round trips the better. */
const SYNC_PAGE_SIZE = 500;

/** How long after a sync an *opportunistic* trigger is ignored. Every successful request is
 *  evidence of a connection, so without this a busy session would re-walk on each one. A genuine
 *  reconnect and an explicit request both bypass it — those are news, not evidence. */
const MIN_INTERVAL_MS = 5 * 60_000;

/** How long after the app has loaded the first sync waits. The screen is drawn from the mirror and
 *  the read cache long before this; a walk starting immediately would compete with the reads the
 *  visible page actually needs. */
const STARTUP_DELAY_MS = 2_000;

export interface SyncState {
  /** A walk is in progress. */
  syncing: boolean;
  /** How many issues are on the device for the current tracker. */
  stored: number;
  /** False when the tracker is larger than `MIRROR_CAP` and only its most recently updated issues
      are held — so the interface can say "most of it" rather than implying all of it. */
  complete: boolean;
  /** When the last successful sync finished, or null if there has never been one. */
  syncedAt: number | null;
  /** Why the last attempt failed, where it failed for a reason worth repeating. A walk that simply
      could not reach the server is not one of those: that is the offline indicator's job to say,
      once, for the whole app. */
  error: string | null;
}

const IDLE: SyncState = { syncing: false, stored: 0, complete: true, syncedAt: null, error: null };

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

/** Re-render when the mirror changes. `useSyncExternalStore` for the same reason `offline.ts` uses
 *  it: the snapshot can move between a component's render and the effect that would subscribe. */
export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSync, syncSnapshot, syncSnapshot);
}

// -----------------------------------------------------------------------------------------------
// The walk
// -----------------------------------------------------------------------------------------------

interface Walk {
  rows: IssueListRow[];
  /** The server's count of everything visible, from the first page. Null if it did not say. */
  total: number | null;
  /** True when the walk stopped because the tracker ended, rather than at `MIRROR_CAP` or at the
      incremental stopping point. */
  reachedEnd: boolean;
  /** True when `MIRROR_CAP` cut the walk short. */
  capped: boolean;
}

/**
 * Read pages of `sort=updated` until there is a reason to stop, storing each one as it arrives.
 *
 * `stopBefore` is the previous sync's newest `updatedAt`: rows strictly older than it are known to
 * be unchanged, and reaching one ends the walk. Null walks the whole tracker.
 *
 * Storing per page rather than at the end is what makes a walk that *fails* worth having started.
 * The connection on a train comes and goes; a first sync of a large tracker that got eighteen pages
 * in before the tunnel should leave eighteen pages of issues on the device, not nothing. Nothing is
 * lost by it either: the mark that would let the next walk skip this ground is written only when a
 * walk finishes, so an interrupted one is simply done again.
 */
async function walk(stopBefore: number | null, scope: string): Promise<Walk> {
  const rows: IssueListRow[] = [];
  let cursor: string | undefined;
  let total: number | null = null;
  for (;;) {
    const page = await api.issuePage({ sort: "updated", limit: SYNC_PAGE_SIZE, cursor });
    if (total == null) total = page.total;
    const kept: IssueListRow[] = [];
    let stopped = false;
    for (const row of page.issues) {
      if (stopBefore != null && row.updatedAt < stopBefore) { stopped = true; break; }
      kept.push(row);
    }
    await putRows(kept, scope);
    rows.push(...kept);
    if (stopped) return { rows, total, reachedEnd: true, capped: false };
    if (rows.length >= MIRROR_CAP) {
      return { rows: rows.slice(0, MIRROR_CAP), total, reachedEnd: false, capped: true };
    }
    // A page with nowhere to resume from is the end of the tracker. The empty-page guard is the
    // feed's: termination should not rest on the server and the client agreeing about the order.
    if (!page.nextCursor || page.issues.length === 0) return { rows, total, reachedEnd: true, capped: false };
    cursor = page.nextCursor;
  }
}

/** The newest row of a walk, which is where the next incremental one will stop. */
function highWaterOf(rows: IssueListRow[]): { updatedAt: number; id: number } | null {
  const newest = rows[0];
  return newest ? { updatedAt: newest.updatedAt, id: newest.id } : null;
}

let running: Promise<void> | null = null;
let actorId: number | null = null;
let actorKnown = false;
let lastAttempt = 0;

/**
 * Bring the mirror up to date.
 *
 * Collapses onto the walk already in progress rather than starting a second one — several triggers
 * can fire at once (the session resolves just as the queue drains just as the `online` event
 * arrives) and they all want the same thing done once.
 */
export function syncNow(force = false): Promise<void> {
  if (running) return running;
  if (!mirrorAvailable || !isConfigured()) return Promise.resolve();
  // Nobody to sync as yet. The session decides which issues are visible, so a walk before it lands
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
    // A mirror filled for somebody else is not this reader's to extend — see the note on visibility
    // in the header. Nor is one whose walk was cut short by the cap: its high-water mark describes
    // the newest slice it kept, not the tracker, so resuming from it would leave the rest for ever
    // unread.
    const reusable = meta != null && meta.actorId === actorId && meta.complete;
    const stopBefore = reusable ? meta.highUpdatedAt : null;

    let result = await walk(stopBefore, scope);
    let full = stopBefore == null;
    // The walk stored every row it read. What is left is what it did *not* read — and a full walk
    // is the only thing that can say an issue is gone rather than merely unchanged, so it is the
    // only one allowed to act on that.
    if (full) await retainOnly(result.rows.map((r) => r.id), scope);

    // And this is how a deletion gets noticed at all: the walk cannot show one, but the count the
    // server sent with the first page can disagree with what is stored — which is settled by the
    // one thing that can settle it.
    let stored = await storedCount(scope);
    if (!full && result.total != null && stored !== result.total) {
      result = await walk(null, scope);
      full = true;
      await retainOnly(result.rows.map((r) => r.id), scope);
      stored = await storedCount(scope);
    }

    const high = highWaterOf(result.rows);
    const next: MirrorMeta = {
      scope,
      actorId,
      // An incremental walk that found nothing changed has no newest row of its own; the previous
      // mark is still the right place to stop next time.
      highUpdatedAt: high?.updatedAt ?? (reusable ? meta!.highUpdatedAt : null),
      highId: high?.id ?? (reusable ? meta!.highId : null),
      count: stored,
      complete: full ? !result.capped : (meta?.complete ?? true),
      syncedAt: Date.now(),
    };
    await writeMeta(next);
    set({ syncing: false, stored, complete: next.complete, syncedAt: next.syncedAt, error: null });
  } catch (e) {
    // Nothing answered. That is the offline indicator's story to tell, once, for the whole app —
    // repeating it here would put two different words for one situation on the same screen. The
    // walk resumes from the same mark the moment there is a connection, having stored whatever
    // pages did arrive.
    if (isNetworkError(e)) {
      set({ syncing: false });
      return;
    }
    set({ syncing: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Load what is already stored, so the interface can say how much of the tracker is on the device
 *  before any walk happens — including when there is no connection for one. */
async function readStoredState(): Promise<void> {
  const scope = serverScope();
  const [meta, stored] = await Promise.all([readMeta(scope), storedCount(scope)]);
  set({ stored, complete: meta?.complete ?? true, syncedAt: meta?.syncedAt ?? null });
}

// -----------------------------------------------------------------------------------------------
// Triggers
// -----------------------------------------------------------------------------------------------

/**
 * Tell the mirror who is signed in.
 *
 * Called from `App` beside `setCurrentActor`, off the same resolved session and for the same
 * reason: what a reader may see is a property of who they are, and both the queue and the mirror
 * are wrong to act before they know. It is also the first sync's trigger — the session landing is
 * the earliest moment a walk would mirror the right issues.
 */
export function setSyncActor(id: number | null): void {
  const changed = !actorKnown || actorId !== id;
  actorId = id;
  actorKnown = true;
  if (!mirrorAvailable || !changed) return;
  void readStoredState();
  // A change of account invalidates the previous mark, so this walk will be a full one; it is worth
  // doing at once rather than waiting out the interval.
  void syncNow(true);
}

/** Run `fn` once the page has finished loading — the same rule `offline.ts` follows, so a walk
 *  cannot be counted against the load event. */
function afterPageLoad(fn: () => void): void {
  if (document.readyState === "complete") fn();
  else window.addEventListener("load", fn, { once: true });
}

if (mirrorAvailable && typeof window !== "undefined") {
  void readStoredState();

  afterPageLoad(() => { window.setTimeout(() => { void syncNow(); }, STARTUP_DELAY_MS); });

  // Everything that means "there is a connection now" is already observed by the offline store:
  // the `online` event, and every request the app makes coming back answered. A reconnect is the
  // one trigger that overrides the interval — it is the event this whole feature exists for.
  let wasOffline = offlineSnapshot().offline;
  let lastDrain = offlineSnapshot().syncCount;
  subscribeOffline(() => {
    const now = offlineSnapshot();
    const reconnected = wasOffline && !now.offline;
    const drained = now.syncCount !== lastDrain;
    wasOffline = now.offline;
    lastDrain = now.syncCount;
    // A drain means writes this reader made are now on the server; the mirror is a copy of the
    // server, so it is out of date by exactly those writes.
    if (reconnected || drained) void syncNow(true);
  });
}
