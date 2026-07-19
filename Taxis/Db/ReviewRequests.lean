import Taxis.Db.Connection
import Taxis.Db.Notifications

/-!
# Review requests

An explicit, standalone ask for a specific actor to review an issue (see `Taxis.ReviewRequest`).
-/

open Lean

namespace Taxis.Db

private structure ReviewRequestRow where
  id : ReviewRequestId
  issueId : IssueId
  actorId : ActorId
  actorName : Option String
  requestedBy : Option ActorId
  requestedByName : Option String
  createdAt : Timestamp
  resolvedAt : Option Timestamp
deriving SQLite.Row, Inhabited

private def ReviewRequestRow.toReviewRequest (r : ReviewRequestRow) : ReviewRequest :=
  { id := r.id, issueId := r.issueId, actorId := r.actorId, actorName := r.actorName,
    requestedBy := r.requestedBy, requestedByName := r.requestedByName,
    createdAt := r.createdAt, resolvedAt := r.resolvedAt }

/-- All review requests on an issue (pending and resolved), most recent first. -/
def issueReviewRequests (db : Conn) (issueId : IssueId) : IO (Array ReviewRequest) := do
  let rows ← (← db query!"
    SELECT rr.id, rr.issue_id, rr.actor_id, a.display_name, rr.requested_by, rb.display_name, rr.created_at, rr.resolved_at
    FROM review_requests rr
    JOIN actors a ON a.id = rr.actor_id
    LEFT JOIN actors rb ON rb.id = rr.requested_by
    WHERE rr.issue_id = {issueId}
    ORDER BY rr.id DESC" as ReviewRequestRow).toArray
  pure (rows.map ReviewRequestRow.toReviewRequest)

/-- Fetch a single review request by id. -/
def getReviewRequest (db : Conn) (id : ReviewRequestId) : IO (Option ReviewRequest) := do
  let rows ← (← db query!"
    SELECT rr.id, rr.issue_id, rr.actor_id, a.display_name, rr.requested_by, rb.display_name, rr.created_at, rr.resolved_at
    FROM review_requests rr
    JOIN actors a ON a.id = rr.actor_id
    LEFT JOIN actors rb ON rb.id = rr.requested_by
    WHERE rr.id = {id}" as ReviewRequestRow).toArray
  pure (rows[0]?.map ReviewRequestRow.toReviewRequest)

private structure PendingRow where
  id : ReviewRequestId
deriving SQLite.Row, Inhabited

/-- Ask `actorId` to review `issueId`. Reuses an existing *pending* request for the same actor
    instead of piling up duplicates. Notifies the requested actor and adds them as a participant
    (so they also see subsequent activity), unless they requested it of themselves. -/
def requestReview (db : Conn) (issueId : IssueId) (actorId : ActorId) (requestedBy : Option ActorId) :
    IO ReviewRequest := do
  let existing ← (← db query!"
    SELECT id FROM review_requests WHERE issue_id = {issueId} AND actor_id = {actorId} AND resolved_at IS NULL"
    as PendingRow).toArray
  let id ← match existing[0]? with
    | some r => pure r.id
    | none =>
      let rows ← (← db query!"INSERT INTO review_requests (issue_id, actor_id, requested_by)
        VALUES ({issueId}, {actorId}, {requestedBy}) RETURNING id" as ReviewRequestId).toArray
      addParticipant db issueId actorId
      unless (requestedBy.map (·.val)) == some actorId.val do
        notifyActor db actorId issueId "review_requested" (Json.mkObj [("requestedBy", toJson requestedBy)])
      pure rows[0]!
  match ← getReviewRequest db id with
  | some rr => pure rr
  | none => throw (IO.userError "review request vanished after insert")

/-- Mark every one of `actorId`'s pending review requests on `issueId` resolved — called when they
    post a review. -/
def resolvePendingReviewRequests (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Unit := do
  db exec!"UPDATE review_requests SET resolved_at = unixepoch()
    WHERE issue_id = {issueId} AND actor_id = {actorId} AND resolved_at IS NULL"

/-- Withdraw (delete) a review request. Returns whether one was removed. -/
def cancelReviewRequest (db : Conn) (id : ReviewRequestId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM review_requests WHERE id = {id} RETURNING id" as ReviewRequestId).toArray
  pure !removed.isEmpty

end Taxis.Db
