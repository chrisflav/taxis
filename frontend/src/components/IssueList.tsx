import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { LockedMark } from "./Icon";
import type { Actor, Issue, IssueIndexEntry, Label } from "../types";
import { api, paths, type IssueFilters } from "../api";
import { EMPTY, LIST_MAX_AGE, REFERENCE_MAX_AGE, useResource } from "../cache";
import {
  emptyFilters, filtersFromParams, filtersToParams, isOverdue, matchesFilters, loadStoredViewState,
  VIEW_STATE_STORAGE_KEY, type IssueFilterState,
} from "../filters";
import { PageHeader } from "./PageHeader";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";
import { Filters } from "./Filters";
import { IssueTree } from "./IssueTree";
import { Modal, ConfirmModal, useConfirmClose } from "./Modal";
import { IssueForm } from "./IssueForm";
import { Pagination, usePagination } from "./Pagination";
import { ListBreadcrumbs } from "./Breadcrumbs";
import { BulkBar } from "./BulkBar";
import { SortHeader, type SortState } from "./SortHeader";

function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{state}</span>;
}

// Every column is user-toggleable; the "standard" ones just default to on, matching the table's
// original fixed shape. Persisted in localStorage so the choice survives across visits.
const ALL_COLUMNS = [
  { key: "id", label: "#", sortKey: "id" as const },
  { key: "title", label: "Title", sortKey: "title" as const },
  { key: "state", label: "State" },
  { key: "labels", label: "Labels" },
  { key: "parent", label: "Parent" },
  { key: "assignees", label: "Assignees" },
  { key: "deps", label: "Deps", sortKey: "deps" as const },
  { key: "artifacts", label: "Artifacts" },
  { key: "checks", label: "Checks" },
  { key: "deadline", label: "Deadline", sortKey: "deadline" as const },
  { key: "updated", label: "Last updated", sortKey: "updated" as const },
] as const;
type ColumnKey = (typeof ALL_COLUMNS)[number]["key"];
type Columns = Record<ColumnKey, boolean>;
const DEFAULT_COLUMNS: Columns = {
  id: true, title: true, state: true, labels: true, deps: true, updated: true,
  parent: false, assignees: false, artifacts: false, checks: false, deadline: false,
};
const COLUMNS_STORAGE_KEY = "taxis:issue-list-columns";

function loadColumns(): Columns {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (raw) return { ...DEFAULT_COLUMNS, ...JSON.parse(raw) };
  } catch { /* ignore malformed storage */ }
  return { ...DEFAULT_COLUMNS };
}

