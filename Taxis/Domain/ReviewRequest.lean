import Taxis.Domain.Ids

/-!
# Review requests

An explicit, standalone ask for a specific actor to review an issue — independent of assignment
(an issue can be assigned to nobody, or to people who aren't being asked to review it right now).
Requesting a review notifies that actor directly and adds them as a participant, so they also see
subsequent activity; posting a review (an `approve`/`request_changes` comment) resolves their own
outstanding request(s) on that issue.
-/

open Lean

namespace Taxis

/-- A request for `actorId` to review an issue, as returned to clients. -/
structure ReviewRequest where
  id : ReviewRequestId
  issueId : IssueId
  actorId : ActorId
  /-- Denormalised display name of the requested reviewer. -/
  actorName : Option String := none
  requestedBy : Option ActorId := none
  /-- Denormalised display name of whoever asked. -/
  requestedByName : Option String := none
  createdAt : Timestamp
  /-- Set once the requested actor posts a review (or the request is otherwise withdrawn/fulfilled). -/
  resolvedAt : Option Timestamp := none
deriving Inhabited, ToJson, FromJson

end Taxis
