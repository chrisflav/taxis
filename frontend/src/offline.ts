import { useEffect, useState } from "react";
import { invalidateCache, peekCached, writeCached } from "./cache";
import type { Issue, IssueDetail } from "./types";

// Offline editing: where a write goes when there is no server to send it to.
//
// Reading the tracker without a connection is already survivable — the stale-while-revalidate cache
// in `cache.ts` paints the last response it saw and the failed revalidation is invisible. Writing
// was not: every edit made on a train went to `fetch`, failed, and was gone. So mutating requests
// that cannot be sent are held here instead, in the order they were made, and sent when the
// connection comes back.
//
// Three decisions worth knowing about:
//
//   Connectivity is observed, never probed. `navigator.onLine` plus the `online`/`offline` events
//   say what the browser knows, and a *mutating* request that fails at the network level (a `fetch`
//   rejection, i.e. nothing answered) says what the browser did not. Nothing here polls or pings:
//   a page load costs exactly the requests the page needs, which is a property the benchmark in
//   `bench/` enforces, and "am I online?" is not one of them. Recovery therefore rides on events
//   that already happen — the `online` event, and any request that succeeds afterwards.
//
//   The queue is persisted, the read cache is not. These are different things and the difference
//   matters: a cached response is a copy of something the server still has, so throwing it away on
//   reload costs a request. A queued write is the only copy in existence, so throwing it away
//   costs the user their work. `localStorage` is used because it is synchronous, universally
//   available and needs no schema; every access is wrapped, since it throws in private-mode and
//   storage-blocked contexts. IndexedDB is the upgrade path if queues ever get big enough that a
//   synchronous write on the main thread matters — the shape below (an array of self-contained
//   records) ports to it unchanged.
//
//   Collisions are settled the way issue #420 asks: remote wins. Before a queued patch is applied
//   the issue's current `updatedAt` is compared against the one the client last saw. If they
//   differ, somebody else edited the issue in the meantime, the patch is *not* sent, and the local
//   body is set aside as a conflict for the reader to look at and discard. No field-level merging
//   is attempted — two people editing the same issue is a conversation to have, not an algorithm
//   to run.

const BASE = "/api";

/** Where the queue lives between sessions. Versioned in the name so a future change of shape can
    ignore what an older build wrote rather than trying to understand it. */
const QUEUE_KEY = "taxis:offline-queue:v1";
const CONFLICT_KEY = "taxis:offline-conflicts:v1";

/** What kind of interaction a queued request is. Kept alongside the method and path because the
    replay treats them differently — only a patch has a version to check, only a delete is content
    with a 404 — and because the interface words them differently to the reader. */
export type OpKind = "create" | "patch" | "delete" | "comment" | "comment-edit" | "comment-delete";

/** One write, held until it can be sent. Self-contained: the replay needs nothing but this. */
export interface QueuedOp {
  /** Identifies this op locally. Not an id anything on the server will ever have. */
  opId: string;
  kind: OpKind;
  method: string;
  /** The API path, without the `/api` prefix — the same string `api.ts` would have fetched. */
  path: string;
  /** The request body exactly as it would have been sent, or null for a body-less write. */
  body: string | null;
  /** The issue this op is about, where it is about one. Null for a creation (no id yet) and for a
      comment edit or deletion (whose path names the comment, not its issue). */
  issueId: number | null;
  /** The field names the body sets — what the interface marks as pending. */
  fields: string[];
  /** For a patch: the `updatedAt` the client last saw for the issue, which is what a collision is
      detected against. Null when no copy of the issue was in hand at the time, in which case the
      patch is applied unconditionally. */
  baseUpdatedAt: number | null;
  /** Cache prefixes to drop once the server has this write, so views read the result. */
  invalidate: string[];
  queuedAt: number;
}

/** Why a queued write was not applied. All three end up under the same "local version conflict"
    label, because from the reader's side they are the same situation: the local version was not
    applied and is being kept. */
export type ConflictReason = "stale" | "missing" | "rejected";

