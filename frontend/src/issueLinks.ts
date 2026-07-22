import type { IssueIndexEntry } from "./types";

// Turn bare `#123` issue references into markdown links (`[#123 Some title](#/issues/123)` when
// the referenced issue is known, else plain `[#123](#/issues/123)`), skipping fenced code blocks
// and inline code spans so code samples aren't rewritten. Deliberately requires the `#` to be
// preceded by a non-word character (or the start of the string) and followed immediately by
// digits — this is what tells it apart from markdown heading syntax (`# Heading` always has a
// space after the `#`).
export function linkifyIssueRefs(text: string, issues: IssueIndexEntry[] = []): string {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const linkText = (num: string) => {
    const title = byId.get(Number(num))?.title;
    // Square brackets in the title would break the markdown link syntax being built here.
    return title ? `#${num} ${title.replace(/[[\]]/g, "")}` : `#${num}`;
  };
  const fenceParts = text.split(/(```[\s\S]*?```)/g);
  return fenceParts
    .map((part, i) => {
      if (i % 2 === 1) return part; // fenced code block, untouched
      const spanParts = part.split(/(`[^`]*`)/g);
      return spanParts
        .map((sp, j) => {
          if (j % 2 === 1) return sp; // inline code span, untouched
          return sp.replace(/(^|[^\w#])#(\d+)\b/g, (_m, pre, num) => `${pre}[${linkText(num)}](#/issues/${num})`);
        })
        .join("");
    })
    .join("");
}
