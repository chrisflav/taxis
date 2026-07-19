import Taxis.Plugins.Registry
import Taxis.Http.Client

/-!
# GitHub plugins

Built-in artifact kinds `github-pr` and `github-branch`, plus a `github-ci` check that reads the
combined commit status of an attached branch via the GitHub API. A `ISSUES_GITHUB_TOKEN`
environment variable, if set, is sent as a bearer token.
-/

open Lean

namespace Taxis.Plugins

private def reqString (j : Json) (field : String) : Except String Unit := do
  let _ ← j.getObjValAs? String field
  pure ()

private def str? (j : Json) (field : String) : Option String := (j.getObjValAs? String field).toOption

private def githubPrDisplay (j : Json) : ArtifactDisplay :=
  { label := "Pull request", url := str? j "url" }

private def githubIssueDisplay (j : Json) : ArtifactDisplay :=
  { label := s!"gh#{(j.getObjValAs? Nat "number").toOption.map toString |>.getD "?"}", url := str? j "url" }

private def githubBranchDisplay (j : Json) : ArtifactDisplay :=
  let g (f : String) := str? j f |>.getD "?"
  { label := s!"{g "owner"}/{g "repo"}@{g "branch"}",
    url := some s!"https://github.com/{g "owner"}/{g "repo"}/tree/{g "branch"}" }

/-- Artifact: a pull request on GitHub, identified by its URL. -/
def githubPrHandler : ArtifactHandler where
  kind := "github-pr"
  fields := #[{ name := "url", label := "Pull request URL", required := true, placeholder := some "https://github.com/owner/repo/pull/123" }]
  validate j := reqString j "url"
  render := githubPrDisplay

/-- Artifact: the source GitHub issue an imported issue came from. -/
def githubIssueHandler : ArtifactHandler where
  kind := "github-issue"
  fields := #[{ name := "url", label := "Issue URL", required := true, placeholder := some "https://github.com/owner/repo/issues/123" }, { name := "number", label := "Issue number", type := "number" }]
  validate j := reqString j "url"
  render := githubIssueDisplay

/-- Artifact: a branch on a GitHub repository. -/
def githubBranchHandler : ArtifactHandler where
  kind := "github-branch"
  fields := #[{ name := "owner", label := "Owner", required := true, placeholder := some "leanprover" }, { name := "repo", label := "Repository", required := true, placeholder := some "lean4" }, { name := "branch", label := "Branch", required := true, placeholder := some "master" }]
  validate j := do reqString j "owner"; reqString j "repo"; reqString j "branch"
  render := githubBranchDisplay

/-- Evaluate the GitHub combined commit status of an attached `github-branch` artifact. -/
def githubCiEvaluate (_db : Db.Conn) (_config : Json) (_issue : Issue) (artifacts : Array Artifact) :
    IO (CheckStatus × Option String) := do
  match artifacts.find? (·.kind == "github-branch") with
  | none => return (.error, some "no github-branch artifact attached to evaluate CI against")
  | some art =>
    let p := art.payload
    let get (f : String) := (p.getObjValAs? String f).toOption
    match get "owner", get "repo", get "branch" with
    | some owner, some repo, some branch =>
      let token ← IO.getEnv "ISSUES_GITHUB_TOKEN"
      let auth := token.map (fun t => #[("Authorization", s!"Bearer {t}")]) |>.getD #[]
      let headers := #[("Accept", "application/vnd.github+json"), ("User-Agent", "issues-tracker")] ++ auth
      let url := s!"https://api.github.com/repos/{owner}/{repo}/commits/{branch}/status"
      match ← Http.requestJson "GET" url headers with
      | .error e => return (.error, some e)
      | .ok j =>
        let state := (j.getObjValAs? String "state").toOption.getD "unknown"
        let status := match state with
          | "success" => CheckStatus.passing
          | "failure" => CheckStatus.failing
          | "pending" => CheckStatus.pending
          | _ => CheckStatus.error
        return (status, some s!"combined commit status: {state}")
    | _, _, _ => return (.error, some "github-branch payload missing owner/repo/branch")

/-- Check: CI status on an attached GitHub branch. -/
def githubCiHandler : CheckHandler where
  kind := "github-ci"
  fields := #[]
  evaluate := githubCiEvaluate

/-- Pull the `(owner, repo, number)` out of a GitHub PR URL like
    `https://github.com/owner/repo/pull/123`. -/
private def parsePrUrl (url : String) : Option (String × String × String) :=
  match url.splitOn "github.com/" with
  | [_, rest] =>
    match rest.splitOn "/" with
    | owner :: repo :: "pull" :: number :: _ =>
      if owner.isEmpty || repo.isEmpty || number.isEmpty then none
      else some (owner, repo, number)
    | _ => none
  | _ => none

/-- Evaluate whether an attached `github-pr` artifact has been merged (passing), closed without
    merging (failing), or is still open (pending). -/
def githubPrStatusEvaluate (_db : Db.Conn) (_config : Json) (_issue : Issue) (artifacts : Array Artifact) :
    IO (CheckStatus × Option String) := do
  match artifacts.find? (·.kind == "github-pr") with
  | none => return (.error, some "no github-pr artifact attached to check")
  | some art =>
    match (art.payload.getObjValAs? String "url").toOption with
    | none => return (.error, some "github-pr artifact missing 'url'")
    | some url =>
      match parsePrUrl url with
      | none => return (.error, some s!"could not parse a GitHub PR url from '{url}'")
      | some (owner, repo, number) =>
        let token ← IO.getEnv "ISSUES_GITHUB_TOKEN"
        let auth := token.map (fun t => #[("Authorization", s!"Bearer {t}")]) |>.getD #[]
        let headers := #[("Accept", "application/vnd.github+json"), ("User-Agent", "issues-tracker")] ++ auth
        let apiUrl := s!"https://api.github.com/repos/{owner}/{repo}/pulls/{number}"
        match ← Http.requestJson "GET" apiUrl headers with
        | .error e => return (.error, some e)
        | .ok j =>
          let state := (j.getObjValAs? String "state").toOption.getD "unknown"
          let merged := (j.getObjValAs? Bool "merged").toOption.getD false
          if merged then return (.passing, some "merged")
          else if state == "closed" then return (.failing, some "closed without merging")
          else return (.pending, some s!"still {state}")

/-- Check: whether an attached GitHub pull request has been merged. -/
def githubPrStatusHandler : CheckHandler where
  kind := "github-pr-status"
  fields := #[]
  evaluate := githubPrStatusEvaluate

initialize registerArtifactHandler githubPrHandler
initialize registerArtifactHandler githubIssueHandler
initialize registerArtifactHandler githubBranchHandler
initialize registerCheckHandler githubCiHandler
initialize registerCheckHandler githubPrStatusHandler

end Taxis.Plugins