/** A local version that was never applied, kept so it is not silently lost. */
export interface Conflict {
  opId: string;
  /** The issue the local version belongs to, where there is one. Null for a creation the server
      refused: there is no issue to label, so the top bar's list is the only place it appears —
      which is still better than dropping what somebody wrote. */
  issueId: number | null;
  reason: ConflictReason;
  /** The local body, decoded, so the interface can show what was going to be written. */
  local: Record<string, unknown>;
  fields: string[];
  baseUpdatedAt: number | null;
  /** The server's `updatedAt` when the collision was found; null when the issue was gone. */
  remoteUpdatedAt: number | null;
  /** What the server said, for a `rejected` conflict. */
  message: string | null;
  detectedAt: number;
}

/** What a component sees. Every field is replaced rather than mutated, so a memo comparing the
    snapshot by identity is comparing the right thing. */
export interface OfflineState {
  /** True when writes are being queued rather than sent. */
  offline: boolean;
  queue: QueuedOp[];
  conflicts: Conflict[];
  /** Incremented each time a drain changed what the server holds *or* found that somebody else
      had. Views that are already mounted watch this to re-read what they are showing: their data
      predates the sync either way. A collision counts precisely because it means the issue on
      screen is the one thing it cannot be — current. */
  syncCount: number;
}

/** The stand-in an intercepted write resolves with. A caller that only wanted the write to happen
    can ignore it; one that uses the response — the create form wants the new issue's id — checks
    for it with `isQueuedLocally` and takes the other path. */
export interface QueuedResult {
  offlineQueued: true;
  opId: string;
  /** Negative, and therefore never an id the server would hand out. Present only so that a caller
      reading `.id` off the result gets something obviously not real rather than `undefined`. */
  id: number;
}

export function isQueuedLocally(value: unknown): value is QueuedResult {
  return typeof value === "object" && value != null && (value as QueuedResult).offlineQueued === true;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

let queue: QueuedOp[] = [];
let conflicts: Conflict[] = [];
let syncCount = 0;
/** What the browser says. */
let browserOnline = typeof navigator === "undefined" || navigator.onLine !== false;
/** What the last mutating request found out: set when one failed at the network level while the
    browser still claimed to be online, which is what a server that is down looks like from here.
    Unlike `browserOnline` this never stops a request being *attempted* — a soft flag that blocked
    attempts would need something to unblock it, and the only honest something is a poll. */
let unreachable = false;
let seq = 0;

const listeners = new Set<() => void>();
let snapshot: OfflineState = { offline: false, queue, conflicts, syncCount };

function rebuild(): void {
  snapshot = { offline: isOffline(), queue, conflicts, syncCount };
}

function notify(): void {
  rebuild();
  listeners.forEach((f) => f());
}

/** True when a write should go straight to the queue without being attempted. */
export function isOffline(): boolean {
  return !browserOnline || unreachable;
}

export function offlineSnapshot(): OfflineState {
  return snapshot;
}

export function subscribeOffline(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Re-render this component when connectivity, the queue or the conflict set changes. */
export function useOfflineState(): OfflineState {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    // The snapshot can have moved between this component's render and this effect running.
    setState(offlineSnapshot());
    return subscribeOffline(() => setState(offlineSnapshot()));
  }, []);
  return state;
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

const OP_KINDS = new Set<string>([
  "create", "patch", "delete", "comment", "comment-edit", "comment-delete",
]);

/** Whether a value read back from storage is a queue entry this build understands. Anything that
    is not — written by an older build, or corrupted — is dropped rather than replayed, because a
    malformed op is a request nobody can predict the effect of. */
function isQueuedOp(v: unknown): v is QueuedOp {
  const o = v as QueuedOp;
  return typeof o === "object" && o != null
    && typeof o.opId === "string" && OP_KINDS.has(o.kind)
    && typeof o.method === "string" && typeof o.path === "string"
    && (o.body === null || typeof o.body === "string")
    && (o.issueId === null || typeof o.issueId === "number")
    && Array.isArray(o.fields) && Array.isArray(o.invalidate);
}

function isConflict(v: unknown): v is Conflict {
  const o = v as Conflict;
  return typeof o === "object" && o != null
    && typeof o.opId === "string" && (o.issueId === null || typeof o.issueId === "number")
    && typeof o.local === "object" && o.local != null && Array.isArray(o.fields);
}

function readStored<T>(key: string, valid: (v: unknown) => v is T): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    // Unreadable, unparseable or blocked. An empty queue is the safe reading: it loses nothing
    // that this session put there, and never replays something whose shape is unknown.
    return [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    localStorage.setItem(CONFLICT_KEY, JSON.stringify(conflicts));
  } catch {
    // Storage full, or blocked. The queue still works for this session; it just will not survive a
    // reload. Failing the user's edit over it would be a worse trade.
  }
}

