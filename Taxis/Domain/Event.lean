import Taxis.Domain.Ids

/-!
# Events

An event records a single change made to an issue: a field edit (title, description, goal, state,
parent, dependencies, assignees, visibility, labels, lock), an artifact/check being attached or
removed, or a comment being edited or deleted. Events form the issue's audit trail.

Content edits (title, description, goal, comments) carry the previous value in `data` so the
frontend can offer an edit-history dropdown next to the text; the remaining events are shown as a
chronological activity log. The author is optional so an event survives its actor's deletion, and
system/imported changes may have no actor.
-/

open Lean

namespace Taxis

/-- A recorded change to an issue, as returned to clients. -/
structure Event where
  id : EventId
  issueId : IssueId
  /-- The actor who made the change, if still present. -/
  actorId : Option ActorId := none
  /-- Denormalised display name of the actor at render time. -/
  actorName : Option String := none
  /-- Whether the acting actor is a bot (for rendering a marker). -/
  actorBot : Bool := false
  /-- Discriminator naming the kind of change, e.g. `"title"`, `"state"`, `"artifact_added"`. -/
  kind : String
  /-- Kind-specific detail (old/new values, added/removed ids, …). -/
  data : Json := Json.mkObj []
  createdAt : Timestamp
deriving Inhabited, ToJson, FromJson

end Taxis
