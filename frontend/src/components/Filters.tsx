import { memo, useMemo } from "react";
import type { Actor, IssueIndexEntry, Label } from "../types";
import type { IssueFilterState } from "../filters";
import { STATES } from "../api";
import { MultiSelect } from "./MultiSelect";
import { breadcrumbOptions } from "../breadcrumbs";

// The shared issue filter bar, used by both the list and the graph.
//
// Memoised, and its option lists built once per input array rather than per render: the parent and
// dependency pickers name every issue by its ancestor chain, which is far too much work to redo on
// every keystroke in the search box.
export const Filters = memo(function Filters({
  value,
  onChange,
  labels,
  actors,
  index = [],
}: {
  value: IssueFilterState;
  onChange: (next: IssueFilterState) => void;
  labels: Label[];
  actors: Actor[];
  index?: IssueIndexEntry[];
}) {
  const set = (patch: Partial<IssueFilterState>) => onChange({ ...value, ...patch });
  const issueOpts = useMemo(() => breadcrumbOptions(index), [index]);
  const labelOpts = useMemo(() => labels.map((l) => ({ value: l.id, label: l.name })), [labels]);
  const actorOpts = useMemo(() => actors.map((a) => ({ value: a.id, label: a.displayName })), [actors]);

  return (
    <div className="filters panel">
      <div>
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
        <label>Deadline</label>
        <select value={value.overdue ? "overdue" : ""} onChange={(e) => set({ overdue: e.target.value === "overdue" })}>
          <option value="">any</option>
          <option value="overdue">overdue</option>
        </select>
      </div>
      <div>
        <label>Labels (all)</label>
        <MultiSelect
          options={labelOpts}
          selected={value.labels}
          onChange={(labels) => set({ labels })}
          placeholder="any label"
        />
      </div>
      <div>
        <label>Assignee (any)</label>
        <MultiSelect
          options={actorOpts}
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
});
