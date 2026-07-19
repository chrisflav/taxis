import Taxis.Db.Connection
import Taxis.Db.Notifications
import Taxis.Domain.Input

/-!
# Event repository

Events form an issue's audit trail. `recordEvent` appends one row (and fans out a notification to
the issue's participants, see `Taxis.Db.fanOutNotification`); `recordIssueChanges` diffs an issue
before and after an update and appends one event per changed field. Reads join `actors` to
denormalise the acting actor's display name and bot flag so the detail view renders without a
second lookup.
-/

open Lean

namespace Taxis.Db

private structure EventRow where
  id : EventId
  issueId : IssueId
  actorId : Option ActorId
  actorName : Option String
  actorBot : Option Bool
  kind : String
  data : String
  createdAt : Timestamp
deriving SQLite.Row, Inhabited

private def EventRow.toEvent (r : EventRow) : Event :=
  { id := r.id, issueId := r.issueId, actorId := r.actorId, actorName := r.actorName,
    actorBot := r.actorBot.getD false, kind := r.kind,
    data := (Json.parse r.data).toOption.getD (Json.mkObj []), createdAt := r.createdAt }

/-- Event kinds that do not notify participants (title/description edits and label changes are
    frequent and rarely the activity someone wants to be pinged about; see issue #26). Still
    recorded as events, just not fanned out as notifications. -/
private def silentEventKinds : List String := ["title", "description", "labels"]

/-- Append one event to an issue's history. Recording activity also stamps the issue's
    `updated_at`, so "last updated" reflects comments, artifact/check changes, etc. — not just
    edits to the issue's own fields. Fans out a notification to the issue's participants (except
    `actorId`, who triggered it), unless `kind` is a silent one. -/
def recordEvent (db : Conn) (issueId : IssueId) (actorId : Option ActorId) (kind : String)
    (data : Json := Json.mkObj []) : IO Unit := do
  let dataStr := data.compress
  db exec!"INSERT INTO events (issue_id, actor_id, kind, data) VALUES ({issueId}, {actorId}, {kind}, {dataStr})"
  db exec!"UPDATE issues SET updated_at = unixepoch() WHERE id = {issueId}"
  unless silentEventKinds.contains kind do
    fanOutNotification db issueId actorId kind data

/-- All events on an issue, oldest first. -/
def issueEvents (db : Conn) (issueId : IssueId) : IO (Array Event) := do
  let rows ← (← db query!"SELECT e.id, e.issue_id, e.actor_id, a.display_name, a.bot, e.kind, e.data, e.created_at
    FROM events e LEFT JOIN actors a ON a.id = e.actor_id WHERE e.issue_id = {issueId} ORDER BY e.id" as EventRow).toArray
  pure (rows.map EventRow.toEvent)

/-- Ids present in `new` but not in `old`. -/
private def added [BEq α] (old new : Array α) : Array α := new.filter (!old.contains ·)

/-- Diff two versions of an issue and record one event per changed field. Content edits (title,
    description) carry the previous and new value; relation changes carry added/removed id sets. -/
def recordIssueChanges (db : Conn) (issueId : IssueId) (actorId : Option ActorId)
    (old new : Issue) : IO Unit := do
  if old.title != new.title then
    recordEvent db issueId actorId "title" (Json.mkObj [("from", old.title), ("to", new.title)])
  if old.description != new.description then
    recordEvent db issueId actorId "description" (Json.mkObj [("from", old.description), ("to", new.description)])
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
