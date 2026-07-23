import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

// The graph rendering shared by the views that draw one: layered layout, pan/zoom viewport,
// edge routing, and hover highlighting. It knows nothing about what a node *is* — callers hand
// it nodes with ids and the ids they point at, plus a function to render one — so the issue
// dependency graph and the repository dependency graph are the same canvas with different cards.

// "down": generations stack top-to-bottom, siblings spread left-to-right (the original layout).
// "right": rotated 90° — generations run left-to-right (parent on the left), siblings stack
// top-to-bottom.
export type GraphDirection = "down" | "right";

export interface GraphNode {
  id: string;
  // Nodes this one points at. Edges are drawn from the node to each of them, so for the issue
  // graph these are its dependencies and for the repository graph the repos it depends on.
  parents: string[];
}

const X_GAP = 34;
const Y_GAP = 60;

interface Placed<N> {
  node: N;
  x: number;
  y: number;
}

// Lay nodes out in rows by depth in the edge relation (longest chain present in the set), then
// run a few barycenter passes so each node drifts toward the average position of its neighbours.
// This makes the layout symmetric: a node with many neighbours ends up centred over them rather
// than pinned to the left. `direction` only affects the final depth/slot -> pixel mapping (and
// which node dimension governs spacing along each screen axis) — the layout math itself is the
// same either way.
function layout<N extends GraphNode>(nodes: N[], nodeW: number, nodeH: number, direction: GraphDirection) {
  const idSet = new Set(nodes.map((n) => n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  nodes.forEach((n) => parentsOf.set(n.id, n.parents.filter((p) => idSet.has(p) && p !== n.id)));
  nodes.forEach((n) =>
    (parentsOf.get(n.id) ?? []).forEach((p) => {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p)!.push(n.id);
    }),
  );

  const depthMemo = new Map<string, number>();
  const depthOf = (id: string, stack: Set<string>): number => {
    if (depthMemo.has(id)) return depthMemo.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const ps = parentsOf.get(id) ?? [];
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => depthOf(p, stack)));
    stack.delete(id);
    depthMemo.set(id, d);
    return d;
  };

  const layers: string[][] = [];
  for (const n of nodes) {
    const d = depthOf(n.id, new Set());
    (layers[d] ||= []).push(n.id);
  }

  const x = new Map<string, number>();
  layers.forEach((layer) => layer.forEach((id, idx) => x.set(id, idx)));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : 0);

  const relax = (order: string[][], neighborsOf: Map<string, string[]>) => {
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

  const placed = new Map<string, Placed<N>>();
  layers.forEach((layer, depth) => {
    layer.forEach((id) => {
      const slot = x.get(id)! - minX;
      const sPos = siblingPos(slot, direction === "down" ? nodeW : nodeH, direction === "down" ? X_GAP : Y_GAP);
      const dPos = depthPos(depth, direction === "down" ? nodeH : nodeW, direction === "down" ? Y_GAP : X_GAP);
      placed.set(id, {
        node: nodeById.get(id)!,
        x: direction === "down" ? sPos : dPos,
        y: direction === "down" ? dPos : sPos,
      });
    });
  });

  const edges: { child: string; parent: string }[] = [];
  nodes.forEach((n) => (parentsOf.get(n.id) ?? []).forEach((p) => edges.push({ child: n.id, parent: p })));

  const sExtent = siblingExtent(direction === "down" ? nodeW : nodeH, direction === "down" ? X_GAP : Y_GAP);
  const dExtent = depthExtent(direction === "down" ? nodeH : nodeW, direction === "down" ? Y_GAP : X_GAP);
  const width = direction === "down" ? sExtent : dExtent;
  const height = direction === "down" ? dExtent : sExtent;
  return { placed, edges, width, height, parentsOf, childrenOf };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Viewport { k: number; tx: number; ty: number }

export interface GraphCanvasProps<N extends GraphNode> {
  nodes: N[];
  nodeWidth: number;
  nodeHeight: number;
  direction: GraphDirection;
  renderNode: (node: N) => ReactNode;
  // Extra classes for a node's card, e.g. its state. Hover highlighting is added on top.
  nodeClassName?: (node: N) => string;
  onNodeOpen?: (node: N) => void;
  // Tooltip for the edge between two nodes.
  edgeTitle?: (child: N, parent: N) => string | undefined;
}

export function GraphCanvas<N extends GraphNode>({
  nodes, nodeWidth, nodeHeight, direction, renderNode, nodeClassName, onNodeOpen, edgeTitle,
}: GraphCanvasProps<N>) {
  const [hover, setHover] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ k: 1, tx: 0, ty: 0 });
  // A drag on the background pans; a drag that moved suppresses the click-through node navigation.
  const pan = useRef<{ x: number; y: number; tx: number; ty: number; pointerId: number; el: HTMLElement } | null>(null);
  const movedRef = useRef(false);

  const model = useMemo(
    () => layout(nodes, nodeWidth, nodeHeight, direction),
    [nodes, nodeWidth, nodeHeight, direction],
  );

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
    const set = new Set<string>([hover]);
    (model.parentsOf.get(hover) ?? []).forEach((p) => set.add(p));
    (model.childrenOf.get(hover) ?? []).forEach((c) => set.add(c));
    return set;
  }, [hover, model]);

  const open = (node: N) => { if (!movedRef.current) onNodeOpen?.(node); };

  return (
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
            const x1 = direction === "down" ? c.x + nodeWidth / 2 : c.x;
            const y1 = direction === "down" ? c.y : c.y + nodeHeight / 2;
            const x2 = direction === "down" ? p.x + nodeWidth / 2 : p.x + nodeWidth;
            const y2 = direction === "down" ? p.y + nodeHeight : p.y + nodeHeight / 2;
            const hi = hover != null && (e.child === hover || e.parent === hover);
            const dim = connected != null && !hi;
            const d = direction === "down"
              ? `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`
              : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
            const title = edgeTitle?.(c.node, p.node);
            return (
              <path key={i} className={`graph-edge${hi ? " hi" : ""}${dim ? " dim" : ""}`}
                d={d}
                markerEnd={hi ? "url(#arrow-hi)" : "url(#arrow)"}>
                {title && <title>{title}</title>}
              </path>
            );
          })}
        </svg>
        {[...model.placed.values()].map((p) => {
          const dim = connected != null && !connected.has(p.node.id);
          return (
            <div
              key={p.node.id}
              className={`graph-card ${nodeClassName?.(p.node) ?? ""}${hover === p.node.id ? " hi" : ""}${dim ? " dim" : ""}`}
              style={{ left: p.x, top: p.y, width: nodeWidth, height: nodeHeight }}
              onPointerEnter={() => setHover(p.node.id)}
              onPointerLeave={() => setHover((h) => (h === p.node.id ? null : h))}
              onClick={() => open(p.node)}
            >
              {renderNode(p.node)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The canvas frame before its graph has arrived.

    Reuses the viewport's own styling so it stands in the space the graph will occupy. The
    alternative — a one-line "Loading…" — collapses three quarters of the viewport height and then
    shoves the whole page back down when the data lands. `note` says what is being waited on where
    that is worth saying: the repository graph reads package manifests over the network, and a
    second of apparent nothing is better explained than not. */
export function GraphPlaceholder({ note }: { note?: string }) {
  return (
    <div className="graph-viewport graph-viewport-empty" aria-busy="true">
      <span className="muted small">{note ?? "Laying out the graph…"}</span>
    </div>
  );
}
