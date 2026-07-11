import { useEffect, useMemo, useState } from "react";
import type { Actor, Issue, Label } from "../types";
import { api } from "../api";
import { emptyFilters, matchesFilters, type IssueFilterState } from "../filters";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";
import { Filters } from "./Filters";
import { IssueTree } from "./IssueTree";
import { Modal } from "./Modal";
import { IssueForm } from "./IssueForm";
import { Pagination, usePagination } from "./Pagination";

function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{state}</span>;
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

type SortKey = "id" | "title" | "updated" | "deps";
interface SortState { key: SortKey; dir: "asc" | "desc" }

// A clickable column header that sorts by `k` and shows the active direction.
function SortHeader({
  label, k, sort, onSort, style,
}: {
  label: string;
  k: SortKey;
  sort: SortState;
  onSort: (k: SortKey) => void;
  style?: React.CSSProperties;
}) {
  const active = sort.key === k;
  return (
    <th
      className={`sortable${active ? " active" : ""}`}
      style={style}
      onClick={() => onSort(k)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}<span className="sort-arrow">{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
    </th>
  );
}

export function IssueList({ me }: { me: Actor | null }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [filters, setFilters] = useState<IssueFilterState>({ ...emptyFilters, state: "open" });
  const [view, setView] = useState<"list" | "tree">("list");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Default sort is descending issue number (newest issues first).
  const [sort, setSort] = useState<SortState>({ key: "id", dir: "desc" });

  const load = () =>
    Promise.all([api.listIssues(), api.listLabels(), api.listActors()])
      .then(([is, ls, as]) => {
        setIssues(is);
        setLabels(ls);
        setActors(as);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const labelOf = (id: number) => labels.find((l) => l.id === id);
  const filtered = issues.filter((i) => matchesFilters(i, filters));

  // Clicking a column sorts by it; clicking the active column flips direction. New columns start
  // in the most useful direction (recent-first for dates, most-first for dependency counts).
  const defaultDir: Record<SortKey, "asc" | "desc"> = { id: "desc", title: "asc", updated: "desc", deps: "desc" };
  const onSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: defaultDir[k] }));

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sort.key) {
        case "id": cmp = a.id - b.id; break;
        case "title": cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" }); break;
        case "updated": cmp = a.updatedAt - b.updatedAt; break;
        case "deps": cmp = a.dependencies.length - b.dependencies.length; break;
      }
      // Stable, deterministic tie-break by issue number.
      if (cmp === 0) cmp = a.id - b.id;
      return cmp * dir;
    });
  }, [filtered, sort]);

  const pager = usePagination(sorted);
  // Reset to the first page whenever the filter set or sort changes.
  useEffect(() => { pager.setPage(0); }, [JSON.stringify(filters), sort.key, sort.dir]);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h2>Issues</h2>
        <div className="row">
          <div className="segmented">
            <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>List</button>
            <button className={view === "tree" ? "active" : ""} onClick={() => setView("tree")}>Tree</button>
          </div>
          {me && <button className="primary" onClick={() => setCreating(true)}>+ New issue</button>}
        </div>
      </div>

      <Filters value={filters} onChange={setFilters} labels={labels} actors={actors} />

      {error && <div className="panel error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : view === "tree" ? (
        <>
          <p className="muted small">Foundational issues shown; unfold to reveal what depends on them.</p>
          <IssueTree issues={filtered} labels={labels} />
        </>
      ) : (
        <>
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <SortHeader label="#" k="id" sort={sort} onSort={onSort} style={{ width: 60 }} />
                <SortHeader label="Title" k="title" sort={sort} onSort={onSort} />
                <th>State</th>
                <th>Labels</th>
                <SortHeader label="Deps" k="deps" sort={sort} onSort={onSort} />
                <SortHeader label="Last updated" k="updated" sort={sort} onSort={onSort} style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {pager.pageItems.map((i) => (
                <tr key={i.id} className="issue-row" onClick={() => (window.location.hash = `#/issues/${i.id}`)}>
                  <td className="muted">{i.id}</td>
                  <td><Markdown text={i.title} inline /> {i.locked && <span title="locked">🔒</span>}</td>
                  <td><StateBadge state={i.state} /></td>
                  <td>{i.labels.map((l) => { const lbl = labelOf(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })}</td>
                  <td className="muted small">{i.dependencies.length > 0 ? `${i.dependencies.length} dep(s)` : "—"}</td>
                  <td className="muted small" title={new Date(i.updatedAt * 1000).toLocaleString()}>{timeAgo(i.updatedAt)}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ textAlign: "center", padding: 24 }}>No matching issues</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination {...pager} />
        </>
      )}

      {creating && (
        <Modal title="New issue" onClose={() => setCreating(false)}>
          <IssueForm
            me={me}
            embedded
            onCancel={() => setCreating(false)}
            onDone={(id) => { setCreating(false); window.location.hash = `#/issues/${id}`; }}
          />
        </Modal>
      )}
    </div>
  );
}
