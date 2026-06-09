import Issues.Domain.Ids
import Issues.Domain.Enums
import Issues.Domain.Actor
import Issues.Domain.Artifact
import Issues.Domain.Check
import Issues.Domain.Label

/-!
# Issues

The central entity. An issue carries its lifecycle state, a set of parent issues (forming a
dependency DAG), assigned actors, attached artifacts, attached checks, and a set of groups
that may see it (empty ⇒ public).
-/

open Lean

namespace Issues

/-- An issue, as returned to clients (ids only for related entities). -/
structure Issue where
  id : IssueId
  title : String
  description : String := ""
  state : IssueState := .open
  /-- When locked, the title, description, and dependency (parent) relations are frozen. -/
  locked : Bool := false
  labels : Array LabelId := #[]
  parents : Array IssueId := #[]
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
deriving Inhabited, ToJson, FromJson

end Issues
