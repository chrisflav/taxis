import Issues.Domain
import Issues.Http.Client

/-!
# GitHub issue import

Fetches issues from a GitHub repository and maps them to tracker `IssueInput`s, remembering the
source URL and number so the importer can attach a `github-issue` artifact. Pull requests
(which the issues endpoint also returns) are skipped.
-/

open Lean

namespace Issues.Import

/-- A GitHub issue mapped for import, with provenance for the source artifact. The label names
    are resolved to tracker labels by the importer. -/
structure GithubIssueImport where
  input : IssueInput
  labelNames : Array String
  url : String
  number : Nat

private def labelNames (item : Json) : Array String := Id.run do
  let some labels := (item.getObjVal? "labels").toOption | return #[]
  let some arr := labels.getArr?.toOption | return #[]
  return arr.filterMap (fun l => (l.getObjValAs? String "name").toOption)

/-- Fetch and map issues from `owner/repo`. `state` is one of `open`, `closed`, `all`. -/
def fetchGithubIssues (owner repo state : String) : IO (Except String (Array GithubIssueImport)) := do
  let token ← IO.getEnv "ISSUES_GITHUB_TOKEN"
  let auth := token.map (fun t => #[("Authorization", s!"Bearer {t}")]) |>.getD #[]
  let headers := #[("Accept", "application/vnd.github+json"), ("User-Agent", "issues-tracker")] ++ auth
  let url := s!"https://api.github.com/repos/{owner}/{repo}/issues?state={state}&per_page=50"
  match ← Http.requestJson "GET" url headers with
  | .error e => return .error e
  | .ok j =>
    match j.getArr? with
    | .error _ => return .error "unexpected GitHub response (expected a JSON array)"
    | .ok arr =>
      let mut out := #[]
      for item in arr do
        -- The issues endpoint also returns PRs; skip anything with a `pull_request` field.
        if (item.getObjVal? "pull_request").toOption.isSome then continue
        let title := (item.getObjValAs? String "title").toOption.getD "(untitled)"
        let body := (item.getObjValAs? String "body").toOption.getD ""
        let ghState := (item.getObjValAs? String "state").toOption.getD "open"
        let state := if ghState == "closed" then IssueState.closed else IssueState.open
        let number := (item.getObjValAs? Nat "number").toOption.getD 0
        let htmlUrl := (item.getObjValAs? String "html_url").toOption.getD ""
        out := out.push {
          input := { title, description := body, state }
          labelNames := labelNames item
          url := htmlUrl, number }
      return .ok out

end Issues.Import
