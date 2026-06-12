import Issues.Plugins.Registry

/-!
# Source-location plugin

Built-in artifact kind `source`: a location in a file of a GitHub repository, pinned to a commit,
with an optional line range. Links to the file on GitHub at that commit and lines.

Payload fields:
* `repo` — the `owner/name` GitHub repository (required).
* `file` — the file path within the repository (required).
* `commit` — the commit SHA or ref the line numbers are pinned to (default `main`).
* `startLine`, `endLine` — an optional line range.
-/

open Lean

namespace Issues.Plugins

private def sourceDisplay (j : Json) : ArtifactDisplay :=
  let str? (f : String) := (j.getObjValAs? String f).toOption
  let nat? (f : String) := (j.getObjValAs? Nat f).toOption
  let repo := (str? "repo").getD "?"
  let file := (str? "file").getD "?"
  let commit := (str? "commit").getD "main"
  let lineSuffix := match nat? "startLine", nat? "endLine" with
    | some s, some e => s!":{s}-{e}"
    | some s, none => s!":{s}"
    | _, _ => ""
  let anchor := match nat? "startLine", nat? "endLine" with
    | some s, some e => s!"#L{s}-L{e}"
    | some s, none => s!"#L{s}"
    | _, _ => ""
  { label := s!"{repo}/{file}{lineSuffix}",
    url := some s!"https://github.com/{repo}/blob/{commit}/{file}{anchor}" }

/-- Artifact: a file location in a GitHub repository, pinned to a commit and (optionally) lines. -/
def sourceHandler : ArtifactHandler where
  kind := "source"
  fields := #[
    { name := "repo", label := "GitHub repository", required := true, placeholder := some "owner/name" },
    { name := "file", label := "File path", required := true, placeholder := some "src/main.rs" },
    { name := "commit", label := "Commit", placeholder := some "main",
      help := some "Commit SHA or ref the line numbers are pinned to" },
    { name := "startLine", label := "Start line", type := "number" },
    { name := "endLine", label := "End line", type := "number" }]
  validate j := do
    let _ ← j.getObjValAs? String "repo"
    let _ ← j.getObjValAs? String "file"
    pure ()
  render := sourceDisplay

initialize registerArtifactHandler sourceHandler

end Issues.Plugins
