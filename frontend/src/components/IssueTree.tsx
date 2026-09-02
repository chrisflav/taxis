import { useCallback, useEffect, useRef, useState } from "react";
import { LockedMark } from "./Icon";
import type { IssueListRow, Label } from "../types";
import { api, type IssuePageQuery } from "../api";
import { mirrorList } from "../mirror";
import { useLocalFirst, useMirrorRevision } from "../useMirror";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";

// Hierarchical view over the single `parent` (containment) relation, read one level at a time —
// from the device in the packaged app, where the whole tracker is already stored, and from the
// server on the web. A level is a plain `parent = …` query either way, so the two answer the same
// question in the same shape and nothing below here knows which one did.
//
// The tree used to be assembled in the browser out of every issue in the tracker, so it could not
// be drawn until all of them had arrived — the deepest possible dependency on a number that only
// grows. It never shows more than the levels somebody has unfolded, so those are what it asks for:
// the roots on arrival, and a node's children the first time it is opened. Every row carries its
// own `childCount`, so whether a node unfolds at all is known without reading the level beneath it.

interface Level {
  rows: IssueListRow[];
  loading: boolean;
  /** How many issues are at this level in total. A level is read as a single page, so a very wide
      one is shown in part — which has to be visible, or the tree quietly misrepresents the shape of
      the tracker. */
  total: number | null;
}

/** How many children one level shows at once — see the note on `Level.total`. */
const LEVEL_SIZE = 200;

/** Levels of the tree, read on demand and kept for as long as the view stays open. */
function useTreeLevels(query: IssuePageQuery) {
  const [levels, setLevels] = useState<Map<string, Level>>(() => new Map());
  const requested = useRef<Set<string>>(new Set());
  const key = JSON.stringify(query);
  // Bumped when the filters change, so a level read under the previous ones is discarded rather
  // than left hanging under a tree that no longer means the same thing.
  const generation = useRef(0);
  const local = useLocalFirst();
  const revision = useMirrorRevision();

  useEffect(() => {
    generation.current++;
    requested.current = new Set();
    setLevels(new Map());
  }, [key, local]);

  const read = useCallback((parent: number | "none", gen: number) => {
    const id = String(parent);
    const q = { ...query, parent, limit: LEVEL_SIZE };
    const pending = local
      ? mirrorList(q, LEVEL_SIZE).then((page) =>
          page ?? { issues: [], nextCursor: null, total: 0, stateCounts: null })
      : api.issuePage(q);
    pending
      .then((page) => {
        if (generation.current !== gen) return;
        setLevels((prev) => new Map(prev).set(id, { rows: page.issues, loading: false, total: page.total }));
      })
      .catch(() => {
        if (generation.current !== gen) return;
        setLevels((prev) => new Map(prev).set(id, { rows: [], loading: false, total: 0 }));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, local]);

  const load = useCallback((parent: number | "none") => {
    const id = String(parent);
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setLevels((prev) => new Map(prev).set(id, { rows: [], loading: true, total: null }));
    read(parent, generation.current);
  }, [read]);

  // The copy on the device moved, so every level already unfolded is showing something older than
  // what is stored. Re-reading all of them is what keeps an open tree honest when somebody else
  // files an issue under a node being looked at — and it costs nothing, because they are local
  // reads. On the web there is no such signal and this never runs.
  useEffect(() => {
    if (!local) return;
    const gen = generation.current;
    for (const id of requested.current) read(id === "none" ? "none" : Number(id), gen);
  }, [local, revision, read]);

  return { levels, load };
}

export function IssueTree({ query, labels }: { query: IssuePageQuery; labels: Label[] }) {
  const { levels, load } = useTreeLevels(query);
  // The roots are the one level nobody has to ask for.
  useEffect(() => { load("none"); }, [load]);

  const roots = levels.get("none");
  if (!roots || (roots.loading && roots.rows.length === 0)) {
    return (
      <div className="panel" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="skeleton-line" style={{ width: `${68 - i * 11}%` }} />
        ))}
      </div>
    );
  }
  if (roots.rows.length === 0) return <div className="panel muted">No issues.</div>;

  return (
    <div className="panel">
      {roots.rows.map((i) => (
        <TreeNode key={i.id} issue={i} levels={levels} load={load} labels={labels} depth={0}
          ancestors={new Set()} />
      ))}
      <TruncationNote level={roots} />
    </div>
  );
}

function TreeNode({
  issue, levels, load, labels, depth, ancestors,
}: {
  issue: IssueListRow;
  levels: Map<string, Level>;
  load: (parent: number | "none") => void;
  labels: Label[];
  depth: number;
  ancestors: Set<number>;
}) {
  const [expanded, setExpanded] = useState(false);
  // A parent chain that returns to an issue already above it would recurse forever. The data model
  // forbids that, but a view that renders whatever it is handed should not depend on it.
  const cyclic = ancestors.has(issue.id);
  const hasChildren = issue.childCount > 0 && !cyclic;
  const level = levels.get(String(issue.id));
  const labelOf = (id: number) => labels.find((l) => l.id === id);

  const toggle = () => {
    if (!expanded) load(issue.id);
    setExpanded((e) => !e);
  };

  return (
    <>
      <div className="tree-row" style={{ paddingLeft: depth * 22 }}>
        {hasChildren ? (
          <button className="tree-toggle" onClick={toggle} aria-expanded={expanded}>
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        <a href={`#/issues/${issue.id}`} className="tree-title">#{issue.id} <Markdown text={issue.title} inline /></a>
        {issue.locked && <LockedMark />}
        <span className={`badge ${issue.state}`}>{issue.state}</span>
        {issue.labels.map((l) => { const lbl = labelOf(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })}
        {hasChildren && (
          <span className="muted small">
            {issue.childCount} child{issue.childCount > 1 ? "ren" : ""}
          </span>
        )}
      </div>
      {expanded && level?.loading && (
        <div style={{ paddingLeft: (depth + 1) * 22 }}>
          <span className="skeleton-line" style={{ width: "40%" }} />
        </div>
      )}
      {expanded && level && !level.loading && level.rows.map((c) => (
        <TreeNode key={c.id} issue={c} levels={levels} load={load} labels={labels} depth={depth + 1}
          ancestors={new Set([...ancestors, issue.id])} />
      ))}
      {expanded && level && !level.loading && (
        <div style={{ paddingLeft: (depth + 1) * 22 }}><TruncationNote level={level} /></div>
      )}
    </>
  );
}

/** Says so when a level holds more than one page, rather than letting the tree imply that what is
    drawn is all there is. */
function TruncationNote({ level }: { level: Level }) {
  if (level.total == null || level.total <= level.rows.length) return null;
  return (
    <div className="muted small" style={{ padding: "4px 0" }}>
      Showing {level.rows.length.toLocaleString()} of {level.total.toLocaleString()} at this level —
      use the list view to filter them.
    </div>
  );
}
