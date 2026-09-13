import Taxis.Plugins.Registry

/-!
# Lake dependency provider

Derives the dependency edges of a Lean repository from its Lake configuration, by probing three
sources in order of reliability:

1. `lake-manifest.json` — generated, so it names every dependency by exact URL. Entries flagged
   `"inherited": true` are transitive (pulled in by another package) and are skipped, leaving the
   repository's *direct* dependencies, which is what an edge means here.
2. `lakefile.toml` — the declared `[[require]]` blocks, for a repository that doesn't commit its
   manifest.
3. `lakefile.lean` — the older configuration format, scanned for `require … from git "…"`.

A repository with none of the three isn't a Lake package, and the provider declines it.
-/

open Lean

namespace Taxis.Plugins

/-- Build an edge from a dependency URL, dropping ones we can't resolve to a repository. -/
private def depFromUrl (url : String) (detail : Option String) : Option RepoDep := do
  let ref ← Repo.RepoRef.parse? url
  some { target := ref.canonical, targetUrl := url, detail }

/-! ### `lake-manifest.json` -/

private def depsFromManifest (body : String) : Except String (Array RepoDep) := do
  let j ← Json.parse body
  let packages ← (← j.getObjVal? "packages").getArr?
  let mut deps : Array RepoDep := #[]
  for p in packages do
    -- A missing `inherited` is treated as direct: older manifests omit it, and a direct
    -- dependency is the safer default for an edge that a human can see and correct.
    if (p.getObjValAs? Bool "inherited").toOption.getD false then continue
    let some url := (p.getObjValAs? String "url").toOption | continue
    let detail := (p.getObjValAs? String "inputRev").toOption
      |>.orElse (fun _ => (p.getObjValAs? String "rev").toOption)
    if let some d := depFromUrl url detail then deps := deps.push d
  return deps

/-! ### `lakefile.toml` -/

private def stripQuotes (s : String) : String :=
  if s.length ≥ 2 && ((s.startsWith "\"" && s.endsWith "\"") || (s.startsWith "'" && s.endsWith "'")) then
    ((s.drop 1).toString.dropEnd 1).toString
  else s

private structure TomlRequire where
  name : Option String := none
  git : Option String := none
  rev : Option String := none
  scope : Option String := none
deriving Inhabited

private def TomlRequire.toDep (r : TomlRequire) : Option RepoDep :=
  match r.git with
  | some git => depFromUrl git r.rev
  | none =>
    -- A Reservoir-style `require` names a scope and a package rather than a URL. Reservoir
    -- scopes are GitHub organisations, so the repository is a good guess — but only a guess (a
    -- package's name need not be its repository's), hence the qualified detail.
    match r.scope, r.name with
    | some scope, some name =>
      depFromUrl s!"https://github.com/{scope}/{name}" (some s!"reservoir {scope}/{name}")
    | _, _ => none

/-- Scan the `[[require]]` blocks of a `lakefile.toml`. This is a line scanner rather than a TOML
    parser: `require` blocks in practice are flat tables of scalar keys, and pulling in a parser
    for them isn't worth the dependency. -/
private def depsFromToml (body : String) : Array RepoDep := Id.run do
  let mut deps : Array RepoDep := #[]
  let mut cur : Option TomlRequire := none
  for rawLine in body.splitOn "\n" do
    let line := rawLine.trimAscii.toString
    if line.isEmpty || line.startsWith "#" then continue
    if line.startsWith "[" then
      if let some r := cur then
        if let some d := r.toDep then deps := deps.push d
      cur := if line.startsWith "[[require]]" then some {} else none
      continue
    let some r := cur | continue
    match line.splitOn "=" with
    | key :: rest@(_ :: _) =>
      let v := stripQuotes ("=".intercalate rest).trimAscii.toString
      cur := some <| match key.trimAscii.toString with
        | "name" => { r with name := some v }
        | "git" => { r with git := some v }
        | "rev" => { r with rev := some v }
        | "scope" => { r with scope := some v }
        | _ => r
    | _ => pure ()
  if let some r := cur then
    if let some d := r.toDep then deps := deps.push d
  return deps

/-! ### `lakefile.lean` -/

/-- The first double-quoted string following `marker` on a line. -/
private def quotedAfter (line marker : String) : Option String :=
  match line.splitOn marker with
  | _ :: rest@(_ :: _) =>
    match (marker.intercalate rest).splitOn "\"" with
    | _ :: v :: _ => some v
    | _ => none
  | _ => none

/-- Scan a `lakefile.lean` for `require … from git "url" @ "rev"` declarations. Only single-line
    requires are recognised, which covers the overwhelming majority; a repository whose requires
    are spread over several lines is better served by committing its manifest. -/
private def depsFromLakefileLean (body : String) : Array RepoDep := Id.run do
  let mut deps : Array RepoDep := #[]
  for rawLine in body.splitOn "\n" do
    let line := rawLine.trimAscii.toString
    if !line.startsWith "require" then continue
    let some url := quotedAfter line "git" | continue
    -- The revision, when pinned, is the second quoted string (after `@`).
    let rev := quotedAfter line "@"
    if let some d := depFromUrl url rev then deps := deps.push d
  return deps

/-! ### The provider -/

def lakeDeps (_repo : Repo.RepoRef) (read : RepoFileReader) :
    IO (Except String (Option (Array RepoDep))) := do
  match ← read "lake-manifest.json" with
  | .error e => return .error e
  | .ok (some body) => return (depsFromManifest body).map some
  | .ok none =>
    match ← read "lakefile.toml" with
    | .error e => return .error e
    | .ok (some body) => return .ok (some (depsFromToml body))
    | .ok none =>
      match ← read "lakefile.lean" with
      | .error e => return .error e
      | .ok (some body) => return .ok (some (depsFromLakefileLean body))
      | .ok none => return .ok none

/-- Provider: dependencies of a Lean package, from its Lake configuration. -/
def lakeDepsProvider : RepoDepsProvider where
  kind := "lake"
  deps := lakeDeps

initialize registerRepoDepsProvider lakeDepsProvider

end Taxis.Plugins