// ---------------------------------------------------------------------------------------------
// Classifying a write
// ---------------------------------------------------------------------------------------------

const ISSUE_PATH = /^\/issues\/(\d+)$/;
const ISSUE_COMMENTS_PATH = /^\/issues\/(\d+)\/comments$/;
const COMMENT_PATH = /^\/comments\/(\d+)$/;

/**
 * Which writes the queue accepts.
 *
 * Deliberately a list and not "anything with a method". Queueing a sign-in, a token creation or an
 * import would be queueing a request whose *answer* is the point — the caller wants the token, the
 * new session, the count of what was imported — and resolving it with a stand-in would be lying to
 * it. What is here is the set issue #420 names: issues created, modified and deleted, and the
 * comments people write on them. Everything else keeps failing offline exactly as it does today.
 */
function classify(method: string, path: string): { kind: OpKind; issueId: number | null } | null {
  if (method === "POST" && path === "/issues") return { kind: "create", issueId: null };
  const issue = ISSUE_PATH.exec(path);
  if (issue && method === "PATCH") return { kind: "patch", issueId: Number(issue[1]) };
  if (issue && method === "DELETE") return { kind: "delete", issueId: Number(issue[1]) };
  const comments = ISSUE_COMMENTS_PATH.exec(path);
  if (comments && method === "POST") return { kind: "comment", issueId: Number(comments[1]) };
  const comment = COMMENT_PATH.exec(path);
  // A comment's own path names the comment, not the issue it is on, so these two are queued and
  // replayed but cannot be attributed to an issue: they show in the global pending count and not
  // as a pending marker on a page.
  if (comment && method === "PATCH") return { kind: "comment-edit", issueId: null };
  if (comment && method === "DELETE") return { kind: "comment-delete", issueId: null };
  return null;
}

function parseBody(body: string | null): Record<string, unknown> | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed != null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The fields of an issue a queued body can be shown as pending against, and the ones the local
    overlay will copy onto a cached issue. A body key outside this set is still sent when the queue
    drains; it is simply not something this interface knows how to draw. */
const ISSUE_FIELDS = new Set([
  "title", "description", "goal", "state", "locked",
  "labels", "parent", "dependencies", "assignees", "visibility", "deadline",
]);

// ---------------------------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------------------------

/** The `updatedAt` this client last saw for an issue, taken from the cached copy of its detail
    response — the page you are editing from is the page that read it. When nothing is cached (an
    edit made from a list, say) there is no baseline, and the patch will be applied without a
    version check rather than being held back on a suspicion. */
function seenUpdatedAt(path: string): number | null {
  // A patch's path is the issue's own read path, which is what `cache.ts` keys the detail on.
  const cached = peekCached<IssueDetail>(path);
  return cached?.issue?.updatedAt ?? null;
}

/**
 * Take over a mutating request that cannot be sent.
 *
 * Returns the value the caller should resolve with, or null when this request is not one the queue
 * accepts — in which case the caller carries on failing exactly as it did before this module
 * existed.
 */
export function queueWrite(method: string, path: string, body: unknown): QueuedResult | null {
  const what = classify(method, path);
  if (!what) return null;
  const text = typeof body === "string" ? body : null;
  const fields = Object.keys(parseBody(text) ?? {});
  const op: QueuedOp = {
    opId: `op-${Date.now().toString(36)}-${++seq}`,
    kind: what.kind,
    method,
    path,
    body: text,
    issueId: what.issueId,
    fields,
    baseUpdatedAt: what.kind === "patch" ? seenUpdatedAt(path) : null,
    // The same prefixes `api.ts` drops after a write that succeeded: any issue read is affected by
    // any issue write, and the graph draws issues.
    invalidate: what.kind.startsWith("comment") ? ["/issues"] : ["/issues", "/graph"],
    queuedAt: Date.now(),
  };
  queue = [...queue, op];
  persist();
  // So a reader who navigates away and back — while still offline, where nothing can be re-read —
  // finds their own edit rather than the value it replaced.
  applyToCachedIssue(op);
  notify();
  return { offlineQueued: true, opId: op.opId, id: -seq };
}

/** Note that a request failed with nothing answering. Only ever called for a mutating request: a
    read failing is a read failing, and the browser may simply have refused one cross-origin. */