// A small "Columns ▾" popover for toggling which columns are shown.
function ColumnPicker({ cols, onChange }: { cols: Columns; onChange: (next: Columns) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  return (
    <div className="col-picker" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)}>Columns ▾</button>
      {open && (
        <div className="col-picker-menu">
          {ALL_COLUMNS.map((c) => (
            <label key={c.key} className="ms-item">
              <input
                type="checkbox"
                checked={cols[c.key]}
                onChange={() => onChange({ ...cols, [c.key]: !cols[c.key] })}
              />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact "time ago" for the last-updated column, with the exact time on hover.
function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

type SortKey = "id" | "title" | "updated" | "deps" | "deadline";

// The filters the server can apply, so a filtered view transfers only the rows it will show —
// opening the children of an issue with three children fetches three rows, not the whole tracker.
// Single-valued selections push down; multi-valued ones (and the fuzzy query) stay client-side,
// which stays correct because those only narrow the set further.
function serverFilters(f: IssueFilterState): IssueFilters {
  return {
    summary: true,
    state: f.state || undefined,
    parent: f.parents.length === 1 ? f.parents[0] : undefined,
    label: f.labels.length === 1 ? f.labels[0] : undefined,
    assignee: f.assignees.length === 1 ? f.assignees[0] : undefined,
  };
}

// One table row, memoised: the filter box re-renders the list on every keystroke, and each row
// runs a markdown parse for its title. Handed lookup maps rather than closures so the props
// actually compare equal between renders.
const IssueRowView = memo(function IssueRowView({
  issue, cols, selectable, selected, onToggleSelected, labelById, actorById, overdue,
}: {
  issue: Issue;
  cols: Columns;
  selectable: boolean;
  selected: boolean;
  onToggleSelected: (id: number) => void;
  labelById: Map<number, Label>;
  actorById: Map<number, Actor>;
  overdue: boolean;
}) {
  return (
    <tr className="issue-row" onClick={() => (window.location.hash = `#/issues/${issue.id}`)}>
      {selectable && (
        <td onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={() => onToggleSelected(issue.id)} />
        </td>
      )}
      {cols.id && <td className="cell-id">{issue.id}</td>}
      {cols.title && <td><Markdown text={issue.title} inline /> {issue.locked && <LockedMark />}</td>}
      {cols.state && <td><StateBadge state={issue.state} /></td>}
      {cols.labels && (
        <td>{issue.labels.map((l) => { const lbl = labelById.get(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })}</td>
      )}
      {cols.parent && (
        <td className="muted small">
          {issue.parent != null
            ? <a href={`#/issues/${issue.parent}`} onClick={(e) => e.stopPropagation()}>#{issue.parent}</a>
            : "—"}
        </td>
      )}
      {cols.assignees && (
        <td className="muted small">
          {issue.assignees.length
            ? issue.assignees.map((aid) => actorById.get(aid)?.displayName ?? `#${aid}`).join(", ")
            : "—"}
        </td>
      )}
      {/* The column header already says what these are; the cell only has to say how many. */}
      {cols.deps && <td className="cell-num">{issue.dependencies.length || "—"}</td>}
      {cols.artifacts && <td className="cell-num">{issue.artifacts.length || "—"}</td>}
      {cols.checks && <td className="cell-num">{issue.checks.length || "—"}</td>}
      {cols.deadline && (
        <td className={`small ${overdue ? "error" : "muted"}`}>
          {issue.deadline != null ? new Date(issue.deadline * 1000).toLocaleDateString() : "—"}
        </td>
      )}
      {cols.updated && (
        <td className="muted small" title={new Date(issue.updatedAt * 1000).toLocaleString()}>{timeAgo(issue.updatedAt)}</td>
      )}
    </tr>
  );
});

// The view options this page persists into the URL query string (e.g. "#/issues?state=open&view=tree"),
// so browser back-navigation and links (like an issue's Children panel) restore them. "open"
// is only the fallback default for a genuinely first-ever visit (no stored state either). The
// breadcrumbs' "Issues" root link uses "?reset=1" to explicitly ask for every issue, bypassing both
// the URL and the stored view — it means "start over", not "whatever I had".
function readViewStateFromHash(): { filters: IssueFilterState; view: "list" | "tree" } {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  if (qIndex < 0) return loadStoredViewState() ?? { filters: { ...emptyFilters, state: "open" }, view: "list" };
  const params = new URLSearchParams(hash.slice(qIndex + 1));
  if (params.get("reset") === "1") return { filters: emptyFilters, view: "list" };
  return {
    filters: filtersFromParams(params),
    view: params.get("view") === "tree" ? "tree" : "list",
  };
}

export function IssueList({ me }: { me: Actor | null }) {
  const [initialState] = useState(readViewStateFromHash);
  const [filters, setFilters] = useState<IssueFilterState>(initialState.filters);
  const [view, setView] = useState<"list" | "tree">(initialState.view);
  const [creating, setCreating] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const [cols, setCols] = useState<Columns>(loadColumns);
  useEffect(() => { localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(cols)); }, [cols]);
  const createClose = useConfirmClose(createDirty, () => setCreating(false));
  // Default sort is descending issue number (newest issues first).
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "id", dir: "desc" });

  // The rows themselves, narrowed server-side. Reference data and the naming index are read
  // through the same cache, so arriving here from the detail view (which already read them)
  // paints without waiting on the network.
  const query = useMemo(() => serverFilters(filters), [filters]);
  const issuesRes = useResource<Issue[]>(paths.issues(query), () => api.listIssues(query), LIST_MAX_AGE);
  const labelsRes = useResource<Label[]>(paths.labels, api.listLabels, REFERENCE_MAX_AGE);
  const actorsRes = useResource<Actor[]>(paths.actors, api.listActors, REFERENCE_MAX_AGE);
  const indexRes = useResource<IssueIndexEntry[]>(paths.issueIndex, api.issueIndex, REFERENCE_MAX_AGE);

  const issues = issuesRes.data ?? EMPTY;
  const labels = labelsRes.data ?? EMPTY;
  const actors = actorsRes.data ?? EMPTY;
  const issueIndex = indexRes.data ?? EMPTY;
  const loading = issuesRes.loading;
  const error = issuesRes.error ?? labelsRes.error ?? actorsRes.error;
  const load = issuesRes.reload;

  // The breadcrumbs' "Issues" root link uses "?reset=1" to explicitly clear every filter — but
  // when it's clicked while already on this page (e.g. from the "Children" filtered view), the
  // hash changes without remounting this component, so the lazy `readViewStateFromHash` initializer
  // never re-runs. Watch for it directly instead.
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash || "";
      const qIndex = hash.indexOf("?");
      if (qIndex < 0) return;
      const params = new URLSearchParams(hash.slice(qIndex + 1));
      if (params.get("reset") === "1") {
        setFilters(emptyFilters);
        setView("list");
      }
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const actorById = useMemo(() => new Map(actors.map((a) => [a.id, a])), [actors]);
  const now = Date.now();
  // Typing narrows the list at a lower priority than the keystroke itself, so the input keeps up
  // even when the re-render has to re-lay-out every visible row.
  const deferredQ = useDeferredValue(filters.q);
  const filtered = useMemo(
    () => issues.filter((i) => matchesFilters(i, { ...filters, q: deferredQ })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [issues, filters, deferredQ],
  );
  const colCount = Math.max(1, ALL_COLUMNS.filter((c) => cols[c.key]).length + (me ? 1 : 0));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // A selection belongs to the rows it was made on. Now that changing a filter fetches a different
  // set of rows, keeping it would leave the bulk bar counting issues that are no longer loaded.
  const issuesKey = paths.issues(query);
  useEffect(() => { setSelected(new Set()); }, [issuesKey]);
  const toggleSelected = useCallback((id: number) =>
    setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);

  // Clicking a column sorts by it; clicking the active column flips direction. New columns start
  // in the most useful direction (recent-first for dates, most-first for dependency counts).
  const defaultDir: Record<SortKey, "asc" | "desc"> = { id: "desc", title: "asc", updated: "desc", deps: "desc", deadline: "asc" };
  const onSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: defaultDir[k] }));

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    // Issues without a deadline always sort after ones with one, regardless of direction.
    const deadlineKey = (i: Issue) => i.deadline ?? Infinity;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case "id": cmp = a.id - b.id; break;
        case "title": cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" }); break;
        case "updated": cmp = a.updatedAt - b.updatedAt; break;
        case "deps": cmp = a.dependencies.length - b.dependencies.length; break;
        case "deadline": cmp = deadlineKey(a) - deadlineKey(b); break;
      }
      // Stable, deterministic tie-break by issue number.
      if (cmp === 0) cmp = a.id - b.id;
      return cmp * dir;
    });
  }, [filtered, sort]);

  const pager = usePagination(sorted);
  // Reset to the first page whenever the filter set or sort changes.
  useEffect(() => { pager.setPage(0); }, [JSON.stringify(filters), sort.key, sort.dir]);

  // Keep the URL in sync with the current filters/view (replacing, not pushing, so every keystroke
  // doesn't grow browser history) so it survives navigating away and back, and can be linked to
  // directly (e.g. an issue's "Children" breadcrumb links to "#/issues?parents=<id>").
  useEffect(() => {
    const params = filtersToParams(filters);
    if (view !== "list") params.set("view", view);
    const qs = params.toString();
    const next = "#/issues" + (qs ? `?${qs}` : "");
    if (window.location.hash !== next) history.replaceState(null, "", next);
    try { localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify({ filters, view })); } catch {}
  }, [filters, view]);

  // Narrowed to exactly one parent, this page *is* that issue's children — the breadcrumb names the
  // parent and the heading names the view, so neither has to repeat the other.
  const singleParent = filters.parents.length === 1 ? filters.parents[0] : null;
  // Only one generation is fetched under a parent filter, so every row would be its own root and
  // the tree would render as a flat copy of the list. Drop the choice rather than offer a view that
  // cannot nest.
  const canTree = singleParent == null;
  const effectiveView = canTree ? view : "list";
  // Whether an empty result means "this issue has no children" or "no child survived the other
  // filters" — two different things to tell someone staring at an empty table.
  const narrowedBeyondParent = !!filters.q || !!filters.state || filters.overdue
    || filters.labels.length > 0 || filters.assignees.length > 0 || filters.dependsOn.length > 0;

  return (
    <div>
      <ListBreadcrumbs parentId={singleParent} index={issueIndex} />
      <PageHeader
        title={singleParent != null ? "Children" : "Issues"}
        description={singleParent != null
          ? "The issues filed directly under this one."
          : "Everything you can see, as a flat list or as the containment tree."}
        actions={
          <>
            {canTree && (
              <div className="segmented">
                <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>List</button>
                <button className={view === "tree" ? "active" : ""} onClick={() => setView("tree")}>Tree</button>
              </div>
            )}
            {effectiveView === "list" && <ColumnPicker cols={cols} onChange={setCols} />}
            {me && <button className="primary" onClick={() => setCreating(true)}>+ New issue</button>}
          </>
        }
      />

      <Filters value={filters} onChange={setFilters} labels={labels} actors={actors} index={issueIndex} />

      {me && selected.size > 0 && (
        <BulkBar
          selectedIds={selected}
          issues={issues}
          index={issueIndex}
          labels={labels}
          actors={actors}
          onClear={() => setSelected(new Set())}
          onApplied={load}
        />
      )}

      {error && <div className="panel error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : effectiveView === "tree" ? (
        <>
          {/* The tree is built from the parent relation, so it unfolds into an issue's children —
              not its dependants, which is what the Graph view shows. */}
          <p className="muted small">Top-level issues shown; unfold to reveal the issues filed under them.</p>
          <IssueTree issues={filtered} labels={labels} />
        </>
      ) : (
        <>
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                {me && (
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      checked={pager.pageItems.length > 0 && pager.pageItems.every((i) => selected.has(i.id))}
                      onChange={(e) => setSelected((s) => {
                        const next = new Set(s);
                        pager.pageItems.forEach((i) => (e.target.checked ? next.add(i.id) : next.delete(i.id)));
                        return next;
                      })}
                    />
                  </th>
                )}
                {cols.id && <SortHeader label="#" k="id" sort={sort} onSort={onSort} style={{ width: 60 }} />}
                {cols.title && <SortHeader label="Title" k="title" sort={sort} onSort={onSort} />}
                {cols.state && <th>State</th>}
                {cols.labels && <th>Labels</th>}
                {cols.parent && <th>Parent</th>}
                {cols.assignees && <th>Assignees</th>}
                {cols.deps && <SortHeader label="Deps" k="deps" sort={sort} onSort={onSort} style={{ textAlign: "right" }} />}
                {cols.artifacts && <th style={{ textAlign: "right" }}>Artifacts</th>}
                {cols.checks && <th style={{ textAlign: "right" }}>Checks</th>}
                {cols.deadline && <SortHeader label="Deadline" k="deadline" sort={sort} onSort={onSort} />}
                {cols.updated && <SortHeader label="Last updated" k="updated" sort={sort} onSort={onSort} style={{ width: 120 }} />}
              </tr>
            </thead>
            <tbody>
              {pager.pageItems.map((i) => (
                <IssueRowView
                  key={i.id}
                  issue={i}
                  cols={cols}
                  selectable={!!me}
                  selected={selected.has(i.id)}
                  onToggleSelected={toggleSelected}
                  labelById={labelById}
                  actorById={actorById}
                  overdue={isOverdue(i, now)}
                />
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="muted" style={{ textAlign: "center", padding: 24 }}>
                    {singleParent == null
                      ? "No matching issues"
                      : narrowedBeyondParent
                        ? "No child issues match these filters."
                        : "Nothing is filed under this issue."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination {...pager} />
        </>
      )}

      {creating && (
        <Modal title="New issue" onClose={createClose.requestClose}>
          <IssueForm
            me={me}
            embedded
            onCancel={createClose.requestClose}
            onDirtyChange={setCreateDirty}
            onDone={(id) => { setCreating(false); window.location.hash = `#/issues/${id}`; }}
          />
        </Modal>
      )}
      {createClose.confirming && (
        <ConfirmModal
          title="Discard new issue?"
          message="You have unsaved changes. Discard them?"
          confirmLabel="Discard"
          danger
          onConfirm={createClose.confirmDiscard}
          onCancel={createClose.cancelDiscard}
        />
      )}
    </div>
  );
}
