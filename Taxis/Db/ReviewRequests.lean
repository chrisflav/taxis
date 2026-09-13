import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Db.Notifications

/-!
# Review requests

An explicit, standalone ask for a specific actor to review an issue (see `Taxis.ReviewRequest`).

A request is read with two actors beside it: the reviewer, which every request has, and whoever
asked, which it may not. The first is an inner join — a cross join filtered by the condition
relating the two sides — and the second a `Query.leftJoin`, whose right-hand columns come back
nullable so that a request nobody is recorded as having made still comes back.
-/

open Lean

namespace Taxis.Db

open Schema (ReviewRequestsIndex ActorsIndex)

private abbrev taxis : Database := HasModel.database Schema.ReviewRequests

private abbrev reviewRequestsTable : taxis.Index := (HasModel.model Schema.ReviewRequests).index
private abbrev actorsTable : taxis.Index := (HasModel.model Schema.Actors).index

/-- A review request, the actor asked to review it, and the actor who asked (if any). -/
private abbrev reviewView : View taxis :=
  ((Table.view reviewRequestsTable).prod (Table.view actorsTable)).prod
    (Table.view actorsTable).nullable

private abbrev rrCol (c : Schema.ReviewRequestsIndex) : reviewView.Index := Sum.inl (Sum.inl c)
private abbrev reviewerCol (c : Schema.ActorsIndex) : reviewView.Index := Sum.inl (Sum.inr c)
private abbrev requesterCol (c : Schema.ActorsIndex) : reviewView.Index := Sum.inr c

/-- The join every read here starts from. -/
private def reviewJoin : Query taxis reviewView :=
  .leftJoin
    (.filter
      (.eq (.var (Sum.inl ReviewRequestsIndex.actor_id) .int)
           (.var (Sum.inr ActorsIndex.id) .int))
      (.join (.all reviewRequestsTable) (.all actorsTable)))
    (.all actorsTable)
    (.eq (.var (Sum.inl (Sum.inl ReviewRequestsIndex.requested_by)) .int)
         (.var (Sum.inr ActorsIndex.id) .int))

/-- A joined row as the domain value. The reviewer's name comes from the inner join, so it is
    always there; the requester's comes from the outer one, so it is already an `Option`. -/
private def reviewRequestOfRow (row : reviewView.Entry) : ReviewRequest :=
  { id := ⟨Int64.ofInt (row.value (rrCol ReviewRequestsIndex.id))⟩
    issueId := ⟨Int64.ofInt (row.value (rrCol ReviewRequestsIndex.issue_id))⟩
    actorId := ⟨Int64.ofInt (row.value (rrCol ReviewRequestsIndex.actor_id))⟩
    actorName := some (row.value (reviewerCol ActorsIndex.display_name))
    requestedBy := (row.value (rrCol ReviewRequestsIndex.requested_by)).map fun a =>
      ⟨Int64.ofInt a⟩
    requestedByName := row.value (requesterCol ActorsIndex.display_name)
    createdAt := ⟨Int64.ofInt (row.value (rrCol ReviewRequestsIndex.created_at))⟩
    resolvedAt := (row.value (rrCol ReviewRequestsIndex.resolved_at)).map fun t =>
      ⟨Int64.ofInt t⟩ }

/-- All review requests on an issue (pending and resolved), most recent first. -/
def issueReviewRequests (db : Conn) (issueId : IssueId) : IO (Array ReviewRequest) := do
  let rows ← run db <| DBMonad.lookup <|
    Query.orderBy [{ column := rrCol ReviewRequestsIndex.id, direction := .desc }]
      (.filter (.eq (.var (rrCol ReviewRequestsIndex.issue_id) .int) (.int issueId.val.toInt))
        reviewJoin)
  return rows.map reviewRequestOfRow

/-- Fetch a single review request by id. -/
def getReviewRequest (db : Conn) (id : ReviewRequestId) : IO (Option ReviewRequest) := do
  let rows ← run db <| DBMonad.lookup <|
    Query.filter (.eq (.var (rrCol ReviewRequestsIndex.id) .int) (.int id.val.toInt)) reviewJoin
  return rows[0]?.map reviewRequestOfRow

/-- Ask `actorId` to review `issueId`. Reuses an existing *pending* request for the same actor
    instead of piling up duplicates. Notifies the requested actor and adds them as a participant
    (so they also see subsequent activity), unless they requested it of themselves.

    The insert supplies every column, `created_at` included: the `unixepoch()` the database used
    to fill it in with is now `nowSeconds`. -/
def requestReview (db : Conn) (issueId : IssueId) (actorId : ActorId)
    (requestedBy : Option ActorId) : IO ReviewRequest := do
  let existing ← run db <| HasModel.fetch (α := Schema.ReviewRequests)
    { query := .filter
        (.and
          (.and (.eq (.var ReviewRequestsIndex.issue_id .int) (.int issueId.val.toInt))
                (.eq (.var ReviewRequestsIndex.actor_id .int) (.int actorId.val.toInt)))
          (.isNull (.var ReviewRequestsIndex.resolved_at .int)))
        (.all _) }
  let id : ReviewRequestId ← match existing[0]? with
    | some r => pure ⟨Int64.ofInt r.id⟩
    | none =>
      let now ← nowSeconds
      let stored ← run db <| HasModel.insertReturning
        ({ id := 0, issue_id := issueId.val.toInt, actor_id := actorId.val.toInt,
           requested_by := requestedBy.map (·.val.toInt), created_at := now,
           resolved_at := none } : Schema.ReviewRequests)
      addParticipant db issueId actorId
      unless (requestedBy.map (·.val)) == some actorId.val do
        notifyActor db actorId issueId "review_requested"
          (Json.mkObj [("requestedBy", toJson requestedBy)])
      pure ⟨Int64.ofInt stored.id⟩
  match ← getReviewRequest db id with
  | some rr => pure rr
  | none => throw (IO.userError "review request vanished after insert")

/-- Mark every one of `actorId`'s pending review requests on `issueId` resolved — called when they
    post a review. The stamp comes from `nowSeconds` rather than from the database's
    `unixepoch()`. -/
def resolvePendingReviewRequests (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Unit := do
  let now ← nowSeconds
  run db do
    discard <| HasModel.update (α := Schema.ReviewRequests)
      { value
          | .resolved_at => some (.int now)
          | _ => none
        condition :=
          .and
            (.and (.eq (.var ReviewRequestsIndex.issue_id .int) (.int issueId.val.toInt))
                  (.eq (.var ReviewRequestsIndex.actor_id .int) (.int actorId.val.toInt)))
            (.isNull (.var ReviewRequestsIndex.resolved_at .int)) }

/-- Withdraw (delete) a review request. Returns whether one was removed. -/
def cancelReviewRequest (db : Conn) (id : ReviewRequestId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.ReviewRequests)
    (.eq (.var ReviewRequestsIndex.id .int) (.int id.val.toInt))
  return removed > 0

end Taxis.Db