export function noteUnreachable(): void {
  if (unreachable) return;
  unreachable = true;
  notify();
}

/** Note that the server answered — whatever it said. Proof of a connection, and the cheapest one
    there is, since it is a request the application was making anyway. */
export function noteReachable(): void {
  if (!unreachable) {
    // Still worth draining: an `online` event can arrive before the network is actually usable, so
    // a request that has just succeeded is a better moment to retry than the event was.
    if (queue.length > 0) void drainQueue();
    return;
  }
  unreachable = false;
  notify();
  if (queue.length > 0) void drainQueue();
}

/** Whether a thrown value is a failure to reach the network at all, as opposed to the server
    answering with something the caller does not like. `fetch` rejects with a `TypeError` when the
    request could not be made; an HTTP 403 is not a rejection and must keep surfacing as an error. */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

// ---------------------------------------------------------------------------------------------
// The local view of a queued write
// ---------------------------------------------------------------------------------------------

/** `issue` with every queued patch to it applied, so the reader sees what they typed instead of
    the value it is replacing. Returns the argument unchanged when nothing is queued for it, which
    keeps identity stable for memoised children. */
export function applyPendingEdits(issue: Issue, ops: QueuedOp[] = queue): Issue {
  let out = issue;
  for (const op of ops) {
    if (op.kind !== "patch" || op.issueId !== issue.id) continue;
    const body = parseBody(op.body);
    if (!body) continue;
    for (const [key, value] of Object.entries(body)) {
      if (!ISSUE_FIELDS.has(key)) continue;
      if (out === issue) out = { ...issue };
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/** Fold a queued patch into the cached detail response for its issue.
 *
 *  Only the issue itself is rewritten, not the label and actor objects the response carries
 *  alongside it — the page derives those from the ids when the field is pending, and inventing a
 *  `Label` here would be inventing data the server never sent. `updatedAt` is deliberately left
 *  alone: it is the conflict baseline, and it belongs to the server's version of the issue. */
function applyToCachedIssue(op: QueuedOp): void {
  if (op.kind !== "patch") return;
  const cached = peekCached<IssueDetail>(op.path);
  if (!cached?.issue) return;
  const issue = applyPendingEdits(cached.issue, [op]);
  if (issue !== cached.issue) writeCached(op.path, { ...cached, issue });
}

/** A queued op's body, decoded — what the interface shows when it has to display a write that has
    not happened yet (the text of an unposted comment, say). Empty when there was no body. */
export function queuedBody(op: QueuedOp): Record<string, unknown> {
  return parseBody(op.body) ?? {};
}

/** Which fields of an issue have a write waiting on the queue. */
export function pendingFieldsFor(issueId: number, ops: QueuedOp[] = queue): Set<string> {
  const out = new Set<string>();
  for (const op of ops) {
    if (op.issueId !== issueId || op.kind !== "patch") continue;
    op.fields.forEach((f) => out.add(f));
  }
  return out;
}

/** Whether this issue has a queued deletion — it is still on screen, but on its way out. */
export function pendingDeleteFor(issueId: number, ops: QueuedOp[] = queue): boolean {
  return ops.some((op) => op.kind === "delete" && op.issueId === issueId);
}

/** Comments written on this issue that have not been posted yet. */
export function pendingCommentsFor(issueId: number, ops: QueuedOp[] = queue): QueuedOp[] {
  return ops.filter((op) => op.kind === "comment" && op.issueId === issueId);
}

export function conflictFor(issueId: number, cs: Conflict[] = conflicts): Conflict | undefined {
  return cs.find((c) => c.issueId === issueId);
}

/** Throw away a local version that was kept aside. The remote version is already what is shown, so
    there is nothing to put back. */
export function discardConflict(opId: string): void {
  const next = conflicts.filter((c) => c.opId !== opId);
  if (next.length === conflicts.length) return;
  conflicts = next;
  persist();
  notify();
}

/** Drop a queued write before it is sent — for a reader who decides they did not want it after
    all, and for anything the interface can no longer make sense of. */
export function discardQueued(opId: string): void {
  const dropped = queue.find((op) => op.opId === opId);
  const next = queue.filter((op) => op.opId !== opId);
  if (next.length === queue.length) return;
  queue = next;
  persist();
  // What was shown as pending came from the queue, so dropping the op is enough to un-show it —
  // except in the cached copy this op was folded into, which has to go. Only that one key: the
  // rest of the cache is all that can be read while offline.
  if (dropped?.kind === "patch") invalidateCache(dropped.path);
  notify();
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

interface Sent {
  status: number;
  ok: boolean;
  data: unknown;
}

/** Send a request the way `api.ts` sends one.
 *
 *  Replay does not go back through `api.ts` on purpose, and not only to avoid the import cycle:
 *  a write replayed through the same function that queued it would meet the very check that
 *  queued it. This is the one place in the application allowed to talk to the network directly.
 *
 *  Rejects only when nothing answered; an HTTP status is a result, and the caller decides. */
async function send(method: string, path: string, body: string | null): Promise<Sent> {
  const res = await fetch(BASE + path, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...(body == null ? {} : { body }),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

function errorMessage(data: unknown): string | null {
  const e = (data as { error?: unknown } | null)?.error;
  return typeof e === "string" ? e : null;
}

function updatedAtOf(data: unknown): number | null {
  const direct = (data as { updatedAt?: unknown } | null)?.updatedAt;
  if (typeof direct === "number") return direct;
  const nested = (data as { issue?: { updatedAt?: unknown } } | null)?.issue?.updatedAt;
  return typeof nested === "number" ? nested : null;
}

/** What became of one queued write. `halt` stops the drain with the queue intact — the server is
    there but in no state to be written to (it is failing, or nobody is signed in any more), and
    burning through the rest of the queue against it would turn one problem into a queue of them. */
type Outcome = "applied" | "conflict" | "halt";

function recordConflict(op: QueuedOp, reason: ConflictReason, remoteUpdatedAt: number | null, message: string | null): void {
  // One conflict per issue, and every unapplied edit to that issue folded into it — because what
  // is being kept aside is "the local version of this issue", singular, which is how issue #420
  // words it and how a reader thinks about it. The second and third patch to collide are more of
  // the same local version, not separate ones, so their fields are merged in (later writes win,
  // exactly as they would have if they had gone through in order) rather than replacing what came
  // before them, which would quietly lose the earlier edit.
  const previous = op.issueId == null
    ? undefined
    : conflicts.find((c) => c.issueId === op.issueId);
  const entry: Conflict = {
    opId: op.opId,
    issueId: op.issueId,
    reason,
    local: { ...(previous?.local ?? {}), ...(parseBody(op.body) ?? {}) },
    fields: [...new Set([...(previous?.fields ?? []), ...op.fields])],
    baseUpdatedAt: previous?.baseUpdatedAt ?? op.baseUpdatedAt,
    remoteUpdatedAt,
    message,
    detectedAt: Date.now(),
  };
  conflicts = [...conflicts.filter((c) => c !== previous), entry];
}

/**
 * Send one queued write, checking first that it still applies.
 *
 * `applied` holds the `updatedAt` of every issue this drain has already written, so a second patch
 * to the same issue is checked against what the *first* one produced rather than against a
 * baseline the drain itself has just invalidated.
 */
async function replay(op: QueuedOp, applied: Map<number, number>): Promise<Outcome> {
  const baseline = op.issueId != null && applied.has(op.issueId)
    ? applied.get(op.issueId)!
    : op.baseUpdatedAt;

  if (op.kind === "patch" && op.issueId != null && baseline != null) {
    const current = await send("GET", op.path, null);
    if (current.status === 401 || current.status === 403) return "halt";
    if (current.status >= 500) return "halt";
    if (current.status === 404) {
      recordConflict(op, "missing", null, null);
      return "conflict";
    }
    const remote = updatedAtOf(current.data);
    if (remote != null && remote !== baseline) {
      // The rule from issue #420: do not apply the change, leave the remote version in place, and
      // keep the local one under a conflict label.
      recordConflict(op, "stale", remote, null);
      return "conflict";
    }
  }

  const res = await send(op.method, op.path, op.body);
  // A delete whose target is already gone got what it wanted.
  if (op.kind === "delete" && res.status === 404) return "applied";
  if (res.status === 401 || res.status === 403 || res.status >= 500) return "halt";
  if (!res.ok) {
    // The server answered and refused: a lock, a check that is not passing, a validation rule.
    // Retrying would refuse identically for as long as the queue exists, so the write is set aside
    // with what the server said rather than looping or vanishing.
    if (res.status === 404) recordConflict(op, "missing", null, null);
    else recordConflict(op, "rejected", null, errorMessage(res.data) ?? `HTTP ${res.status}`);
    return "conflict";
  }
  if (op.issueId != null) {
    const now = updatedAtOf(res.data);
    if (now != null) applied.set(op.issueId, now);
  }
  return "applied";
}

/** Guards against two drains running at once — a reconnect while a drain is still in flight, which
    is exactly what a flapping connection produces. */
let draining = false;

/** When a drain last stopped because the server was reachable but in no state to be written to.
 *  Every successful response is a reason to try the queue again, which is what makes recovery cost
 *  no polling — but a queue stuck behind an expired session would then cost an extra request per
 *  response for the life of the tab. So a halt buys quiet, and a genuine reconnect cancels it. */
let haltedAt = 0;
const HALT_BACKOFF_MS = 60_000;

/**
 * Send the queue, in order, one at a time.
 *
 * Sequential on purpose: the ops were made in an order that meant something (rename, then close;
 * comment, then delete the comment), and a version check is only meaningful against a server that
 * is not simultaneously being written to by the op behind it.
 */
export async function drainQueue(): Promise<void> {
  if (draining || !browserOnline || queue.length === 0) return;
  if (haltedAt !== 0 && Date.now() - haltedAt < HALT_BACKOFF_MS) return;
  draining = true;
  const appliedAt = new Map<number, number>();
  let applied = 0;
  let conflicted = false;
  try {
    // Re-read `queue` each time round: an op enqueued while the drain is running belongs to it.
    while (queue.length > 0) {
      const op = queue[0];
      let outcome: Outcome;
      try {
        outcome = await replay(op, appliedAt);
      } catch (e) {
        // Nothing answered. Stop, keep everything, and wait for the next piece of evidence that
        // there is a server to talk to.
        if (isNetworkError(e)) noteUnreachable();
        return;
      }
      if (outcome === "halt") {
        haltedAt = Date.now();
        return;
      }
      if (outcome === "conflict") conflicted = true;
      else applied += 1;
      queue = queue.filter((q) => q.opId !== op.opId);
      op.invalidate.forEach((prefix) => invalidateCache(prefix));
      persist();
      notify();
    }
    // The queue emptied, so the server is plainly reachable and whatever stopped a previous drain
    // has passed.
    unreachable = false;
    haltedAt = 0;
  } finally {
    draining = false;
    if (applied > 0 || conflicted) {
      // Views already on screen are showing what they read before any of this: `invalidateCache`
      // makes the *next* read truthful, and this is what asks them to make one.
      //
      // A conflict counts as much as an applied write. Issue #420 asks for the interface to be
      // updated to the remote version when a collision is found, and a collision means precisely
      // that the copy on screen is out of date — dropping it from the cache is not enough, because
      // nothing would go and read it again until the reader happened to navigate.
      syncCount += 1;
      persist();
    }
    notify();
  }
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

/** Run `fn` once the page has finished loading, and not before — the same rule the markdown parser
    follows, and for the same reason: a request in flight when the page would otherwise fire `load`
    is counted against the load event in Firefox. */
function afterPageLoad(fn: () => void): void {
  if (document.readyState === "complete") fn();
  else window.addEventListener("load", fn, { once: true });
}

if (typeof window !== "undefined") {
  queue = readStored(QUEUE_KEY, isQueuedOp);
  conflicts = readStored(CONFLICT_KEY, isConflict);
  rebuild();

  window.addEventListener("online", () => {
    browserOnline = true;
    // The browser saying the network is back is a reason to try, not proof that it worked. If the
    // first replayed request fails the drain puts `unreachable` straight back.
    unreachable = false;
    // A reconnect is new information, so it overrides the quiet period after a halt.
    haltedAt = 0;
    notify();
    void drainQueue();
  });
  window.addEventListener("offline", () => {
    browserOnline = false;
    notify();
  });

  // A queue left over from a previous session — the tab was closed with edits still in it — is
  // sent once the page has loaded. Note what this does *not* do: with an empty queue, which is
  // every ordinary page load, it makes no request at all. The offline layer costs a page load
  // nothing, which is what `bench/budgets.json` is there to keep true.
  if (queue.length > 0) afterPageLoad(() => { void drainQueue(); });
}
