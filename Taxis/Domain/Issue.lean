import Taxis.Domain.Ids
import Taxis.Domain.Enums
import Taxis.Domain.Actor
import Taxis.Domain.Artifact
import Taxis.Domain.Check
import Taxis.Domain.Comment
import Taxis.Domain.Event
import Taxis.Domain.Label
import Taxis.Domain.ReviewRequest

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
  /-- The actor who created the issue, if still present. Set once at creation, never updated. -/
  creatorId : Option ActorId := none
  /-- Denormalised display name of the creator at render time. -/
  creatorName : Option String := none
  /-- Optional due date. Purely informational; nothing currently enforces it. -/
  deadline : Option Timestamp := none
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
  /-- Whether the requesting actor participates in (is subscribed to) this issue's notifications. -/
  participating : Bool := false
  /-- Review requests on this issue, most recent first (both pending and resolved). -/
  reviewRequests : Array ReviewRequest := #[]
deriving Inhabited, ToJson, FromJson

end Taxis
