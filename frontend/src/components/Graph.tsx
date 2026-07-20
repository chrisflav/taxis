import { useEffect, useMemo, useState } from "react";
import type { Actor, Issue, Label } from "../types";
import { api } from "../api";
import { emptyFilters, filtersFromParams, filtersToParams, matchesFilters, type IssueFilterState } from "../filters";
import { Filters } from "./Filters";
import { GraphCanvas, type GraphDirection, type GraphNode } from "./GraphCanvas";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";
import { MultiSelect } from "./MultiSelect";

const NODE_W = 210;

// Two edge relations to lay the graph out by: the "dependencies" relation (issue -> what it
// depends on) or the "hierarchy" (containment) relation (issue -> its parent issue).
export type GraphMode = "dependencies" | "hierarchy";

export type { GraphDirection };

interface IssueNode extends GraphNode {
  issue: Issue;
}

// Same view-state persistence as IssueList: "open" is the default on a genuinely first-ever visit,
// but once the state (or any other filter) is changed, it's kept in the URL query string so it
// survives navigating away and back. Also mirrored to localStorage, since a bare "#/graph" nav-tab
// link (unlike an explicit "?state=..." link) carries no query string to restore from.
const GRAPH_FILTERS_STORAGE_KEY = "taxis:graph-filters";

