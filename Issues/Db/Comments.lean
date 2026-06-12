import Issues.Db.Connection
import Issues.Domain.Input

/-!
# Comment repository

Comments belong to a single issue and reference their author (nullable, so a comment outlives
its author). Reads join `actors` to denormalise the author's display name.
-/

open Lean

namespace Issues.Db

private structure CommentRow where
  id : CommentId
  issueId : IssueId
  authorId : Option ActorId
  authorName : Option String
  body : String
  createdAt : Timestamp
  updatedAt : Timestamp
deriving SQLite.Row, Inhabited

private def CommentRow.toComment (r : CommentRow) : Comment :=
  { id := r.id, issueId := r.issueId, authorId := r.authorId, authorName := r.authorName,
    body := r.body, createdAt := r.createdAt, updatedAt := r.updatedAt }

/-- Fetch a single comment by id. -/
def getComment (db : Conn) (id : CommentId) : IO (Option Comment) := do
  let rows ← (← db query!"SELECT c.id, c.issue_id, c.author_id, a.display_name, c.body, c.created_at, c.updated_at
    FROM comments c LEFT JOIN actors a ON a.id = c.author_id WHERE c.id = {id}" as CommentRow).toArray
  pure (rows[0]?.map CommentRow.toComment)

/-- All comments on an issue, oldest first. -/
def issueComments (db : Conn) (issueId : IssueId) : IO (Array Comment) := do
  let rows ← (← db query!"SELECT c.id, c.issue_id, c.author_id, a.display_name, c.body, c.created_at, c.updated_at
    FROM comments c LEFT JOIN actors a ON a.id = c.author_id WHERE c.issue_id = {issueId} ORDER BY c.id" as CommentRow).toArray
  pure (rows.map CommentRow.toComment)

/-- Post a comment on an issue, attributed to `authorId` (if any). -/
def createComment (db : Conn) (issueId : IssueId) (authorId : Option ActorId)
    (input : CommentInput) : IO Comment := do
  let rows ← (← db query!"INSERT INTO comments (issue_id, author_id, body)
    VALUES ({issueId}, {authorId}, {input.body}) RETURNING id" as CommentId).toArray
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

end Issues.Db
