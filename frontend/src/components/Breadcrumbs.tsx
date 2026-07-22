import type { ReactNode } from "react";
import type { Issue, IssueIndexEntry } from "../types";
import { ancestorsOf } from "../breadcrumbs";
import { loadStoredViewState } from "../filters";
import { Markdown } from "./Markdown";

// The shared "Issues / ancestor / ancestor" prefix, linkified. `tail` is whatever comes after it
// (a plain string, a link, or nothing). The "Issues" root always means "show every issue again" —
// "?reset=1" tells the list to bypass its usual last-used-view restoration for this one navigation.
function AncestorCrumbs({ chain, tail }: { chain: IssueIndexEntry[]; tail?: ReactNode }) {
  return (
    <nav className="breadcrumbs small muted">
      <a href="#/issues?reset=1">Issues</a>
      {chain.map((a) => (
        <span key={a.id}>
          {" / "}
          <a href={`#/issues/${a.id}`}><Markdown text={a.title} inline /></a>
        </span>
      ))}
      {tail}
    </nav>
  );
}

// Ancestor-chain breadcrumbs for the issue detail view: Issues / grandparent / parent / #id, plus
// a trailing crumb linking to this issue's children in the list. Walks the lightweight issue
// index rather than the full issue list — naming an ancestor needs nothing else.
export function IssueBreadcrumbs({ issue, index }: { issue: Issue; index: IssueIndexEntry[] }) {
  const byId = new Map(index.map((i) => [i.id, i]));
  const chain = ancestorsOf({ id: issue.id, title: issue.title, parent: issue.parent }, byId);
  const childCount = index.filter((i) => i.parent === issue.id).length;
  // Carry over whatever state filter (open/closed/completed/any) was last selected on the issue
  // list, rather than forcing it back to "any" — only the parent changes, not the state you were
  // looking at.
  const lastState = loadStoredViewState()?.filters.state ?? "";

  return (
    <AncestorCrumbs
      chain={chain}
      tail={
        <>
          {" / "}
          <span className="breadcrumb-current">#{issue.id} <Markdown text={issue.title} inline /></span>
          {" / "}
          <a href={`#/issues?parents=${issue.id}&state=${lastState}`}>Children{childCount > 0 ? ` (${childCount})` : ""}</a>
        </>
      }
    />
  );
}

// Breadcrumbs for the issue list/tree tab, always shown: plain "Issues" by default, or — when
// filtered to a single parent's children (e.g. via the detail view's "Children" link) — the
// ancestor chain down to that parent, ending in a non-linked "Children" crumb for the current view.
export function ListBreadcrumbs({ parentId, index }: { parentId: number | null; index: IssueIndexEntry[] }) {
  const byId = new Map(index.map((i) => [i.id, i]));
  const parent = parentId != null ? byId.get(parentId) : undefined;

  if (!parent) {
    return <nav className="breadcrumbs small muted"><span className="breadcrumb-current">Issues</span></nav>;
  }

  const chain = ancestorsOf(parent, byId);
  return (
    <AncestorCrumbs
      chain={chain}
      tail={
        <>
          {" / "}
          <a href={`#/issues/${parent.id}`}><Markdown text={`#${parent.id} ${parent.title}`} inline /></a>
          {" / "}
          <span className="breadcrumb-current">Children</span>
        </>
      }
    />
  );
}
