import Taxis.Plugins
import Taxis.Db

/-!
# The repository an issue is about

An issue rarely says which repository its prose is talking about, and it rarely has to: it is
attached to one, or it is filed under something that is. `issueRepo?` makes that implicit context
explicit — the repository named by the issue's own artifacts, or, failing that, by the nearest
ancestor that names one.

Which artifacts name a repository is not decided here. Each artifact kind answers for itself
through `Plugins.ArtifactHandler.repo?`, so a `repository`, a `github-pr`, a `github-branch` and a
`source` all serve, and a kind added later serves without this module learning about it.

What reads it: the frontend renders a bare `PR#123` in an issue's description, goal or comments as
a link into that repository's pull requests, the way `#123` is rendered as a link to an issue.
-/

open Lean

namespace Taxis.Repo

/-- The repository an artifact names, according to the handler registered for its kind. -/
def artifactRepo? (a : Artifact) : IO (Option RepoRef) := do
  match ← Plugins.artifactHandler? a.kind with
  | some h => pure (h.repo? a.payload)
  | none => pure none

/-- The repository named by an issue's own artifacts — the first one that names any, in the order
    they were attached. Several artifacts may name repositories (a PR and the repository it is
    against, say); the earliest is the one the issue was set up around. -/
def ownRepo? (db : Db.Conn) (id : IssueId) : IO (Option RepoRef) := do
  for artifact in ← Db.issueArtifacts db id do
    if let some ref ← artifactRepo? artifact then return some ref
  return none

/-- The repository an issue is about: named by one of its own artifacts, or by the nearest
    ancestor that names one.

    Inheritance up the containment chain is the point. A repository is attached once, to the issue
    that stands for the project or the epic, and everything filed under it is about that
    repository without having to repeat the attachment on every child.

    `actorGroups` is the reader's, and is the same visibility rule the breadcrumb trail uses:
    `issueAncestors` stops at the first ancestor the reader may not see, so a repository is never
    inherited through an issue whose existence is hidden from them. -/
def issueRepo? (db : Db.Conn) (id : IssueId) (actorGroups : Option (Array GroupId)) :
    IO (Option RepoRef) := do
  if let some ref ← ownRepo? db id then return some ref
  -- Root-first as it comes back, so reversed to walk outwards from the issue: the nearest
  -- ancestor's answer is the one that wins.
  for ancestor in (← Db.issueAncestors db id actorGroups).reverse do
    if let some ref ← ownRepo? db ancestor.id then return some ref
  return none

end Taxis.Repo
