import { useEffect, useState } from "react";
import type { Actor, Issue, Label } from "../types";
import { api } from "../api";
import { emptyFilters, matchesFilters, type IssueFilterState } from "../filters";
import { LabelChip } from "./LabelChip";
import { Filters } from "./Filters";
import { IssueTree } from "./IssueTree";

function StateBadge({ state }: { state: string }) {
  return <span className={`badge ${state}`}>{state}</span>;
}

export function IssueList({ me }: { me: Actor | null }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [filters, setFilters] = useState<IssueFilterState>({ ...emptyFilters, state: "open" });
  const [view, setView] = useState<"list" | "tree">("list");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.listIssues(), api.listLabels(), api.listActors()])
      .then(([is, ls, as]) => {
        setIssues(is);
        setLabels(ls);
        setActors(as);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const labelOf = (id: number) => labels.find((l) => l.id === id);
  const filtered = issues.filter((i) => matchesFilters(i, filters));

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h2>Issues</h2>
        <div className="row">
          <div className="segmented">
            <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>List</button>
            <button className={view === "tree" ? "active" : ""} onClick={() => setView("tree")}>Tree</button>
          </div>
          {me && <a href="#/issues/new"><button className="primary">+ New issue</button></a>}
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
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th style={{ width: 50 }}>#</th><th>Title</th><th>State</th><th>Labels</th><th>Deps</th></tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id} className="issue-row" onClick={() => (window.location.hash = `#/issues/${i.id}`)}>
                  <td className="muted">{i.id}</td>
                  <td>{i.title} {i.locked && <span title="locked">🔒</span>}</td>
                  <td><StateBadge state={i.state} /></td>
                  <td>{i.labels.map((l) => { const lbl = labelOf(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })}</td>
                  <td className="muted small">{i.parents.length > 0 ? `${i.parents.length} parent(s)` : "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 24 }}>No matching issues</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
