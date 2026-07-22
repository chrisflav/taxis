// Only the naming fields are needed here, so these work over both a full `Issue` and an
// `IssueIndexEntry` — which is what views hold once they stop fetching every issue.
export interface Nameable {
  id: number;
  title: string;
  parent: number | null;
}

// The chain of ancestors from the top-level issue down to (but excluding) `issue` itself, safe
// against cycles and missing/filtered-out parents.
export function ancestorsOf<T extends Nameable>(issue: T, byId: Map<number, T>): T[] {
  const chain: T[] = [];
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
//
// Takes the lookup map rather than the array: building one map per issue made labelling a whole
// dropdown quadratic, and these are rebuilt on every keystroke in the filter bar.
export function breadcrumbLabel<T extends Nameable>(issue: T, byId: Map<number, T>): string {
  const chain = ancestorsOf(issue, byId);
  const path = chain.map((a) => a.title).join(" / ");
  return path ? `${path} / #${issue.id} ${issue.title}` : `#${issue.id} ${issue.title}`;
}

/** Label every entry once, sharing a single lookup map. */
export function breadcrumbOptions<T extends Nameable>(entries: T[]): { value: number; label: string }[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return entries.map((e) => ({ value: e.id, label: breadcrumbLabel(e, byId) }));
}
