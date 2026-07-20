import Taxis.Json

/-!
# Repository references

A `RepoRef` is a source repository parsed out of a URL, as carried by a `repository` artifact or
named as a dependency in some package manifest. Its `canonical` field is the identity the
dependency graph joins on, so parsing has to agree across the notations the same repository gets
written in — an artifact added as `https://github.com/Owner/Repo.git` and a manifest requiring
`git@github.com:owner/repo` must land on the same node.
-/

open Lean

namespace Taxis.Repo

/-- A reference to a source repository on some forge. -/
structure RepoRef where
  /-- Identity used to match nodes and edges: `host/owner/name`, lowercased, without a `.git`
      suffix. -/
  canonical : String
  host : String
  owner : String
  name : String
  /-- Branch, tag, or commit to read files at; `none` means the forge's default branch. -/
  ref : Option String := none
  /-- The URL as originally written, kept for display and linking. -/
  url : String
deriving Repr, Inhabited, BEq

namespace RepoRef

/-- Strip a `scheme://` prefix, if present. -/
private def dropScheme (s : String) : String :=
  match s.splitOn "://" with
  | _ :: rest@(_ :: _) => "://".intercalate rest
  | _ => s

/-- Strip a `user@` (or `user:password@`) prefix from an authority. -/
private def dropUserInfo (s : String) : String :=
  match s.splitOn "@" with
  | [_, rest] => rest
  | _ => s

/-- Rewrite the `host:owner/name` of scp-style git URLs to `host/owner/name`, leaving a `:port`
    (which is followed by `/`) alone. -/
private def normalizeScpColon (s : String) : String :=
  match s.splitOn ":" with
  | [h, rest] => if rest.isEmpty || rest.startsWith "/" then s else h ++ "/" ++ rest
  | _ => s

/-- Drop a `?query` or `#fragment` tail. -/
private def dropTail (s : String) : String :=
  let s := (s.splitOn "?").headD s
  (s.splitOn "#").headD s

private def stripGitSuffix (s : String) : String :=
  if s.endsWith ".git" then (s.dropEnd 4).toString else s

/-- Parse a repository URL into a `RepoRef`, or `none` if no `owner/name` can be made out.

Accepts the shapes repositories are written in practice: `https://host/owner/name(.git)`,
`git@host:owner/name`, and a bare `owner/name` (assumed to be on GitHub). Trailing path segments
are ignored, except that a GitHub-style `/tree/<branch>` sets `ref`. -/
def parse? (raw : String) : Option RepoRef := do
  let trimmed := raw.trimAscii.toString
  if trimmed.isEmpty then none
  let path := trimmed |> dropScheme |> dropUserInfo |> normalizeScpColon |> dropTail
  let segments := (path.splitOn "/").filter (!·.isEmpty)
  -- A bare `owner/name` has no host segment; anything else must start with one, which we
  -- recognise by its dot (`github.com`, `git.example.org`).
  let (host, rest) := match segments with
    | a :: b :: more => if a.contains '.' then (a, b :: more) else ("github.com", a :: b :: more)
    | _ => ("github.com", segments)
  let owner ← rest[0]?
  let name ← rest[1]?.map stripGitSuffix
  if owner.isEmpty || name.isEmpty then none
  let ref := match rest.drop 2 with
    | "tree" :: b :: _ | "blob" :: b :: _ => some b
    | _ => none
  let host := host.toLower
  some { canonical := s!"{host}/{owner.toLower}/{name.toLower}", host, owner, name, ref, url := trimmed }

/-- `owner/name`, the conventional short display form. -/
def shortName (r : RepoRef) : String := s!"{r.owner}/{r.name}"

end RepoRef

end Taxis.Repo
