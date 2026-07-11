import { useEffect, useMemo, useRef, useState } from "react";
import type { Actor, Issue, Label } from "../types";
import { api } from "../api";
import { emptyFilters, matchesFilters, type IssueFilterState } from "../filters";
import { Filters } from "./Filters";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";

const NODE_W = 210;
const X_GAP = 34;
const Y_GAP = 60;

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

  const layers: number[][] = [];
  for (const i of issues) {
    const d = depthOf(i.id, new Set());
    (layers[d] ||= []).push(i.id);
  }

  const x = new Map<number, number>();
  layers.forEach((layer) => layer.forEach((id, idx) => x.set(id, idx)));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);

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
  return { placed, edges, width, height, parentsOf, childrenOf };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Viewport { k: number; tx: number; ty: number }

export function GraphView() {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [filters, setFilters] = useState<IssueFilterState>(emptyFilters);
  const [showLabels, setShowLabels] = useState(false);
  const [showAssignees, setShowAssignees] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<number | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ k: 1, tx: 0, ty: 0 });
  // A drag on the background pans; a drag that moved suppresses the click-through node navigation.
  const pan = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    Promise.all([api.listIssues(), api.listLabels(), api.listActors()])
      .then(([is, ls, as]) => { setIssues(is); setLabels(ls); setActors(as); setError(null); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const labelOf = (id: number) => labels.find((l) => l.id === id);
  const actorOf = (id: number) => actors.find((a) => a.id === id);

  const nodeH = 46 + (showLabels ? 26 : 0) + (showAssignees ? 24 : 0);
  const filtered = useMemo(() => issues.filter((i) => matchesFilters(i, filters)), [issues, filters]);
  const model = useMemo(() => layout(filtered, nodeH), [filtered, nodeH]);

  // Fit the whole graph into the viewport whenever the model changes.
  const fit = () => {
    const el = viewportRef.current;
    if (!el || model.width === 0) return;
    const vw = el.clientWidth, vh = el.clientHeight;
    const k = clamp(Math.min(vw / model.width, vh / model.height) * 0.92, 0.08, 1.5);
    setView({ k, tx: (vw - model.width * k) / 2, ty: (vh - model.height * k) / 2 });
  };
  useEffect(() => { fit(); /* eslint-disable-next-line */ }, [model.width, model.height]);

  // Wheel-zoom around the pointer. Registered natively so preventDefault works (React's wheel
  // listener is passive).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      setView((v) => {
        const k = clamp(v.k * factor, 0.08, 2.5);
        const wx = (px - v.tx) / v.k, wy = (py - v.ty) / v.k;
        return { k, tx: px - wx * k, ty: py - wy * k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
    movedRef.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pan.current) return;
    const dx = e.clientX - pan.current.x, dy = e.clientY - pan.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
    setView((v) => ({ ...v, tx: pan.current!.tx + dx, ty: pan.current!.ty + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pan.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const zoomBy = (factor: number) => {
    const el = viewportRef.current;
    const cx = (el?.clientWidth ?? 0) / 2, cy = (el?.clientHeight ?? 0) / 2;
    setView((v) => {
      const k = clamp(v.k * factor, 0.08, 2.5);
      const wx = (cx - v.tx) / v.k, wy = (cy - v.ty) / v.k;
      return { k, tx: cx - wx * k, ty: cy - wy * k };
    });
  };

  // Nodes and edges connected to the hovered node, used to highlight and dim the rest.
  const connected = useMemo(() => {
    if (hover == null) return null;
    const set = new Set<number>([hover]);
    (model.parentsOf.get(hover) ?? []).forEach((p) => set.add(p));
    (model.childrenOf.get(hover) ?? []).forEach((c) => set.add(c));
    return set;
  }, [hover, model]);

  const openNode = (id: number) => { if (!movedRef.current) window.location.hash = `#/issues/${id}`; };

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
        <span className="muted small">Arrows point from an issue to the dependency it needs. Scroll to zoom, drag to pan, hover to trace, click to open.</span>
      </div>

      {error && <div className="panel error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="panel muted">No matching issues.</div>
      ) : (
        <div className="graph-viewport" ref={viewportRef}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
          <div className="graph-controls">
            <button onClick={() => zoomBy(1.2)} title="Zoom in">+</button>
            <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
            <button onClick={fit} title="Fit to view">⤢</button>
            <span className="graph-zoom small muted">{Math.round(view.k * 100)}%</span>
          </div>
          <div className="graph-world" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})` }}>
            <svg width={model.width} height={model.height} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--muted)" />
                </marker>
                <marker id="arrow-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)" />
                </marker>
              </defs>
              {model.edges.map((e, i) => {
                const c = model.placed.get(e.child);
                const p = model.placed.get(e.parent);
                if (!c || !p) return null;
                const x1 = c.x + NODE_W / 2, y1 = c.y;
                const x2 = p.x + NODE_W / 2, y2 = p.y + nodeH;
                const my = (y1 + y2) / 2;
                const hi = hover != null && (e.child === hover || e.parent === hover);
                const dim = connected != null && !hi;
                return (
                  <path key={i} className={`graph-edge${hi ? " hi" : ""}${dim ? " dim" : ""}`}
                    d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
                    markerEnd={hi ? "url(#arrow-hi)" : "url(#arrow)"} />
                );
              })}
            </svg>
            {[...model.placed.values()].map((p) => {
              const dim = connected != null && !connected.has(p.issue.id);
              return (
                <div
                  key={p.issue.id}
                  className={`graph-card ${p.issue.state}${hover === p.issue.id ? " hi" : ""}${dim ? " dim" : ""}`}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: nodeH }}
                  onPointerEnter={() => setHover(p.issue.id)}
                  onPointerLeave={() => setHover((h) => (h === p.issue.id ? null : h))}
                  onClick={() => openNode(p.issue.id)}
                >
                  <div className="row" style={{ gap: 6 }}>
                    <span className="muted small">#{p.issue.id}</span>
                    <span className="graph-card-title"><Markdown text={p.issue.title} inline /></span>
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
                      {p.issue.assignees.length
                        ? p.issue.assignees.map((id) => { const a = actorOf(id); return (a?.displayName ?? `#${id}`) + (a?.bot ? " 🤖" : ""); }).join(", ")
                        : "unassigned"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
