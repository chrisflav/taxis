import Taxis.Db.Connection
import Taxis.Db.Notifications
import Taxis.Db.ReviewRequests
import Taxis.Domain.Input

/-!
# Comment repository

Comments belong to a single issue and reference their author (nullable, so a comment outlives
its author). Reads join `actors` to denormalise the author's display name. A comment may carry a
`review` verdict, turning it into a review (see `Taxis.Domain.ReviewState`).
-/

open Lean

namespace Taxis.Db

private structure CommentRow where
  id : CommentId
  issueId : IssueId
  authorId : Option ActorId
  authorName : Option String
  body : String
  review : Option ReviewState
  createdAt : Timestamp
  updatedAt : Timestamp
deriving SQLite.Row, Inhabited

private def CommentRow.toComment (r : CommentRow) : Comment :=
  { id := r.id, issueId := r.issueId, authorId := r.authorId, authorName := r.authorName,
    body := r.body, review := r.review, createdAt := r.createdAt, updatedAt := r.updatedAt }

/-- Fetch a single comment by id. -/
def getComment (db : Conn) (id : CommentId) : IO (Option Comment) := do
  let rows ← (← db query!"SELECT c.id, c.issue_id, c.author_id, a.display_name, c.body, c.review, c.created_at, c.updated_at
    FROM comments c LEFT JOIN actors a ON a.id = c.author_id WHERE c.id = {id}" as CommentRow).toArray
  pure (rows[0]?.map CommentRow.toComment)

/-- All comments on an issue, oldest first. -/
def issueComments (db : Conn) (issueId : IssueId) : IO (Array Comment) := do
  let rows ← (← db query!"SELECT c.id, c.issue_id, c.author_id, a.display_name, c.body, c.review, c.created_at, c.updated_at
    FROM comments c LEFT JOIN actors a ON a.id = c.author_id WHERE c.issue_id = {issueId} ORDER BY c.id" as CommentRow).toArray
  pure (rows.map CommentRow.toComment)

/-- Post a comment (optionally a review) on an issue, attributed to `authorId` (if any). Stamps
    the issue's `updated_at` and notifies participants, since comments aren't recorded as events. -/
def createComment (db : Conn) (issueId : IssueId) (authorId : Option ActorId)
    (input : CommentInput) : IO Comment := do
  let rows ← (← db query!"INSERT INTO comments (issue_id, author_id, body, review)
    VALUES ({issueId}, {authorId}, {input.body}, {input.review}) RETURNING id" as CommentId).toArray
  db exec!"UPDATE issues SET updated_at = unixepoch() WHERE id = {issueId}"
  let kind := if input.review.isSome then "review" else "comment"
  fanOutNotification db issueId authorId kind (Json.mkObj [("commentId", toJson rows[0]!), ("body", input.body)])
  if input.review.isSome then
    if let some aid := authorId then resolvePendingReviewRequests db issueId aid
  match ← getComment db rows[0]! with
  | some c => pure c
  | none => throw (IO.userError "comment vanished after insert")

/-- Edit a comment's body, stamping `updated_at`. Returns `none` if it does not exist. -/
def updateComment (db : Conn) (id : CommentId) (body : String) : IO (Option Comment) := do
  db exec!"UPDATE comments SET body = {body}, updated_at = unixepoch() WHERE id = {id}"
  getComment db id

/-- Delete a comment. Returns whether a row was removed. -/
def deleteComment (db : Conn) (id : CommentId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM comments WHERE id = {id} RETURNING id" as CommentId).toArray
  pure !removed.isEmpty

end Taxis.Db
