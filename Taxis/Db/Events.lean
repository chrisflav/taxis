import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Db.Notifications
import Taxis.Domain.Input

/-!
# Event repository

Events form an issue's audit trail. `recordEvent` appends one row (and fans out a notification to
the issue's participants, see `Taxis.Db.fanOutNotification`); `recordIssueChanges` diffs an issue
before and after an update and appends one event per changed field. Reads are a `Query.leftJoin`
onto `actors` to denormalise the acting actor's display name and bot flag so the detail view
renders without a second lookup; the join makes those columns nullable, which is what an event
whose actor is gone needs.
-/

open Lean

namespace Taxis.Db

open Schema (EventsIndex ActorsIndex IssuesIndex)

private abbrev taxis : Database := HasModel.database Schema.Events

private abbrev eventsTable : taxis.Index := (HasModel.model Schema.Events).index
private abbrev actorsTable : taxis.Index := (HasModel.model Schema.Actors).index

/-- An event with its actor, where it still has one. -/
private abbrev eventView : View taxis :=
  (Table.view eventsTable).prod (Table.view actorsTable).nullable

private abbrev eventCol (c : Schema.EventsIndex) : eventView.Index := Sum.inl c
private abbrev eventActorCol (c : Schema.ActorsIndex) : eventView.Index := Sum.inr c

/-- The join every read here starts from. -/
private def eventJoin : Query taxis eventView :=
  .leftJoin (.all eventsTable) (.all actorsTable)
    (.eq (.var (Sum.inl EventsIndex.actor_id) .int) (.var (Sum.inr ActorsIndex.id) .int))

/-- A joined row as the domain value. -/
private def eventOfRow (row : eventView.Entry) : Event :=
  { id := ⟨Int64.ofInt (row.value (eventCol EventsIndex.id))⟩
    issueId := ⟨Int64.ofInt (row.value (eventCol EventsIndex.issue_id))⟩
    actorId := (row.value (eventCol EventsIndex.actor_id)).map fun a => ⟨Int64.ofInt a⟩
    actorName := row.value (eventActorCol ActorsIndex.display_name)
    actorBot := (row.value (eventActorCol ActorsIndex.bot)).getD false
    kind := row.value (eventCol EventsIndex.kind)
    data := (Json.parse (row.value (eventCol EventsIndex.data))).toOption.getD (Json.mkObj [])
    createdAt := ⟨Int64.ofInt (row.value (eventCol EventsIndex.created_at))⟩ }

/-- Event kinds that do not notify participants (title/description/goal edits and label changes are
    frequent and rarely the activity someone wants to be pinged about; see issue #26). Still
    recorded as events, just not fanned out as notifications. -/
private def silentEventKinds : List String := ["title", "description", "goal", "labels"]

/-- Append one event to an issue's history. Recording activity also stamps the issue's
    `updated_at`, so "last updated" reflects comments, artifact/check changes, etc. — not just
    edits to the issue's own fields. Fans out a notification to the issue's participants (except
    `actorId`, who triggered it), unless `kind` is a silent one.

    Both timestamps come from `nowSeconds`, where the insert left `created_at` to the column
    default and the stamp on the issue was `unixepoch()`; the two agree to the second. -/
def recordEvent (db : Conn) (issueId : IssueId) (actorId : Option ActorId) (kind : String)
    (data : Json := Json.mkObj []) : IO Unit := do
  let now ← nowSeconds
  run db do
    HasModel.insert
      ({ id := 0, issue_id := issueId.val.toInt, actor_id := actorId.map (·.val.toInt),
         kind := kind, data := data.compress, created_at := now } : Schema.Events)
    discard <| HasModel.update (α := Schema.Issues)
      { value
          | .updated_at => some (.int now)
          | _ => none
        condition := .eq (.var IssuesIndex.id .int) (.int issueId.val.toInt) }
  unless silentEventKinds.contains kind do
    fanOutNotification db issueId actorId kind data

/-- All events on an issue, oldest first. -/
def issueEvents (db : Conn) (issueId : IssueId) : IO (Array Event) := do
  let rows ← run db <| DBMonad.lookup <|
    Query.orderBy [{ column := eventCol EventsIndex.id }]
      (.filter (.eq (.var (eventCol EventsIndex.issue_id) .int) (.int issueId.val.toInt))
        eventJoin)
  return rows.map eventOfRow

/-- Ids present in `new` but not in `old`. -/
private def added [BEq α] (old new : Array α) : Array α := new.filter (!old.contains ·)

/-- Diff two versions of an issue and record one event per changed field. Content edits (title,
    description, goal) carry the previous and new value; relation changes carry added/removed id
    sets. -/
def recordIssueChanges (db : Conn) (issueId : IssueId) (actorId : Option ActorId)
    (old new : Issue) : IO Unit := do
  if old.title != new.title then
    recordEvent db issueId actorId "title" (Json.mkObj [("from", old.title), ("to", new.title)])
  if old.description != new.description then
    recordEvent db issueId actorId "description" (Json.mkObj [("from", old.description), ("to", new.description)])
  if old.goal != new.goal then
    recordEvent db issueId actorId "goal" (Json.mkObj [("from", old.goal), ("to", new.goal)])
  if old.state != new.state then
    recordEvent db issueId actorId "state" (Json.mkObj [("from", toJson old.state), ("to", toJson new.state)])
  if old.locked != new.locked then
    recordEvent db issueId actorId "locked" (Json.mkObj [("to", new.locked)])
  if (old.parent.map (·.val)) != (new.parent.map (·.val)) then
    recordEvent db issueId actorId "parent" (Json.mkObj [("from", toJson old.parent), ("to", toJson new.parent)])
  if (old.deadline.map (·.epochSeconds)) != (new.deadline.map (·.epochSeconds)) then
    recordEvent db issueId actorId "deadline" (Json.mkObj [("from", toJson old.deadline), ("to", toJson new.deadline)])
  let rel (kind : String) (o n : Array Int64) : IO Unit := do
    let add := added o n
    let rem := added n o
    unless add.isEmpty && rem.isEmpty do
      recordEvent db issueId actorId kind (Json.mkObj [("added", toJson add), ("removed", toJson rem)])
  rel "dependencies" (old.dependencies.map (·.val)) (new.dependencies.map (·.val))
  rel "assignees" (old.assignees.map (·.val)) (new.assignees.map (·.val))
  rel "visibility" (old.visibility.map (·.val)) (new.visibility.map (·.val))
  rel "labels" (old.labels.map (·.val)) (new.labels.map (·.val))

end Taxis.Db
