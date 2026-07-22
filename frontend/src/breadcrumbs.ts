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

// Titles are markdown, but a breadcrumb crumb and a filter chip are single-line plain-text slots.
// Rendering markdown there nests an `<a>` inside the crumb's own link — invalid, and the inner
// link steals the click — so those callers reduce a title to its text first.
//
// Only the constructs that actually break or read badly are stripped. `_` is deliberately left
// alone: issue titles are full of `snake_case` identifiers, and mangling those to look slightly
// tidier is the worse trade.
export function plainTitle(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> link text
    .replace(/`+([^`]+)`+/g, "$1") // code spans
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/\*([^*\n]+)\*/g, "$1") // italics
    .replace(/~~([^~]+)~~/g, "$1") // strikethrough
    .replace(/\s+/g, " ")
    .trim();
}

/** How an issue is named wherever it is referred to rather than displayed: `#12 Some title`. */
export function issueLabel<T extends Nameable>(issue: T): string {
  return `#${issue.id} ${plainTitle(issue.title)}`;
}

// A plain-text "ancestor / ancestor / #id title" label, used inside dropdown option lists where a
// full breadcrumb component would be too heavy.
//
// Takes the lookup map rather than the array: building one map per issue made labelling a whole
// dropdown quadratic, and these are rebuilt on every keystroke in the filter bar.
export function breadcrumbLabel<T extends Nameable>(issue: T, byId: Map<number, T>): string {
  const chain = ancestorsOf(issue, byId);
  const path = chain.map((a) => plainTitle(a.title)).join(" / ");
  return path ? `${path} / ${issueLabel(issue)}` : issueLabel(issue);
}

/** Label every entry once, sharing a single lookup map.
 *
 *  Two labels per entry, because the two places an option appears want different things: an open
 *  dropdown is a disambiguation problem, so it gets the whole ancestor path, while the chip left
 *  behind after choosing is an identity problem in a one-line slot, so it gets just `#id title`.
 *  Handing the chip the path is what used to wrap it over six lines and break the filter row. */
export function breadcrumbOptions<T extends Nameable>(
  entries: T[],
): { value: number; label: string; chipLabel: string }[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return entries.map((e) => ({
    value: e.id,
    label: breadcrumbLabel(e, byId),
    chipLabel: issueLabel(e),
  }));
}

/** The issues sharing `issue`'s parent, in issue-number order, including `issue` itself. Empty
    when it has no parent — a top-level issue has no sibling set to walk. */
export function siblingsOf<T extends Nameable>(issue: T, entries: T[]): T[] {
  if (issue.parent == null) return [];
  return entries.filter((e) => e.parent === issue.parent).sort((a, b) => a.id - b.id);
}
