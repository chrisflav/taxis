import Taxis.Db.Connection

/-!
# Participants and notifications

Participants opt in to an issue's activity (automatically as creator/assignee, or explicitly via
`addParticipant`); `fanOutNotification` is the single place that turns one piece of activity into
one notification row per participant, excluding whoever triggered it.

A notification has two independent flags: `read` (seen — set when the recipient clicks through to
the issue) and `done` (resolved — set only by an explicit "mark as done" action). Viewing a
notification never implies it's done.
-/

open Lean

namespace Taxis.Db

/-- Add `actorId` as a participant of `issueId`, if not already one. -/
def addParticipant (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Unit := do
  db exec!"INSERT OR IGNORE INTO issue_participants (issue_id, actor_id) VALUES ({issueId}, {actorId})"

/-- Remove `actorId` as a participant of `issueId`. -/
def removeParticipant (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Unit := do
  db exec!"DELETE FROM issue_participants WHERE issue_id = {issueId} AND actor_id = {actorId}"

/-- All participants of an issue. -/
def listParticipants (db : Conn) (issueId : IssueId) : IO (Array ActorId) := do
  (← db query!"SELECT actor_id FROM issue_participants WHERE issue_id = {issueId} ORDER BY actor_id" as ActorId).toArray

/-- Whether `actorId` participates in `issueId`. -/
def isParticipant (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Bool := do
  let rows ← (← db query!"SELECT actor_id FROM issue_participants WHERE issue_id = {issueId} AND actor_id = {actorId}" as ActorId).toArray
  pure !rows.isEmpty

/-- Notify every participant of `issueId` about one piece of activity, except `exclude` (the actor
    who triggered it, if any) — so nobody gets notified about their own action. -/
def fanOutNotification (db : Conn) (issueId : IssueId) (exclude : Option ActorId)
    (kind : String) (data : Json := Json.mkObj []) : IO Unit := do
  let participants ← listParticipants db issueId
  let dataStr := data.compress
  for actorId in participants do
    if (exclude.map (·.val)) != some actorId.val then
      db exec!"INSERT INTO notifications (actor_id, issue_id, kind, data) VALUES ({actorId}, {issueId}, {kind}, {dataStr})"

/-- Notify exactly one actor about one piece of activity (unlike `fanOutNotification`, which fans
    out to every participant) — used for a targeted review request. -/
def notifyActor (db : Conn) (actorId : ActorId) (issueId : IssueId) (kind : String)
    (data : Json := Json.mkObj []) : IO Unit := do
  let dataStr := data.compress
  db exec!"INSERT INTO notifications (actor_id, issue_id, kind, data) VALUES ({actorId}, {issueId}, {kind}, {dataStr})"

private structure NotificationRow where
  id : NotificationId
  actorId : ActorId
  issueId : IssueId
  issueTitle : String
  kind : String
  data : String
  read : Bool
  done : Bool
  createdAt : Timestamp
deriving SQLite.Row, Inhabited

private def NotificationRow.toNotification (r : NotificationRow) : Notification :=
  { id := r.id, actorId := r.actorId, issueId := r.issueId, issueTitle := r.issueTitle, kind := r.kind,
    data := (Json.parse r.data).toOption.getD (Json.mkObj []), read := r.read, done := r.done, createdAt := r.createdAt }

/-- List `actorId`'s notifications, filtered and sorted. `readFilter`/`kind`/`doneFilter`/
    `parentId`/`labelId`/`q` narrow the result (each `none` disables that filter); `q` matches the
    notification's issue title. `limit`/`offset` page it (a `none` limit returns everything). -/
def listNotifications (db : Conn) (actorId : ActorId) (readFilter : Option Bool := none)
    (kind : Option String := none) (doneFilter : Option Bool := none)
    (parentId : Option IssueId := none) (labelId : Option LabelId := none) (q : Option String := none)
    (sortAsc : Bool := false) (limit : Option Nat := none) (offset : Nat := 0) :
    IO (Array Notification) := do
  let lim : Int64 := match limit with | some n => Int64.ofNat n | none => -1
  let off : Int64 := Int64.ofNat offset
  let qlike := q.map (fun s => "%" ++ s ++ "%")
  let rows ← if sortAsc then
      (← db query!"
        SELECT n.id, n.actor_id, n.issue_id, i.title, n.kind, n.data, n.read, n.done, n.created_at
        FROM notifications n JOIN issues i ON i.id = n.issue_id
        WHERE n.actor_id = {actorId}
          AND ({readFilter} IS NULL OR n.read = {readFilter})
          AND ({kind} IS NULL OR n.kind = {kind})
          AND ({doneFilter} IS NULL OR n.done = {doneFilter})
          AND ({parentId} IS NULL OR i.parent_id = {parentId})
          AND ({labelId} IS NULL OR i.id IN (SELECT issue_id FROM issue_labels WHERE label_id = {labelId}))
          AND ({qlike} IS NULL OR i.title LIKE {qlike})
        ORDER BY n.id ASC
        LIMIT {lim} OFFSET {off}" as NotificationRow).toArray
    else
      (← db query!"
        SELECT n.id, n.actor_id, n.issue_id, i.title, n.kind, n.data, n.read, n.done, n.created_at
        FROM notifications n JOIN issues i ON i.id = n.issue_id
        WHERE n.actor_id = {actorId}
          AND ({readFilter} IS NULL OR n.read = {readFilter})
          AND ({kind} IS NULL OR n.kind = {kind})
          AND ({doneFilter} IS NULL OR n.done = {doneFilter})
          AND ({parentId} IS NULL OR i.parent_id = {parentId})
          AND ({labelId} IS NULL OR i.id IN (SELECT issue_id FROM issue_labels WHERE label_id = {labelId}))
          AND ({qlike} IS NULL OR i.title LIKE {qlike})
        ORDER BY n.id DESC
        LIMIT {lim} OFFSET {off}" as NotificationRow).toArray
  pure (rows.map NotificationRow.toNotification)

/-- Number of unread notifications for `actorId`. -/
def unreadNotificationCount (db : Conn) (actorId : ActorId) : IO Nat := do
  let rows ← (← db query!"SELECT id FROM notifications WHERE actor_id = {actorId} AND read = 0" as NotificationId).toArray
  pure rows.size

/-- Mark one notification read, only if it belongs to `actorId`. Returns whether it existed.
    Does *not* mark it done — reading and resolving are independent. -/
def markNotificationRead (db : Conn) (id : NotificationId) (actorId : ActorId) : IO Bool := do
  let rows ← (← db query!"UPDATE notifications SET read = 1 WHERE id = {id} AND actor_id = {actorId} RETURNING id" as NotificationId).toArray
  pure !rows.isEmpty

/-- Mark every one of `actorId`'s notifications read. -/
def markAllNotificationsRead (db : Conn) (actorId : ActorId) : IO Unit := do
  db exec!"UPDATE notifications SET read = 1 WHERE actor_id = {actorId} AND read = 0"

/-- Mark one notification done (and, implicitly, read), only if it belongs to `actorId`. Returns
    whether it existed. -/
def markNotificationDone (db : Conn) (id : NotificationId) (actorId : ActorId) : IO Bool := do
  let rows ← (← db query!"UPDATE notifications SET read = 1, done = 1 WHERE id = {id} AND actor_id = {actorId} RETURNING id" as NotificationId).toArray
  pure !rows.isEmpty

end Taxis.Db
