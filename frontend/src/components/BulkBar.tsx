import { useCallback, useState } from "react";
import type { Actor, IssueListRow, Label } from "../types";
import { api } from "../api";
import { isQueuedLocally } from "../offline";
import { MultiSelect } from "./MultiSelect";
import { IssueSelectPicker } from "./IssuePicker";

type BulkAction = "add-labels" | "remove-labels" | "set-parent" | "assign";

// A toolbar that appears once at least one issue is checked in the list, applying one bulk
// change (labels, parent, or assignees) to every selected issue at once.
export function BulkBar({
  selectedIds, issues, labels, actors, onClear, onApplied,
}: {
  selectedIds: Set<number>;
  /** The rows currently listed — the source of each selected issue's existing labels/assignees. */
  issues: IssueListRow[];
  labels: Label[];
  actors: Actor[];
  onClear: () => void;
  onApplied: () => void;
}) {
  const [action, setAction] = useState<BulkAction>("add-labels");
  const [labelSel, setLabelSel] = useState<number[]>([]);
  const [parentSel, setParentSel] = useState<number | null>(null);
  const [assigneeSel, setAssigneeSel] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // How many of the last apply's patches only reached the offline queue. Without this the bar
  // clears its selection and the rows below keep their old values, which reads as "nothing
  // happened" rather than "stored, not sent" — the list draws no pending markers of its own.
  const [queued, setQueued] = useState(0);

  const selectedIssues = issues.filter((i) => selectedIds.has(i.id));
  // The parent picker searches the whole tracker — a parent may well be outside the current
  // filter — but must not offer one of the issues being moved as its own parent.
  const excludeSelected = useCallback((id: number) => selectedIds.has(id), [selectedIds]);

  const apply = () => {
    setBusy(true);
    setError(null);
    setQueued(0);
    const patches = selectedIssues.map((issue) => {
      switch (action) {
        case "add-labels":
          return api.updateIssue(issue.id, { labels: [...new Set([...issue.labels, ...labelSel])] });
        case "remove-labels":
          return api.updateIssue(issue.id, { labels: issue.labels.filter((l) => !labelSel.includes(l)) });
        case "set-parent":
          return api.updateIssue(issue.id, { parent: parentSel });
        case "assign":
          return api.updateIssue(issue.id, { assignees: [...new Set([...issue.assignees, ...assigneeSel])] });
      }
    });
    Promise.all(patches)
      .then((results) => {
        const stored = results.filter(isQueuedLocally).length;
        setQueued(stored);
        onApplied();
        // Keep the selection when nothing was actually sent: the rows still show their old values,
        // so clearing would leave the reader with no sign of which issues the change is waiting on.
        if (stored === 0) onClear();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel bulk-bar row">
      <strong>{selectedIds.size} selected</strong>
      <select value={action} onChange={(e) => setAction(e.target.value as BulkAction)} style={{ width: "auto" }}>
        <option value="add-labels">Add labels</option>
        <option value="remove-labels">Remove labels</option>
        <option value="set-parent">Set parent</option>
        <option value="assign">Assign actors</option>
      </select>
      <div style={{ minWidth: 220, flex: 1 }}>
        {(action === "add-labels" || action === "remove-labels") && (
          <MultiSelect options={labels.map((l) => ({ value: l.id, label: l.name }))} selected={labelSel} onChange={setLabelSel} placeholder="Choose labels…" />
        )}
        {action === "set-parent" && <IssueSelectPicker value={parentSel} onChange={setParentSel} exclude={excludeSelected} />}
        {action === "assign" && (
          <MultiSelect options={actors.map((a) => ({ value: a.id, label: a.displayName }))} selected={assigneeSel} onChange={setAssigneeSel} placeholder="Choose actors…" />
        )}
      </div>
      {error && <span className="error small">{error}</span>}
      {queued > 0 && (
        <span className="small muted" title="Stored on this device and sent when the connection returns. The rows below still show what the server holds.">
          Stored on this device — {queued} {queued === 1 ? "issue" : "issues"} not sent yet
        </span>
      )}
      <button className="primary" onClick={apply} disabled={busy}>Apply</button>
      <button onClick={onClear} disabled={busy}>Clear selection</button>
    </div>
  );
}
