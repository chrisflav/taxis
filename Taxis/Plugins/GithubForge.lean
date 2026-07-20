import Taxis.Plugins.Registry
import Taxis.Http.Client

/-!
# GitHub forge

Low-level GitHub access shared by the GitHub plugins: the request headers (including the
`ISSUES_GITHUB_TOKEN` bearer token, if configured), and a `RepoForge` that reads repository files
through `raw.githubusercontent.com` so dependency providers can inspect manifests.
-/

open Lean

namespace Taxis.Plugins

/-- Headers for a GitHub request, carrying `ISSUES_GITHUB_TOKEN` as a bearer token when set. -/
def githubHeaders : IO (Array (String × String)) := do
  let token ← IO.getEnv "ISSUES_GITHUB_TOKEN"
  let auth := token.map (fun t => #[("Authorization", s!"Bearer {t}")]) |>.getD #[]
  pure (#[("Accept", "application/vnd.github+json"), ("User-Agent", "issues-tracker")] ++ auth)

/-- Fetch a file from a GitHub repository. `ref` defaults to `HEAD`, which
    `raw.githubusercontent.com` resolves to the repository's default branch — so a repository can
    be attached without anyone having to name its branch. A 404 is reported as `ok none`: the
    file simply isn't there, which is how providers detect that a repository isn't theirs. -/
def githubFetchFile (repo : Repo.RepoRef) (path : String) : IO (Except String (Option String)) := do
  let ref := repo.ref.getD "HEAD"
  let url := s!"https://raw.githubusercontent.com/{repo.owner}/{repo.name}/{ref}/{path}"
  -- Raw content, not the JSON API, so the `Accept` header from `githubHeaders` doesn't apply.
  let headers := (← githubHeaders).filter (fun (k, _) => k != "Accept")
  match ← Http.request "GET" url headers with
  | .error e => return .error e
  | .ok resp =>
    if resp.status == 404 then return .ok none
    if resp.status < 200 || resp.status >= 300 then
      return .error s!"HTTP {resp.status} fetching {path}"
    return .ok (some resp.body)

def githubForge : RepoForge where
  hosts := #["github.com", "www.github.com"]
  fetchFile := githubFetchFile

initialize registerRepoForge githubForge

end Taxis.Plugins
