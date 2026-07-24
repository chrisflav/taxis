// Only the naming fields are needed here, so these work over a full `Issue`, a list row or an
// `IssueIndexEntry` — the last being all any of this ever needed.
//
// What used to live alongside these — walking an ancestor chain, labelling an option by its whole
// path, finding an issue's siblings — is gone: every one of them was a computation over a copy of
// the entire tracker, and every one is now a question the server answers about the handful of
// issues actually involved (`IssueDetail.ancestors`, `IssueDetail.siblings`, `/issues/{id}/ancestors`).
export interface Nameable {
  id: number;
  title: string;
  parent: number | null;
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
