import type { Issue } from "./types";

// The chain of ancestors from the top-level issue down to (but excluding) `issue` itself, safe
// against cycles and missing/filtered-out parents.
export function ancestorsOf(issue: Issue, byId: Map<number, Issue>): Issue[] {
  const chain: Issue[] = [];
  const seen = new Set<number>([issue.id]);
  let cur = issue;
  while (cur.parent != null && !seen.has(cur.parent)) {
    const p = byId.get(cur.parent);
    if (!p) break;
    chain.unshift(p);
    seen.add(p.id);
    cur = p;
  }
  return chain;
}

// A plain-text "ancestor / ancestor / #id title" label, used inside dropdown option lists where a
// full breadcrumb component would be too heavy.
export function breadcrumbLabel(issue: Issue, allIssues: Issue[]): string {
  const byId = new Map(allIssues.map((i) => [i.id, i]));
  const chain = ancestorsOf(issue, byId);
  const path = chain.map((a) => a.title).join(" / ");
  return path ? `${path} / #${issue.id} ${issue.title}` : `#${issue.id} ${issue.title}`;
}
