import { useEffect, useRef, useState } from "react";
import type { Conflict, QueuedOp } from "../offline";
import { discardConflict, discardQueued, useOfflineState } from "../offline";

// What the top bar says about work that is not on the server yet.
//
// Silent by design: online, with an empty queue and nothing in conflict, this renders nothing at
// all. It is only there to answer the two questions an offline edit raises — "did that save?" and
// "what is still waiting?" — so it appears exactly when there is an answer worth giving.
//
// It is also the only place a conflict on an issue you cannot reach is reachable from: an issue
// deleted on the server while you were editing it locally leaves a local version behind, and
// without this list there would be nowhere to see or discard it.

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
  return "it was changed on the server in the meantime";
}

export function OfflineIndicator() {
  const { offline, queue, conflicts } = useOfflineState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover when clicking anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pending = queue.length;
  if (!offline && pending === 0 && conflicts.length === 0) return null;

  // Offline is the headline when it is true, because it explains the rest. Online with a queue
  // still in it means a drain that has not finished or could not finish, which is worth saying.
  const summary = offline
    ? `Offline${pending > 0 ? ` — ${pending} change${pending === 1 ? "" : "s"} pending` : ""}`
    : pending > 0
      ? `${pending} change${pending === 1 ? "" : "s"} pending`
      : `${conflicts.length} local version conflict${conflicts.length === 1 ? "" : "s"}`;

  return (
    <div className="offline-indicator" ref={ref}>
      <button
        className={`offline-chip${offline ? " is-offline" : ""}`}
        aria-expanded={open}
        title={offline
          ? "No connection to the server. Changes are stored on this device and sent when it comes back."
          : "Changes waiting to be sent."}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="offline-dot" aria-hidden="true" />
        {summary}
        {conflicts.length > 0 && !offline && pending > 0 && (
          <span className="badge failing">{conflicts.length}</span>
        )}
      </button>

      {open && (
        <div className="offline-menu">
          {pending > 0 && (
            <>
              <div className="offline-menu-head small muted">Waiting to be sent</div>
              {queue.map((op) => (
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
          {pending === 0 && conflicts.length === 0 && (
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
