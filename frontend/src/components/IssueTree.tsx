import { useState } from "react";
import { LockedMark } from "./Icon";
import type { Issue, Label } from "../types";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";

// Hierarchical view over the single `parent` (containment) relation. Top-level nodes are issues
// with no parent present in the set; unfolding a node reveals its child issues, indented.
export function IssueTree({ issues, labels }: { issues: Issue[]; labels: Label[] }) {
  // Map each issue id to the issues whose parent is it (i.e. its children).
  const childrenByParent = new Map<number, Issue[]>();
  issues.forEach((i) => {
    if (i.parent == null) return;
    if (!childrenByParent.has(i.parent)) childrenByParent.set(i.parent, []);
    childrenByParent.get(i.parent)!.push(i);
  });
  // Roots are issues with no parent present in this (possibly filtered) set, so every matching
  // issue appears — as a root or nested under its visible parent.
  const idSet = new Set(issues.map((i) => i.id));
  const topLevel = issues.filter((i) => i.parent == null || !idSet.has(i.parent));

  if (topLevel.length === 0) return <div className="panel muted">No issues.</div>;

  return (
    <div className="panel">
      {topLevel.map((i) => (
        <TreeNode key={i.id} issue={i} childrenByParent={childrenByParent} labels={labels} depth={0} ancestors={new Set()} />
      ))}
    </div>
  );
}

function TreeNode({
  issue, childrenByParent, labels, depth, ancestors,
}: {
  issue: Issue;
  childrenByParent: Map<number, Issue[]>;
  labels: Label[];
  depth: number;
  ancestors: Set<number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = childrenByParent.get(issue.id) ?? [];
  const hasChildren = children.length > 0;
  const labelOf = (id: number) => labels.find((l) => l.id === id);
  const cyclic = ancestors.has(issue.id);

  return (
    <>
      <div className="tree-row" style={{ paddingLeft: depth * 22 }}>
        {hasChildren && !cyclic ? (
          <button className="tree-toggle" onClick={() => setExpanded((e) => !e)}>{expanded ? "▾" : "▸"}</button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        <a href={`#/issues/${issue.id}`} className="tree-title">#{issue.id} <Markdown text={issue.title} inline /></a>
        {issue.locked && <LockedMark />}
        <span className={`badge ${issue.state}`}>{issue.state}</span>
        {issue.labels.map((l) => { const lbl = labelOf(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })}
        {hasChildren && <span className="muted small">{children.length} child{children.length > 1 ? "ren" : ""}</span>}
      </div>
      {expanded && !cyclic &&
        children.map((c) => (
          <TreeNode key={c.id} issue={c} childrenByParent={childrenByParent} labels={labels} depth={depth + 1} ancestors={new Set([...ancestors, issue.id])} />
        ))}
    </>
  );
}
