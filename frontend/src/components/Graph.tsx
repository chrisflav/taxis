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

// Lay issues out in rows by dependency depth (longest chain of dependencies present in the set),
// then run a few barycenter passes so each node drifts toward the average position of its
// neighbours. This makes the layout symmetric: a node that many others depend on ends up centred
// over its dependents rather than pinned to the left. Edges are the `dependencies` relation.
function layout(issues: Issue[], nodeH: number) {
  const idSet = new Set(issues.map((i) => i.id));
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const parentsOf = new Map<number, number[]>();
  const childrenOf = new Map<number, number[]>();
  issues.forEach((i) => parentsOf.set(i.id, i.dependencies.filter((p) => idSet.has(p))));
  issues.forEach((i) =>
    (parentsOf.get(i.id) ?? []).forEach((p) => {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p)!.push(i.id);
    }),
  );

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

  // layers[d] = ids at depth d.
  const layers: number[][] = [];
  for (const i of issues) {
    const d = depthOf(i.id, new Set());
    (layers[d] ||= []).push(i.id);
  }

  // Slot (float column) position per node; seed with the index within the layer.
  const x = new Map<number, number>();
  layers.forEach((layer) => layer.forEach((id, idx) => x.set(id, idx)));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);

  // One relaxation sweep over `order`: place each node at the average slot of its neighbours,
  // then de-overlap left-to-right with a minimum one-slot gap and re-centre the row so the mean
  // barycenter (and thus overall symmetry) is preserved.
  const relax = (order: number[][], neighborsOf: Map<number, number[]>) => {
    for (const layer of order) {
      if (layer.length === 0) continue;
      const desired = layer.map((id) => {
        const ns = (neighborsOf.get(id) ?? []).filter((n) => x.has(n));
        return ns.length ? mean(ns.map((n) => x.get(n)!)) : x.get(id)!;
      });
      const idxs = layer.map((_, k) => k).sort((a, b) => desired[a] - desired[b]);
      const pos = new Array<number>(layer.length);
      let last = -Infinity;
      for (const k of idxs) {
        const p = Math.max(desired[k], last + 1);
        pos[k] = p;
        last = p;
      }
      const shift = mean(desired) - mean(pos);
      layer.forEach((id, k) => x.set(id, pos[k] + shift));
    }
  };

  const bottomUp = layers.slice().reverse();
  for (let iter = 0; iter < 6; iter++) {
    relax(layers, parentsOf);
    relax(bottomUp, childrenOf);
  }

  let minX = Infinity;
  let maxX = -Infinity;
  x.forEach((v) => { minX = Math.min(minX, v); maxX = Math.max(maxX, v); });
  if (!isFinite(minX)) { minX = 0; maxX = 0; }

  const placed = new Map<number, Placed>();
  layers.forEach((layer, depth) => {
    layer.forEach((id) => {
      const slot = x.get(id)! - minX;
      placed.set(id, {
        issue: issueById.get(id)!,
        x: X_GAP + slot * (NODE_W + X_GAP),
        y: Y_GAP + depth * (nodeH + Y_GAP),
      });
    });
  });

  const edges: { child: number; parent: number }[] = [];
  issues.forEach((i) => (parentsOf.get(i.id) ?? []).forEach((p) => edges.push({ child: i.id, parent: p })));

  const width = (maxX - minX) * (NODE_W + X_GAP) + NODE_W + 2 * X_GAP;
  const height = (layers.length || 1) * (nodeH + Y_GAP) + Y_GAP;
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
