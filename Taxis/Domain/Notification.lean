import Taxis.Domain.Ids

/-!
# Notifications

A notification is one recipient's copy of an issue's activity: whenever an event is recorded (or
a comment posted) on an issue, every current **participant** except whoever triggered it gets a
notification row. Participants are the issue's creator and assignees (automatic) plus anyone who
explicitly subscribed.

`kind`/`data` mirror the shape of `Event`, so the frontend can reuse the same "describe this
activity" rendering for both the issue timeline and the notification list.
-/

open Lean

namespace Taxis

/-- One recipient's notification of an issue's activity. -/
structure Notification where
  id : NotificationId
  actorId : ActorId
  issueId : IssueId
  /-- Denormalised issue title at render time, so the list doesn't need a second lookup. -/
  issueTitle : String := ""
  /-- Discriminator matching `Event.kind` (plus `"comment"` for new comments, which aren't
      recorded as events). -/
  kind : String
  data : Json := Json.mkObj []
  /-- Whether the recipient has seen it (clicked through to the issue). -/
  read : Bool := false
  /-- Whether the recipient has explicitly resolved it. Independent of `read` — viewing a
      notification does not imply it's done. -/
  done : Bool := false
  createdAt : Timestamp
deriving Inhabited, ToJson, FromJson

end Taxis
