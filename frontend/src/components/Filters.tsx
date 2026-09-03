import { memo, useMemo, useState } from "react";
import type { Actor, Label } from "../types";
import { emptyFilters, type IssueFilterState } from "../filters";
import { STATES } from "../api";
import { useNarrow } from "../viewport";
import { MultiSelect } from "./MultiSelect";
import { IssueMultiPicker } from "./IssuePicker";

// The shared issue filter bar, used by both the list and the graph.
//
// Memoised, and its option lists built once per input array rather than per render. The two issue
// pickers take no options at all any more: they search the tracker as you type, where they used to
// be handed a copy of it and filter that.
//
// On a phone it opens as a **single row** — the search box, and a button that says how many other
// filters are set. Laid out as seven stacked label-and-field pairs it stood eleven hundred pixels
// tall, which on a nine-hundred-pixel screen meant every view opened on its own filter form and
// the first issue was somewhere below it. Six of the seven are set on a small minority of visits;
// the seventh, the search box, is most of why anyone comes here, so that one stays out. Nothing
// changes on a wide screen, where the whole block fits in two rows beside the list.

/** Which filters are set, ignoring the search box — it is always visible, so it never needs
 *  counting. What the button on a phone shows, and what decides whether "Clear" is offered. */
function activeCount(v: IssueFilterState): number {
  return (v.state ? 1 : 0) + (v.overdue ? 1 : 0) + v.labels.length + v.assignees.length
    + v.parents.length + v.dependsOn.length;
}

export const Filters = memo(function Filters({
  value,
  onChange,
  labels,
  actors,
}: {
  value: IssueFilterState;
  onChange: (next: IssueFilterState) => void;
  labels: Label[];
  actors: Actor[];
}) {
  const set = (patch: Partial<IssueFilterState>) => onChange({ ...value, ...patch });
  const labelOpts = useMemo(() => labels.map((l) => ({ value: l.id, label: l.name })), [labels]);
  const actorOpts = useMemo(() => actors.map((a) => ({ value: a.id, label: a.displayName })), [actors]);
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const active = activeCount(value);
  // Closed until asked for. Filters that *are* doing something still have to be visible — arriving
  // on a view narrowed by settings you cannot see is worse than a tall form — but the count on the
  // button and the "Clear" beside it say so in one line, where reopening the whole form to say it
  // would give back the eleven hundred pixels this exists to save.
  const showFields = !narrow || open;

  return (
    <div className="filters-block panel">
      {narrow && (
        <div className="filters-bar">
          <input
            className="filters-search"
            type="search"
            placeholder="Search issues…"
            value={value.q}
            onChange={(e) => set({ q: e.target.value })}
          />
          <button
            type="button"
            className={`filters-toggle${active > 0 ? " has-active" : ""}`}
            aria-expanded={showFields}
            onClick={() => setOpen((o) => !o)}
          >
            Filters
            {active > 0 && <span className="filters-count">{active}</span>}
          </button>
        </div>
      )}
      {narrow && active > 0 && (
        <button
          type="button"
          className="ghost small filters-clear"
          onClick={() => onChange({ ...emptyFilters, q: value.q })}
        >
          Clear {active} filter{active === 1 ? "" : "s"}
        </button>
      )}
      {showFields && (
      <div className="filters">
      {!narrow && (
      <div>
        <label>Search (fuzzy)</label>
        <input placeholder="type to filter…" value={value.q} onChange={(e) => set({ q: e.target.value })} />
      </div>
      )}
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
        <IssueMultiPicker
          selected={value.parents}
          onChange={(parents) => set({ parents })}
          placeholder="any parent"
        />
      </div>
      <div>
        <label>Depends on (all)</label>
        <IssueMultiPicker
          selected={value.dependsOn}
          onChange={(dependsOn) => set({ dependsOn })}
          placeholder="no requirement"
        />
      </div>
      </div>
      )}
    </div>
  );
});
