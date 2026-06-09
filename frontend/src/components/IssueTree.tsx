import { useState } from "react";
import type { Issue, Label } from "../types";
import { LabelChip } from "./LabelChip";

// Hierarchical view. Top-level nodes are foundational issues (those that depend on nothing);
// unfolding a node reveals the issues that depend on it, indented, one dependency-chain step
// at a time.
export function IssueTree({ issues, labels }: { issues: Issue[]; labels: Label[] }) {
  // Map each issue id to the issues that list it as a parent (i.e. that depend on it).
  const childrenByParent = new Map<number, Issue[]>();
  issues.forEach((i) =>
    i.parents.forEach((p) => {
      if (!childrenByParent.has(p)) childrenByParent.set(p, []);
      childrenByParent.get(p)!.push(i);
    })
  );
  // Roots are issues with no dependency present in this (possibly filtered) set, so every
  // matching issue appears — as a root or nested under a visible dependency.
  const idSet = new Set(issues.map((i) => i.id));
  const topLevel = issues.filter((i) => !i.parents.some((p) => idSet.has(p)));

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
        <a href={`#/issues/${issue.id}`} className="tree-title">#{issue.id} {issue.title}</a>
        {issue.locked && <span title="locked">🔒</span>}
        <span className={`badge ${issue.state}`}>{issue.state}</span>
        {issue.labels.map((l) => { const lbl = labelOf(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })}
        {hasChildren && <span className="muted small">{children.length} dependent{children.length > 1 ? "s" : ""}</span>}
      </div>
      {expanded && !cyclic &&
        children.map((c) => (
          <TreeNode key={c.id} issue={c} childrenByParent={childrenByParent} labels={labels} depth={depth + 1} ancestors={new Set([...ancestors, issue.id])} />
        ))}
    </>
  );
}
