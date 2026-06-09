import { useEffect, useMemo, useState } from "react";
import type { Actor, Issue, Label } from "../types";
import { api } from "../api";
import { emptyFilters, matchesFilters, type IssueFilterState } from "../filters";
import { Filters } from "./Filters";
import { LabelChip } from "./LabelChip";

const NODE_W = 210;
const X_GAP = 28;
const Y_GAP = 52;

interface Placed {
  issue: Issue;
  x: number;
  y: number;
}

// Lay issues out in rows by dependency depth (longest chain of dependencies present in the set).
function layout(issues: Issue[], nodeH: number) {
  const idSet = new Set(issues.map((i) => i.id));
  const parentsOf = new Map<number, number[]>();
  issues.forEach((i) => parentsOf.set(i.id, i.parents.filter((p) => idSet.has(p))));

  const depthMemo = new Map<number, number>();
  const depthOf = (id: number, stack: Set<number>): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const ps = parentsOf.get(id) ?? [];
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => depthOf(p, stack)));
    stack.delete(id);
    depthMemo.set(id, d);
    return d;
  };

  const layers = new Map<number, Issue[]>();
  for (const i of issues) {
    const d = depthOf(i.id, new Set());
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d)!.push(i);
  }

  const placed = new Map<number, Placed>();
  let maxRow = 0;
  for (const [depth, ns] of layers) {
    ns.forEach((issue, i) => {
      placed.set(issue.id, { issue, x: X_GAP + i * (NODE_W + X_GAP), y: Y_GAP + depth * (nodeH + Y_GAP) });
    });
    maxRow = Math.max(maxRow, ns.length);
  }

  const edges: { child: number; parent: number }[] = [];
  issues.forEach((i) => (parentsOf.get(i.id) ?? []).forEach((p) => edges.push({ child: i.id, parent: p })));

  const width = Math.max(1, maxRow) * (NODE_W + X_GAP) + X_GAP;
  const height = (layers.size || 1) * (nodeH + Y_GAP) + Y_GAP;
  return { placed, edges, width, height };
}

export function GraphView() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [filters, setFilters] = useState<IssueFilterState>(emptyFilters);
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

  const labelOf = (id: number) => labels.find((l) => l.id === id);
  const actorName = (id: number) => actors.find((a) => a.id === id)?.displayName ?? `#${id}`;

  const nodeH = 46 + (showLabels ? 26 : 0) + (showAssignees ? 24 : 0);
  const filtered = issues.filter((i) => matchesFilters(i, filters));
  const model = useMemo(() => layout(filtered, nodeH), [filtered, nodeH]);

  return (
    <div>
      <h2>Dependency graph</h2>
      <Filters value={filters} onChange={setFilters} labels={labels} actors={actors} />
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="row small" style={{ margin: 0 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Show labels
        </label>
        <label className="row small" style={{ margin: 0 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={showAssignees} onChange={(e) => setShowAssignees(e.target.checked)} /> Show assignees
        </label>
        <span className="muted small">Arrows point from an issue to the dependency it points at. Click a node to open it.</span>
      </div>

      {error && <div className="panel error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="panel muted">No matching issues.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
        <div className="graph-canvas" style={{ position: "relative", width: model.width, height: model.height }}>
          <svg width={model.width} height={model.height} style={{ position: "absolute", inset: 0, zIndex: 0 }}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
              </marker>
            </defs>
            {model.edges.map((e, i) => {
              const c = model.placed.get(e.child);
              const p = model.placed.get(e.parent);
              if (!c || !p) return null;
              return (
                <line key={i} className="graph-edge"
                  x1={c.x + NODE_W / 2} y1={c.y}
                  x2={p.x + NODE_W / 2} y2={p.y + nodeH}
                  markerEnd="url(#arrow)" />
              );
            })}
          </svg>
          {[...model.placed.values()].map((p) => (
            <div
              key={p.issue.id}
              className={`graph-card ${p.issue.state}`}
              style={{ left: p.x, top: p.y, width: NODE_W, height: nodeH }}
              onClick={() => (window.location.hash = `#/issues/${p.issue.id}`)}
            >
              <div className="row" style={{ gap: 6 }}>
                <span className="muted small">#{p.issue.id}</span>
                <span className="graph-card-title">{p.issue.title}</span>
                {p.issue.locked && <span title="locked">🔒</span>}
              </div>
              <div><span className={`badge ${p.issue.state}`}>{p.issue.state}</span></div>
              {showLabels && (
                <div className="graph-card-line">
                  {p.issue.labels.length
                    ? p.issue.labels.map((l) => { const lbl = labelOf(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })
                    : <span className="muted small">no labels</span>}
                </div>
              )}
              {showAssignees && (
                <div className="graph-card-line muted small">
                  {p.issue.assignees.length ? p.issue.assignees.map(actorName).join(", ") : "unassigned"}
                </div>
              )}
            </div>
          ))}
        </div>
        </div>
      )}
    </div>
  );
}
