import Issues.Domain.Ids

/-!
# Comments

A comment is a note left by an actor on an issue. Comments are ordered by creation time and
carry a denormalised author display name so the detail view can render them without a second
lookup. The author is optional: a comment survives (with `authorId = none`) if its author is
deleted, and imported/system comments may have no author at all.
-/

open Lean

namespace Issues

/-- A comment on an issue, as returned to clients. -/
structure Comment where
  id : CommentId
  issueId : IssueId
  /-- The actor who wrote the comment, if still present. -/
  authorId : Option ActorId := none
  /-- Denormalised display name of the author at render time. -/
  authorName : Option String := none
  body : String
  createdAt : Timestamp
  updatedAt : Timestamp
deriving Inhabited, ToJson, FromJson

end Issues
