import { useEffect, useRef, useState } from "react";
import type { Conflict, QueuedOp } from "../offline";
import { confirmQueued, discardConflict, discardQueued, isHeld, useOfflineState } from "../offline";

// What the top bar says about work that is not on the server yet.
//
// Silent by design: online, with an empty queue and nothing in conflict, this renders nothing at
// all. It is only there to answer the two questions an offline edit raises — "did that save?" and
// "what is still waiting?" — so it appears exactly when there is an answer worth giving.
//
// It is also the only place a conflict on an issue you cannot reach is reachable from: an issue
// deleted on the server while you were editing it locally leaves a local version behind, and
// without this list there would be nowhere to see or discard it. Held writes are the same story —
// a creation that may already have been filed has no page of its own to ask about.

/** How a queued write reads to somebody who wants to know what they are still waiting on. */
function describe(op: QueuedOp): string {
  switch (op.kind) {
    case "create": return "New issue";
    case "patch": return `#${op.issueId} · ${op.fields.join(", ") || "changed"}`;
    case "delete": return `Delete #${op.issueId}`;
    case "comment": return `Comment on #${op.issueId}`;
    case "comment-edit": return "Comment edited";
    case "comment-delete": return "Comment deleted";
  }
}

function reasonText(c: Conflict): string {
  if (c.reason === "missing") return "the issue no longer exists on the server";
  if (c.reason === "rejected") return c.message ?? "the server refused the change";
  if (c.reason === "foreign") return "it was written by a different account on this device";
  return "it was changed on the server in the meantime";
}

/** A count with its noun, so the summary line does not have to spell out the plural each time. */
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function OfflineIndicator() {
  const { offline, queue, conflicts, storageFailed } = useOfflineState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  // Close the popover on a click outside it or on Escape — the latter returning focus to the chip,
  // since a keyboard user who dismissed this has nowhere else to have been.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      chipRef.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Writes that are simply waiting for a connection, and writes waiting for the reader to say
  // whether the server already has them. Different questions, so different sections below.
  const held = queue.filter(isHeld);
  const waiting = queue.filter((op) => !isHeld(op));
  const needsAttention = held.length + conflicts.length;
  if (!offline && queue.length === 0 && conflicts.length === 0) return null;

  // Offline is the headline when it is true, because it explains the rest; the pending count rides
  // along with it. Online with a queue still in it means a drain that has not finished or could
  // not finish, which is worth saying on its own. Failing those, what is left is conflicts.
  const summarisesConflicts = !offline && queue.length === 0;
  const summary = offline
    ? `Offline${queue.length > 0 ? ` — ${count(queue.length, "change")} pending` : ""}`
    : queue.length > 0
      ? `${count(queue.length, "change")} pending`
      : count(conflicts.length, "local version conflict");

  return (
    <div className="offline-indicator" ref={ref}>
      <button
        ref={chipRef}
        className={`offline-chip${offline ? " is-offline" : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        title={offline
          ? "No connection to the server. Changes are stored on this device and sent when it comes back."
          : "Changes waiting to be sent."}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="offline-dot" aria-hidden="true" />
        {summary}
        {/* Anything needing a decision gets its own count, whatever the summary line went with —
            a conflict does not stop mattering because the connection also happens to be down, and
            the pending count alone would swallow it. Suppressed only where the summary is already
            saying exactly this number. */}
        {needsAttention > 0 && !summarisesConflicts && (
          <span className="badge failing">{needsAttention}</span>
        )}
      </button>

      {open && (
        <div className="offline-menu">
          {storageFailed && (
            <div className="offline-menu-head small error">
              This device's storage is full or blocked, so what is waiting below is only held for as
              long as this tab stays open. Send it while you can.
            </div>
          )}
          {held.length > 0 && (
            <>
              <div className="offline-menu-head small muted">
                May already have been sent — the connection dropped part-way. Sending again could
                file it twice.
              </div>
              {held.map((op) => (
                <div key={op.opId} className="offline-item">
                  <span className="small">{describe(op)}</span>
                  <span className="row">
                    <button className="ghost small" title="Send this change to the server"
                      onClick={() => confirmQueued(op.opId)}>Send</button>
                    <button className="ghost small" title="Discard this change"
                      onClick={() => discardQueued(op.opId)}>Discard</button>
                  </span>
                </div>
              ))}
            </>
          )}
          {waiting.length > 0 && (
            <>
              <div className="offline-menu-head small muted">Waiting to be sent</div>
              {waiting.map((op) => (
                <div key={op.opId} className="offline-item">
                  <span className="small">{describe(op)}</span>
                  <button className="ghost small" title="Discard this change"
                    onClick={() => discardQueued(op.opId)}>Discard</button>
                </div>
              ))}
            </>
          )}
          {conflicts.length > 0 && (
            <>
              <div className="offline-menu-head small muted">Local version conflicts</div>
              {conflicts.map((c) => (
                <div key={c.opId} className="offline-item">
                  <span className="small">
                    {c.issueId != null
                      ? <a href={`#/issues/${c.issueId}`} onClick={() => setOpen(false)}>#{c.issueId}</a>
                      : <span>New issue</span>}
                    <span className="muted"> — not applied: {reasonText(c)}</span>
                  </span>
                  <button className="ghost small" title="Discard the local version"
                    onClick={() => discardConflict(c.opId)}>Discard</button>
                </div>
              ))}
            </>
          )}
          {queue.length === 0 && conflicts.length === 0 && (
            <div className="offline-menu-head small muted">
              Nothing is waiting. Changes made from here are stored on this device until the
              connection returns.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
