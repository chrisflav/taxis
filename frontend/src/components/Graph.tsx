import { useEffect, useMemo, useRef, useState } from "react";
import type { Actor, Issue, Label } from "../types";
import { api } from "../api";
import { emptyFilters, filtersFromParams, filtersToParams, matchesFilters, type IssueFilterState } from "../filters";
import { Filters } from "./Filters";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";
import { MultiSelect } from "./MultiSelect";

const NODE_W = 210;
const X_GAP = 34;
const Y_GAP = 60;

// Two edge relations to lay the graph out by: the "dependencies" relation (issue -> what it
// depends on) or the "hierarchy" (containment) relation (issue -> its parent issue).
export type GraphMode = "dependencies" | "hierarchy";

// "down": generations stack top-to-bottom, siblings spread left-to-right (the original layout).
// "right": rotated 90° — generations run left-to-right (parent on the left), siblings stack
// top-to-bottom.
export type GraphDirection = "down" | "right";

interface Placed {
  issue: Issue;
  x: number;
  y: number;
}

// Lay issues out in rows by depth in the chosen relation (longest chain present in the set), then
// run a few barycenter passes so each node drifts toward the average position of its neighbours.
// This makes the layout symmetric: a node with many neighbours ends up centred over them rather
// than pinned to the left. `direction` only affects the final depth/slot -> pixel mapping (and
// which node dimension governs spacing along each screen axis) — the layout math itself is the
// same either way.
function layout(issues: Issue[], nodeH: number, mode: GraphMode, direction: GraphDirection) {
  const idSet = new Set(issues.map((i) => i.id));
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const parentsOf = new Map<number, number[]>();
  const childrenOf = new Map<number, number[]>();
  if (mode === "dependencies") {
    issues.forEach((i) => parentsOf.set(i.id, i.dependencies.filter((p) => idSet.has(p))));
  } else {
    issues.forEach((i) => parentsOf.set(i.id, i.parent != null && idSet.has(i.parent) ? [i.parent] : []));
  }
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

  // Position/extent along the (continuous, post-relaxation) sibling axis vs. the (integer) depth
  // axis — each parameterized by whichever node dimension + gap governs spacing along the screen
  // axis it ends up on, which depends on `direction`.
  const siblingPos = (slot: number, size: number, gap: number) => gap + slot * (size + gap);
  const depthPos = (depth: number, size: number, gap: number) => gap + depth * (size + gap);
  const siblingExtent = (size: number, gap: number) => (maxX - minX) * (size + gap) + size + 2 * gap;
  const depthExtent = (size: number, gap: number) => (layers.length || 1) * (size + gap) + gap;

  const placed = new Map<number, Placed>();
  layers.forEach((layer, depth) => {
    layer.forEach((id) => {
      const slot = x.get(id)! - minX;
      const sPos = siblingPos(slot, direction === "down" ? NODE_W : nodeH, direction === "down" ? X_GAP : Y_GAP);
      const dPos = depthPos(depth, direction === "down" ? nodeH : NODE_W, direction === "down" ? Y_GAP : X_GAP);
      placed.set(id, {
        issue: issueById.get(id)!,
        x: direction === "down" ? sPos : dPos,
        y: direction === "down" ? dPos : sPos,
      });
    });
  });

  const edges: { child: number; parent: number }[] = [];
  issues.forEach((i) => (parentsOf.get(i.id) ?? []).forEach((p) => edges.push({ child: i.id, parent: p })));

  const sExtent = siblingExtent(direction === "down" ? NODE_W : nodeH, direction === "down" ? X_GAP : Y_GAP);
  const dExtent = depthExtent(direction === "down" ? nodeH : NODE_W, direction === "down" ? Y_GAP : X_GAP);
  const width = direction === "down" ? sExtent : dExtent;
  const height = direction === "down" ? dExtent : sExtent;
  return { placed, edges, width, height, parentsOf, childrenOf, direction };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Viewport { k: number; tx: number; ty: number }

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
  const [hover, setHover] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ k: 1, tx: 0, ty: 0 });
  // A drag on the background pans; a drag that moved suppresses the click-through node navigation.
  const pan = useRef<{ x: number; y: number; tx: number; ty: number; pointerId: number; el: HTMLElement } | null>(null);
  const movedRef = useRef(false);

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

  const model = useMemo(() => layout(genFiltered, nodeH, layoutMode, direction), [genFiltered, nodeH, layoutMode, direction]);

  // Fit the whole graph into the viewport whenever the model changes.
  const fit = () => {
    const el = viewportRef.current;
    if (!el || model.width === 0) return;
    const vw = el.clientWidth, vh = el.clientHeight;
    const k = clamp(Math.min(vw / model.width, vh / model.height) * 0.92, 0.08, 1.5);
    setView({ k, tx: (vw - model.width * k) / 2, ty: (vh - model.height * k) / 2 });
  };
  useEffect(() => { fit(); /* eslint-disable-next-line */ }, [model.width, model.height]);

  // Track native fullscreen state and re-fit once the viewport has resized to fill the screen.
  useEffect(() => {
    const onFsChange = () => {
      setFullscreen(document.fullscreenElement === viewportRef.current);
      requestAnimationFrame(fit);
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
    // eslint-disable-next-line
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else viewportRef.current?.requestFullscreen();
  };

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
    pan.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, pointerId: e.pointerId, el: e.currentTarget as HTMLElement };
    movedRef.current = false;
    // Pointer capture is deferred until the gesture is confirmed as a drag (see onPointerMove).
    // Capturing eagerly here would retarget the eventual click to the viewport instead of whatever
    // was actually pressed (a zoom button, a graph node), silently swallowing plain clicks on them.
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pan.current) return;
    const dx = e.clientX - pan.current.x, dy = e.clientY - pan.current.y;
    if (!movedRef.current && Math.abs(dx) + Math.abs(dy) > 4) {
      movedRef.current = true;
      pan.current.el.setPointerCapture(pan.current.pointerId);
    }
    if (movedRef.current) setView((v) => ({ ...v, tx: pan.current!.tx + dx, ty: pan.current!.ty + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (movedRef.current) {
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    pan.current = null;
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
      ) : genFiltered.length === 0 ? (
        <div className="panel muted">No matching issues.</div>
      ) : (
        <div className="graph-viewport" ref={viewportRef}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
          <div className="graph-controls">
            <button onClick={() => zoomBy(1.2)} title="Zoom in">+</button>
            <button onClick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
            <button onClick={fit} title="Fit to view">⤢</button>
            <button onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
              {fullscreen ? "⤡" : "⛶"}
            </button>
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
                // Connects the child's edge facing its parent's generation to that edge of the
                // parent: top->bottom when stacked vertically, left->right when stacked
                // horizontally — an S-curve bulging along whichever axis separates generations.
                const x1 = direction === "down" ? c.x + NODE_W / 2 : c.x;
                const y1 = direction === "down" ? c.y : c.y + nodeH / 2;
                const x2 = direction === "down" ? p.x + NODE_W / 2 : p.x + NODE_W;
                const y2 = direction === "down" ? p.y + nodeH : p.y + nodeH / 2;
                const hi = hover != null && (e.child === hover || e.parent === hover);
                const dim = connected != null && !hi;
                const d = direction === "down"
                  ? `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`
                  : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
                return (
                  <path key={i} className={`graph-edge${hi ? " hi" : ""}${dim ? " dim" : ""}`}
                    d={d}
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
