import Issues.Domain.Ids

/-!
# Artifacts

An artifact is something attached to an issue — e.g. a GitHub pull request or a branch. The
set of possible artifact kinds is extensible: an artifact
stores a `kind` discriminator plus an opaque JSON `payload` that the registered handler for
that kind knows how to interpret (see `Issues.Plugins`).
-/

open Lean

namespace Issues

/-- An artifact attached to an issue. -/
structure Artifact where
  id : ArtifactId
  /-- Discriminator naming the registered artifact handler, e.g. `"github-pr"`. -/
  kind : String
  /-- Handler-specific data, validated by the handler for `kind`. -/
  payload : Json := .null
deriving Inhabited, ToJson, FromJson

/-- How an artifact should be presented: a human label and an optional link. Produced by the
    artifact handler's `render`, so each kind controls its own display. -/
structure ArtifactDisplay where
  label : String
  url : Option String := none
deriving Inhabited, ToJson, FromJson

/-- An artifact enriched with its display, as returned to clients. -/
structure ArtifactView where
  id : ArtifactId
  kind : String
  payload : Json := .null
  display : ArtifactDisplay
deriving Inhabited, ToJson, FromJson

end Issues
