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
  /-- A short description of the goal condition: what must hold for the issue to be complete. -/
  goal : String := ""
  state : IssueState := .open
  /-- When locked, the title, description, goal, parent, and dependency relations are frozen. -/
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

/-- An issue reduced to what it takes to *name* it: an id, a title, and its place in the
    containment tree.

    This is what a breadcrumb trail, an issue picker and a `#123` reference need, and all any of
    them ever needed. It is returned by `GET /issues/index` — which takes an id set or a search
    term, because naming a handful of issues should not cost a copy of the tracker. -/
structure IssueIndexEntry where
  id : IssueId
  title : String
  parent : Option IssueId := none
deriving Repr, Inhabited, ToJson, FromJson

/-- One node of the issue graph: an issue reduced to what a graph draws and filters by.

    The graph is the one view that genuinely needs every issue — an edge may point at one the
    current filters hide, and how nested an issue is depends on its whole parent chain — so what a
    node costs is multiplied by the size of the tracker, and everything a node does not draw is
    worth leaving out. It used to read whole issues: creator, timestamps, visibility groups and
    counts of artifacts and checks, none of which appear on a card or in a filter.

    Both relations are here, not just one: `dependencies` are the edges in dependency mode and
    `parent` the edges in hierarchy mode, and the two modes are a toggle rather than two reads. -/
structure GraphNode where
  id : IssueId
  title : String
  state : IssueState := .open
  locked : Bool := false
  labels : Array LabelId := #[]
  parent : Option IssueId := none
  dependencies : Array IssueId := #[]
  assignees : Array ActorId := #[]
  deadline : Option Timestamp := none
deriving Repr, Inhabited, ToJson, FromJson

/-- Where an issue sits among the issues sharing its parent, and the two next to it.

    Carried on the detail response rather than derived by the client, which is what it used to do —
    from a naming index of the whole tracker, fetched to answer a question about three issues. Only
    the neighbours are sent: the position and the count say what the rest of the set is without
    naming any of it. -/
structure SiblingNav where
  /-- 1-based position of this issue among its siblings; `0` when it has no parent. -/
  position : Nat := 0
  /-- How many issues share this issue's parent, including itself. -/
  count : Nat := 0
  prev : Option IssueIndexEntry := none
  next : Option IssueIndexEntry := none
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
  /-- The containment path above this issue, root first, excluding the issue itself. Stops at the
      first ancestor the reader may not see, so a chain never names a hidden issue. -/
  ancestors : Array IssueIndexEntry := #[]
  /-- This issue's place among its siblings, and the two either side of it. -/
  siblings : SiblingNav := {}
deriving Inhabited, ToJson, FromJson

end Taxis