function loadStoredGraphFilters(): IssueFilterState | null {
  try {
    const raw = localStorage.getItem(GRAPH_FILTERS_STORAGE_KEY);
    return raw ? { ...emptyFilters, ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

function readGraphFiltersFromHash(): IssueFilterState {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  if (qIndex < 0) return loadStoredGraphFilters() ?? { ...emptyFilters, state: "open" };
  return filtersFromParams(new URLSearchParams(hash.slice(qIndex + 1)));
}

export function GraphView() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [filters, setFilters] = useState<IssueFilterState>(readGraphFiltersFromHash);
  const [layoutMode, setLayoutMode] = useState<GraphMode>("dependencies");
  const [direction, setDirection] = useState<GraphDirection>("down");
  const [genFilter, setGenFilter] = useState<number[]>([]);
  const [showLabels, setShowLabels] = useState(false);
  const [showAssignees, setShowAssignees] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.listIssues(), api.listLabels(), api.listActors()])
      .then(([is, ls, as]) => { setIssues(is); setLabels(ls); setActors(as); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const params = filtersToParams(filters);
    const qsStr = params.toString();
    const next = "#/graph" + (qsStr ? `?${qsStr}` : "");
    if (window.location.hash !== next) history.replaceState(null, "", next);
    try { localStorage.setItem(GRAPH_FILTERS_STORAGE_KEY, JSON.stringify(filters)); } catch {}
  }, [filters]);

  const labelOf = (id: number) => labels.find((l) => l.id === id);
  const actorOf = (id: number) => actors.find((a) => a.id === id);

  const nodeH = 46 + (showLabels ? 26 : 0) + (showAssignees ? 24 : 0);
  const filtered = useMemo(() => issues.filter((i) => matchesFilters(i, filters)), [issues, filters]);

  // "Generation" = how nested an issue is in the parent-child (containment) chain, 0 for a
  // top-level issue — always computed against the full parent chain, independent of both the
  // current filters and the selected layout mode, so it stays meaningful in either mode.
  const generationOf = useMemo(() => {
    const byId = new Map(issues.map((i) => [i.id, i]));
    const memo = new Map<number, number>();
    const calc = (id: number, stack: Set<number>): number => {
      if (memo.has(id)) return memo.get(id)!;
      const issue = byId.get(id);
      if (stack.has(id) || !issue || issue.parent == null || !byId.has(issue.parent)) {
        memo.set(id, 0);
        return 0;
      }
      stack.add(id);
      const d = 1 + calc(issue.parent, stack);
      stack.delete(id);
      memo.set(id, d);
      return d;
    };
    issues.forEach((i) => calc(i.id, new Set()));
    return memo;
  }, [issues]);

  const generationOptions = useMemo(() => {
    const gens = new Set<number>();
    issues.forEach((i) => gens.add(generationOf.get(i.id) ?? 0));
    return [...gens].sort((a, b) => a - b)
      .map((g) => ({ value: g, label: g === 0 ? "Generation 0 (root)" : `Generation ${g}` }));
  }, [issues, generationOf]);

  const genFiltered = useMemo(
    () => (genFilter.length === 0 ? filtered : filtered.filter((i) => genFilter.includes(generationOf.get(i.id) ?? 0))),
    [filtered, genFilter, generationOf],
  );

  const nodes = useMemo<IssueNode[]>(() => genFiltered.map((issue) => ({
    id: String(issue.id),
    parents: layoutMode === "dependencies"
      ? issue.dependencies.map(String)
      : issue.parent != null ? [String(issue.parent)] : [],
    issue,
  })), [genFiltered, layoutMode]);

  return (
    <div>
      <h2>Graph</h2>
      <Filters value={filters} onChange={setFilters} labels={labels} actors={actors} issues={issues} />
      <div className="row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
        <div className="row">
          <div className="segmented">
            <button className={layoutMode === "dependencies" ? "active" : ""} onClick={() => setLayoutMode("dependencies")}>
              Dependencies
            </button>
            <button className={layoutMode === "hierarchy" ? "active" : ""} onClick={() => setLayoutMode("hierarchy")}>
              Hierarchy
            </button>
          </div>
          <div className="segmented">
            <button className={direction === "down" ? "active" : ""} onClick={() => setDirection("down")} title="Parent on top, expand downward">
              ⬇ Down
            </button>
            <button className={direction === "right" ? "active" : ""} onClick={() => setDirection("right")} title="Parent on the left, expand to the right">
              ➡ Right
            </button>
          </div>
          <div style={{ minWidth: 200 }}>
            <MultiSelect
              options={generationOptions}
              selected={genFilter}
              onChange={setGenFilter}
              placeholder="all generations"
            />
          </div>
        </div>
        <label className="row small" style={{ margin: 0 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Show labels
        </label>
        <label className="row small" style={{ margin: 0 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={showAssignees} onChange={(e) => setShowAssignees(e.target.checked)} /> Show assignees
        </label>
      </div>
      <p className="muted small" style={{ marginTop: -6 }}>
        {layoutMode === "dependencies"
          ? "Arrows point from an issue to the dependency it needs."
          : "Arrows point from a child issue to its parent."}{" "}
        Scroll to zoom, drag to pan, hover to trace, click to open.
      </p>

      {error && <div className="panel error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : nodes.length === 0 ? (
        <div className="panel muted">No matching issues.</div>
      ) : (
        <GraphCanvas
          nodes={nodes}
          nodeWidth={NODE_W}
          nodeHeight={nodeH}
          direction={direction}
          nodeClassName={(n) => n.issue.state}
          onNodeOpen={(n) => { window.location.hash = `#/issues/${n.issue.id}`; }}
          renderNode={(n) => (
            <>
              <div className="row" style={{ gap: 6 }}>
                <span className="muted small">#{n.issue.id}</span>
                <span className="graph-card-title"><Markdown text={n.issue.title} inline /></span>
                {n.issue.locked && <span title="locked">🔒</span>}
              </div>
              <div><span className={`badge ${n.issue.state}`}>{n.issue.state}</span></div>
              {showLabels && (
                <div className="graph-card-line">
                  {n.issue.labels.length
                    ? n.issue.labels.map((l) => { const lbl = labelOf(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })
                    : <span className="muted small">no labels</span>}
                </div>
              )}
              {showAssignees && (
                <div className="graph-card-line muted small">
                  {n.issue.assignees.length
                    ? n.issue.assignees.map((id) => { const a = actorOf(id); return (a?.displayName ?? `#${id}`) + (a?.bot ? " 🤖" : ""); }).join(", ")
                    : "unassigned"}
                </div>
              )}
            </>
          )}
        />
      )}
    </div>
  );
}
