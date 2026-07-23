import type { ReactNode } from "react";
import type { IssueIndexEntry } from "../types";
import { ancestorsOf, issueLabel, siblingsOf, type Nameable } from "../breadcrumbs";

// The trail names the places *above* you, not where you are: every crumb is a link, and the page's
// own heading is the last step. That keeps it honest (a crumb you can't navigate to isn't a step in
// a path) and stops the current issue's title being printed twice, once in the trail and again in
// the `<h2>` directly beneath it.
//
// Separators are real `aria-hidden` spans rather than a CSS `::before`: browsers expose generated
// content to the accessibility tree, so a styled separator gets read out as "slash" between every
// crumb.
function Trail({ crumbs }: { crumbs: { href: string; text: string }[] }) {
  return (
    <nav className="breadcrumbs small" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((c, i) => (
          <li key={c.href}>
            {i > 0 && <span className="crumb-sep" aria-hidden="true">/</span>}
            <a href={c.href} title={c.text}>{c.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// "Issues" always means "show every issue again" — "?reset=1" tells the list to bypass its usual
// last-used-view restoration for this one navigation.
const ROOT = { href: "#/issues?reset=1", text: "Issues" };

// Crumbs for one ancestor chain, named the same way everywhere: `#id title`. Titles are reduced to
// plain text by `issueLabel` — a markdown link in a title would otherwise nest inside the crumb's
// own link.
function ancestorCrumbs(chain: IssueIndexEntry[]) {
  return chain.map((a) => ({ href: `#/issues/${a.id}`, text: issueLabel(a) }));
}

// Ancestor-chain breadcrumbs for the issue detail view: Issues / grandparent / parent. Walks the
// lightweight issue index rather than the full issue list — naming an ancestor needs nothing else.
//
// Takes a `Nameable`, not an `Issue`: the trail is built from an id, a title and a parent, so the
// detail page can draw it from its index entry before the issue itself has arrived.
export function IssueBreadcrumbs({ issue, index }: { issue: Nameable; index: IssueIndexEntry[] }) {
  const byId = new Map(index.map((i) => [i.id, i]));
  const chain = ancestorsOf({ id: issue.id, title: issue.title, parent: issue.parent }, byId);
  return <Trail crumbs={[ROOT, ...ancestorCrumbs(chain)]} />;
}

// Breadcrumbs for the issue list/tree tab. The unfiltered list is the root itself, so it gets no
// trail at all rather than a lone "Issues" crumb repeating its own heading; filtered to a single
// parent's children, the trail is the chain down to and including that parent.
export function ListBreadcrumbs({ parentId, index }: { parentId: number | null; index: IssueIndexEntry[] }) {
  const byId = new Map(index.map((i) => [i.id, i]));
  const parent = parentId != null ? byId.get(parentId) : undefined;
  if (!parent) return null;

  const chain = ancestorsOf(parent, byId);
  return <Trail crumbs={[ROOT, ...ancestorCrumbs([...chain, parent])]} />;
}

// Movement across one generation of the containment tree. Without it the only route from an issue
// to the one beside it is up to the parent, down into a filtered list, and back — three navigations
// to reach a neighbour. Every issue's parent is already in the index, so this costs no extra read.
export function SiblingNav({ issue, index }: { issue: Nameable; index: IssueIndexEntry[] }) {
  const siblings = siblingsOf({ id: issue.id, title: issue.title, parent: issue.parent }, index);
  const pos = siblings.findIndex((s) => s.id === issue.id);
  // Nothing to move between: a top-level issue, or an only child.
  if (siblings.length < 2 || pos < 0) return null;

  const step = (target: IssueIndexEntry | undefined, label: string, glyph: string): ReactNode =>
    target
      ? <a href={`#/issues/${target.id}`} title={issueLabel(target)}>{glyph} {label}</a>
      : <span className="muted" aria-hidden="true">{glyph} {label}</span>;

  return (
    <nav className="sibling-nav small muted" aria-label="Sibling issues">
      {step(siblings[pos - 1], "Previous", "◂")}
      <span>{pos + 1} of {siblings.length}</span>
      {step(siblings[pos + 1], "Next", "▸")}
    </nav>
  );
}
