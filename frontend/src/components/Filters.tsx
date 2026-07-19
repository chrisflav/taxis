import type { Actor, Issue, Label } from "../types";
import type { IssueFilterState } from "../filters";
import { STATES } from "../api";
import { MultiSelect } from "./MultiSelect";
import { breadcrumbLabel } from "../breadcrumbs";

// The shared issue filter bar, used by both the list and the graph.
export function Filters({
  value,
  onChange,
  labels,
  actors,
  issues = [],
}: {
  value: IssueFilterState;
  onChange: (next: IssueFilterState) => void;
  labels: Label[];
  actors: Actor[];
  issues?: Issue[];
}) {
  const set = (patch: Partial<IssueFilterState>) => onChange({ ...value, ...patch });
  const issueOpts = issues.map((i) => ({ value: i.id, label: breadcrumbLabel(i, issues) }));

  return (
    <div className="filters panel">
      <div style={{ flex: 2 }}>
        <label>Search (fuzzy)</label>
        <input placeholder="type to filter…" value={value.q} onChange={(e) => set({ q: e.target.value })} />
      </div>
      <div>
        <label>State</label>
        <select value={value.state} onChange={(e) => set({ state: e.target.value })}>
          <option value="">any</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div>
        <label>Labels (all)</label>
        <MultiSelect
          options={labels.map((l) => ({ value: l.id, label: l.name }))}
          selected={value.labels}
          onChange={(labels) => set({ labels })}
          placeholder="any label"
        />
      </div>
      <div>
        <label>Assignee (any)</label>
        <MultiSelect
          options={actors.map((a) => ({ value: a.id, label: a.displayName }))}
          selected={value.assignees}
          onChange={(assignees) => set({ assignees })}
          placeholder="anyone"
        />
      </div>
      <div>
        <label>Parent (any)</label>
        <MultiSelect
          options={issueOpts}
          selected={value.parents}
          onChange={(parents) => set({ parents })}
          placeholder="any parent"
        />
      </div>
      <div>
        <label>Depends on (all)</label>
        <MultiSelect
          options={issueOpts}
          selected={value.dependsOn}
          onChange={(dependsOn) => set({ dependsOn })}
          placeholder="no requirement"
        />
      </div>
    </div>
  );
}
