import type { ReactNode } from "react";
import type { IssueIndexEntry, SiblingNav as SiblingNavData } from "../types";
import { api, paths } from "../api";
import { EMPTY, REFERENCE_MAX_AGE, useResource } from "../cache";
import { issueLabel } from "../breadcrumbs";
import { useIssueName } from "../issueNames";

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

// Ancestor-chain breadcrumbs for the issue detail view: Issues / grandparent / parent.
//
// The chain arrives with the issue. Walking it in the browser meant holding every issue's parent —
// a naming index of the whole tracker, fetched on every page load to draw two or three crumbs —
// and the server can climb the chain in a single statement.
export function IssueBreadcrumbs({ ancestors }: { ancestors: IssueIndexEntry[] }) {
  return <Trail crumbs={[ROOT, ...ancestorCrumbs(ancestors)]} />;
}

// Breadcrumbs for the issue list/tree tab. The unfiltered list is the root itself, so it gets no
// trail at all rather than a lone "Issues" crumb repeating its own heading; filtered to a single
// parent's children, the trail is the chain down to and including that parent.
//
// This is the one place a chain is wanted for an issue the view is not otherwise reading, so it
// asks for one — and only while a parent filter is actually active.
export function ListBreadcrumbs({ parentId }: { parentId: number | null }) {
  const chain = useResource<IssueIndexEntry[]>(
    parentId != null ? paths.ancestors(parentId) : null,
    () => api.issueAncestors(parentId!),
    REFERENCE_MAX_AGE,
  ).data ?? EMPTY;
  // The parent's own name, which the chain above it does not include. Batched with whatever else
  // on the page needs naming, and usually free: it was a row in the list you clicked to get here.
  const parent = useIssueName(parentId);
  if (parentId == null) return null;

  const self = parent ?? { id: parentId, title: "", parent: null };
  return <Trail crumbs={[ROOT, ...ancestorCrumbs([...chain, self])]} />;
}

// Movement across one generation of the containment tree. Without it the only route from an issue
// to the one beside it is up to the parent, down into a filtered list, and back — three navigations
// to reach a neighbour.
//
// Which issue is next is a question about the containment tree, so the server answers it: the
// detail response carries the position, the count and the two neighbours. The client used to work
// it out by filtering every issue in the tracker by parent.
export function SiblingNav({ nav }: { nav: SiblingNavData | undefined }) {
  // Nothing to move between: a top-level issue, or an only child.
  if (!nav || nav.count < 2 || nav.position < 1) return null;

  const step = (target: IssueIndexEntry | null, label: string, glyph: string): ReactNode =>
    target
      ? <a href={`#/issues/${target.id}`} title={issueLabel(target)}>{glyph} {label}</a>
      : <span className="muted" aria-hidden="true">{glyph} {label}</span>;

  return (
    <nav className="sibling-nav small muted" aria-label="Sibling issues">
      {step(nav.prev, "Previous", "◂")}
      <span>{nav.position} of {nav.count}</span>
      {step(nav.next, "Next", "▸")}
    </nav>
  );
}
