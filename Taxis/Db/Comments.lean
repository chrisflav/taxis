import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Db.Notifications
import Taxis.Db.ReviewRequests
import Taxis.Domain.Input

/-!
# Comment repository

Comments belong to a single issue and reference their author (nullable, so a comment outlives
its author). Reads are a `Query.leftJoin` onto `actors` to denormalise the author's display name,
whose columns come back nullable — which is what an outer join does to the side that may not
match, and exactly what an authorless comment needs. A comment may carry a `review` verdict,
turning it into a review (see `Taxis.Domain.ReviewState`).
-/

open Lean

namespace Taxis.Db

open Schema (CommentsIndex ActorsIndex IssuesIndex)

private abbrev taxis : Database := HasModel.database Schema.Comments

private abbrev commentsTable : taxis.Index := (HasModel.model Schema.Comments).index
private abbrev actorsTable : taxis.Index := (HasModel.model Schema.Actors).index

/-- A comment with its author, where it still has one. -/
private abbrev commentView : View taxis :=
  (Table.view commentsTable).prod (Table.view actorsTable).nullable

private abbrev commentCol (c : Schema.CommentsIndex) : commentView.Index := Sum.inl c
private abbrev authorCol (c : Schema.ActorsIndex) : commentView.Index := Sum.inr c

/-- The join every read here starts from. -/
private def commentJoin : Query taxis commentView :=
  .leftJoin (.all commentsTable) (.all actorsTable)
    (.eq (.var (Sum.inl CommentsIndex.author_id) .int) (.var (Sum.inr ActorsIndex.id) .int))

/-- The stored `review` string as the verdict enum.

    The column is `text` rather than an enumerated type, so a value the domain does not know is
    possible in principle; it can only come from something other than this application writing the
    row, and reading it as one of the two would be worse than failing. -/
private def reviewStateOf : Option String → IO (Option ReviewState)
  | none => pure none
  | some s =>
    match ReviewState.ofString? s with
    | some st => pure (some st)
    | none => throw (IO.userError s!"invalid review state in database: {s}")

/-- A joined row as the domain value. -/
private def commentOfRow (row : commentView.Entry) : IO Comment := do
  return { id := ⟨Int64.ofInt (row.value (commentCol CommentsIndex.id))⟩
           issueId := ⟨Int64.ofInt (row.value (commentCol CommentsIndex.issue_id))⟩
           authorId := (row.value (commentCol CommentsIndex.author_id)).map fun a =>
             ⟨Int64.ofInt a⟩
           authorName := row.value (authorCol ActorsIndex.display_name)
           body := row.value (commentCol CommentsIndex.body)
           review := ← reviewStateOf (row.value (commentCol CommentsIndex.review))
           createdAt := ⟨Int64.ofInt (row.value (commentCol CommentsIndex.created_at))⟩
           updatedAt := ⟨Int64.ofInt (row.value (commentCol CommentsIndex.updated_at))⟩ }

/-- Fetch a single comment by id. -/
def getComment (db : Conn) (id : CommentId) : IO (Option Comment) := do
  let rows ← run db <| DBMonad.lookup <|
    Query.filter (.eq (.var (commentCol CommentsIndex.id) .int) (.int id.val.toInt)) commentJoin
  match rows[0]? with
  | none => pure none
  | some row => some <$> commentOfRow row

/-- All comments on an issue, oldest first. -/
def issueComments (db : Conn) (issueId : IssueId) : IO (Array Comment) := do
  let rows ← run db <| DBMonad.lookup <|
    Query.orderBy [{ column := commentCol CommentsIndex.id }]
      (.filter (.eq (.var (commentCol CommentsIndex.issue_id) .int) (.int issueId.val.toInt))
        commentJoin)
  rows.mapM commentOfRow

/-- Post a comment (optionally a review) on an issue, attributed to `authorId` (if any). Stamps
    the issue's `updated_at` and notifies participants, since comments aren't recorded as events.

    Both timestamps come from `nowSeconds`, where the insert left them to the column defaults and
    the stamp on the issue was `unixepoch()`; the query language has no expression for a call the
    database evaluates, and the two agree to the second. -/
def createComment (db : Conn) (issueId : IssueId) (authorId : Option ActorId)
    (input : CommentInput) : IO Comment := do
  let now ← nowSeconds
  let stored ← run db <| HasModel.insertReturning
    ({ id := 0, issue_id := issueId.val.toInt, author_id := authorId.map (·.val.toInt),
       body := input.body, created_at := now, updated_at := now,
       review := input.review.map (·.toString) } : Schema.Comments)
  run db do
    discard <| HasModel.update (α := Schema.Issues)
      { value
          | .updated_at => some (.int now)
          | _ => none
        condition := .eq (.var IssuesIndex.id .int) (.int issueId.val.toInt) }
  let id : CommentId := ⟨Int64.ofInt stored.id⟩
  let kind := if input.review.isSome then "review" else "comment"
  fanOutNotification db issueId authorId kind
    (Json.mkObj [("commentId", toJson id), ("body", input.body)])
  if input.review.isSome then
    if let some aid := authorId then resolvePendingReviewRequests db issueId aid
  match ← getComment db id with
  | some c => pure c
  | none => throw (IO.userError "comment vanished after insert")

/-- Edit a comment's body, stamping `updated_at`. Returns `none` if it does not exist. -/
def updateComment (db : Conn) (id : CommentId) (body : String) : IO (Option Comment) := do
  let now ← nowSeconds
  run db do
    discard <| HasModel.update (α := Schema.Comments)
      { value
          | .body => some (.text body)
          | .updated_at => some (.int now)
          | _ => none
        condition := .eq (.var CommentsIndex.id .int) (.int id.val.toInt) }
  getComment db id

/-- Delete a comment. Returns whether a row was removed. -/
def deleteComment (db : Conn) (id : CommentId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.Comments)
    (.eq (.var CommentsIndex.id .int) (.int id.val.toInt))
  return removed > 0

end Taxis.Db
