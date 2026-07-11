import Taxis.Domain.Ids
import Taxis.Domain.Enums
import Taxis.Domain.Actor
import Taxis.Domain.Artifact
import Taxis.Domain.Check
import Taxis.Domain.Comment
import Taxis.Domain.Event
import Taxis.Domain.Label

/-!
# Issues

The central entity. An issue carries its lifecycle state, an optional single **parent** (a
hierarchical containment relation — at most one), a set of **dependencies** (other issues it
depends on, forming the dependency graph), assigned actors, attached artifacts, attached checks,
and a set of groups that may see it (empty ⇒ public).
-/

open Lean

namespace Taxis

/-- An issue, as returned to clients (ids only for related entities). -/
structure Issue where
  id : IssueId
  title : String
  description : String := ""
  state : IssueState := .open
  /-- When locked, the title, description, parent, and dependency relations are frozen. -/
  locked : Bool := false
  labels : Array LabelId := #[]
  /-- The single hierarchical parent (containing issue), if any. -/
  parent : Option IssueId := none
  /-- Other issues this one depends on (the dependency graph). -/
  dependencies : Array IssueId := #[]
  assignees : Array ActorId := #[]
  artifacts : Array ArtifactId := #[]
  visibility : Array GroupId := #[]
  checks : Array CheckId := #[]
  createdAt : Timestamp
  updatedAt : Timestamp
deriving Repr, Inhabited, ToJson, FromJson

/-- A fully expanded issue, embedding related entities. Used for the detail view. -/
structure IssueDetail where
  issue : Issue
  assignedActors : Array Actor := #[]
  issueLabels : Array Label := #[]
  attachedArtifacts : Array ArtifactView := #[]
  attachedChecks : Array Check := #[]
  comments : Array Comment := #[]
  events : Array Event := #[]
deriving Inhabited, ToJson, FromJson

end Taxis
