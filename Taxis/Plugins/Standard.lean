import Taxis.Plugins.Registry
import Taxis.Db

/-!
# Standard plugins

Built-in kinds that need no external service, only the tracker's own database:

* check `dependencies-complete` — are every one of the issue's dependencies closed/completed?
* check `review-approved` — is the most recent review comment on the issue an approval?
  (see `Taxis.ReviewState`, set on a comment via `Taxis.CommentInput.review`)
* artifact `repository` — a link to a source repository (GitHub or otherwise), e.g. for an issue
  that represents a whole project.
-/

open Lean

namespace Taxis.Plugins

/-- Evaluate whether every dependency of `issue` is closed or completed. Dependencies that no
    longer exist are ignored (nothing to block on). -/
def dependenciesCompleteEvaluate (db : Db.Conn) (_config : Json) (issue : Issue) (_artifacts : Array Artifact) :
    IO (CheckStatus × Option String) := do
  if issue.dependencies.isEmpty then
    return (.passing, some "no dependencies")
  let mut incomplete : Array String := #[]
  for depId in issue.dependencies do
    match ← Db.getIssue db depId with
    | none => pure ()
    | some dep =>
      if dep.state == .open then
        incomplete := incomplete.push s!"#{dep.id.val}"
  if incomplete.isEmpty then
    return (.passing, some s!"all {issue.dependencies.size} dependencies closed/completed")
  else
    return (.failing, some s!"still open: {", ".intercalate incomplete.toList}")

def dependenciesCompleteHandler : CheckHandler where
  kind := "dependencies-complete"
  fields := #[]
  evaluate := dependenciesCompleteEvaluate

/-- Evaluate whether the most recent review comment on the issue approves it. -/
def reviewApprovedEvaluate (db : Db.Conn) (_config : Json) (issue : Issue) (_artifacts : Array Artifact) :
    IO (CheckStatus × Option String) := do
  let comments ← Db.issueComments db issue.id
  -- `issueComments` returns oldest-first; the most recent review is the last one after filtering.
  match (comments.filter (·.review.isSome)).toList.reverse.head? with
  | none => return (.failing, some "no review yet")
  | some c => match c.review with
    | some .approve => return (.passing, some s!"approved by {c.authorName.getD "someone"}")
    | some .requestChanges => return (.failing, some s!"changes requested by {c.authorName.getD "someone"}")
    | none => return (.error, some "unreachable: filtered on review.isSome")

def reviewApprovedHandler : CheckHandler where
  kind := "review-approved"
  fields := #[]
  evaluate := reviewApprovedEvaluate

private def repositoryDisplay (j : Json) : ArtifactDisplay :=
  let url := (j.getObjValAs? String "url").toOption
  let label := (j.getObjValAs? String "name").toOption
    |>.orElse (fun _ => url)
    |>.getD "repository"
  { label, url }

/-- Artifact: a link to a source repository (GitHub or otherwise).

    Repositories attached this way are the nodes of the repository dependency graph, so the
    payload also carries the two hints that graph's edge derivation can use: which revision to
    read the package manifests at, and which ecosystem's provider to ask. Both are optional —
    left blank, the default branch is read and every provider gets a turn. -/
def repositoryHandler : ArtifactHandler where
  kind := "repository"
  fields := #[
    { name := "url", label := "Repository URL", required := true, placeholder := some "https://github.com/owner/repo" },
    { name := "name", label := "Display name", placeholder := some "owner/repo" },
    { name := "ref", label := "Branch or tag", placeholder := some "main",
      help := some "Revision the dependency graph reads manifests at. Defaults to the default branch." },
    { name := "ecosystem", label := "Ecosystem", placeholder := some "lake",
      help := some "Pin which dependency provider is used. Leave blank to detect automatically." }]
  validate j := do
    let url ← j.getObjValAs? String "url"
    if (Repo.RepoRef.parse? url).isNone then
      throw s!"could not read an owner/repository out of '{url}'"
  render := repositoryDisplay

initialize registerCheckHandler dependenciesCompleteHandler
initialize registerCheckHandler reviewApprovedHandler
initialize registerArtifactHandler repositoryHandler

end Taxis.Plugins
