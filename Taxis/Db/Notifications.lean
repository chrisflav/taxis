import Taxis.Db.Connection
import Taxis.Db.Schema

/-!
# Participants and notifications

Participants opt in to an issue's activity (automatically as creator/assignee, or explicitly via
`addParticipant`); `fanOutNotification` is the single place that turns one piece of activity into
one notification row per participant, excluding whoever triggered it.

A notification has two independent flags: `read` (seen — set when the recipient clicks through to
the issue) and `done` (resolved — set only by an explicit "mark as done" action). Viewing a
notification never implies it's done.

Every statement here is a `Query`, an `Insert`, an `Update` or a `Delete` of the `db` library
rather than SQL text, so the column names, their types and the tables they belong to are checked
when this module is compiled.
-/

open Lean

namespace Taxis.Db

open Schema (NotificationsIndex IssuesIndex IssueLabelsIndex IssueParticipantsIndex)

/-! ### The tables this module reads and writes

Named once, as indices into the one database every `@[model]` structure in `Taxis.Db.Schema`
belongs to. -/

private abbrev taxis : Database := HasModel.database Schema.Notifications

private abbrev notificationsTable : taxis.Index := (HasModel.model Schema.Notifications).index
private abbrev issuesTable : taxis.Index := (HasModel.model Schema.Issues).index
private abbrev issueLabelsTable : taxis.Index := (HasModel.model Schema.IssueLabels).index

/-- The conjunction of a list of conditions, `TRUE` when it is empty.

    An absent filter contributes no condition rather than a tautology the reader has to skip past:
    the translation drops a `TRUE` conjunct as it merges the conditions, so the generated `WHERE`
    mentions exactly the filters the caller supplied. -/
private def conjoin {view : View taxis} (es : List (DBExpr taxis view .bool)) :
    DBExpr taxis view .bool :=
  es.foldl (init := .true) fun acc e => .and acc e

/-- Add `actorId` as a participant of `issueId`, if not already one. -/
def addParticipant (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Unit :=
  run db do
    -- The pair is the primary key, so a second call for the same actor conflicts and is skipped.
    discard <| HasModel.insertIfAbsent
      ({ issue_id := issueId.val.toInt, actor_id := actorId.val.toInt } :
        Schema.IssueParticipants)

/-- Remove `actorId` as a participant of `issueId`. -/
def removeParticipant (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Unit :=
  run db do
    discard <| HasModel.delete (α := Schema.IssueParticipants)
      (.and (.eq (.var IssueParticipantsIndex.issue_id .int) (.int issueId.val.toInt))
            (.eq (.var IssueParticipantsIndex.actor_id .int) (.int actorId.val.toInt)))

/-- All participants of an issue. -/
def listParticipants (db : Conn) (issueId : IssueId) : IO (Array ActorId) := do
  let rows ← run db <| HasModel.fetch (α := Schema.IssueParticipants)
    { query := .orderBy [{ column := IssueParticipantsIndex.actor_id }]
        (.filter (.eq (.var IssueParticipantsIndex.issue_id .int) (.int issueId.val.toInt))
          (.all _)) }
  return rows.map fun r => ⟨Int64.ofInt r.actor_id⟩

/-- Whether `actorId` participates in `issueId`. -/
def isParticipant (db : Conn) (issueId : IssueId) (actorId : ActorId) : IO Bool := do
  let rows ← run db <| HasModel.fetch (α := Schema.IssueParticipants)
    { query := .filter
        (.and (.eq (.var IssueParticipantsIndex.issue_id .int) (.int issueId.val.toInt))
              (.eq (.var IssueParticipantsIndex.actor_id .int) (.int actorId.val.toInt)))
        (.all _) }
  return !rows.isEmpty

/-- One notification row, unread and not done, created now.

    The insert supplies every column: the model layer sends the whole row, and the `unixepoch()`
    the database used to fill `created_at` in with is now `nowSeconds`. -/
private def notificationRow (actorId : ActorId) (issueId : IssueId) (kind data : String)
    (now : Int) : Schema.Notifications :=
  { id := 0, actor_id := actorId.val.toInt, issue_id := issueId.val.toInt, kind := kind,
    data := data, read := false, done := false, created_at := now }

/-- Notify every participant of `issueId` about one piece of activity, except `exclude` (the actor
    who triggered it, if any) — so nobody gets notified about their own action. -/
def fanOutNotification (db : Conn) (issueId : IssueId) (exclude : Option ActorId)
    (kind : String) (data : Json := Json.mkObj []) : IO Unit := do
  let participants ← listParticipants db issueId
  let dataStr := data.compress
  let now ← nowSeconds
  run db do
    for actorId in participants do
      if (exclude.map (·.val)) != some actorId.val then
        HasModel.insert (notificationRow actorId issueId kind dataStr now)

/-- Notify exactly one actor about one piece of activity (unlike `fanOutNotification`, which fans
    out to every participant) — used for a targeted review request. -/
def notifyActor (db : Conn) (actorId : ActorId) (issueId : IssueId) (kind : String)
    (data : Json := Json.mkObj []) : IO Unit := do
  let now ← nowSeconds
  run db <| HasModel.insert (notificationRow actorId issueId kind data.compress now)

/-! ### The notification list

A notification is listed with the title of the issue it is about, which is a join. Reading the
whole `issues` row for it would carry every description and goal in the result past a caller that
renders one column of them, so the join is projected onto the notification's own columns and that
single title. The filters, which also test the issue's parent, are written under the projection,
over the join's own view. -/

/-- `issues.title`, as a view of its own. -/
private def issueTitleView : View taxis where
  Index := IUnit "title"
  name _ := .ident { tableName := issuesTable, columnName := IssuesIndex.title }

/-- What the filters are written over: a notification row next to its whole issue. -/
private abbrev notificationJoinView : View taxis :=
  (Table.view notificationsTable).prod (Table.view issuesTable)

/-- What a listed notification is read from: its own columns and its issue's title. -/
private abbrev notificationView : View taxis :=
  (Table.view notificationsTable).prod issueTitleView

private def notificationHom : notificationView.Hom notificationJoinView :=
  View.Hom.ofMap fun i =>
    match i with
    | Sum.inl c => Sum.inl c
    | Sum.inr _ => Sum.inr IssuesIndex.title

private abbrev notifCol (c : Schema.NotificationsIndex) : notificationView.Index := Sum.inl c
private abbrev issueTitleCol : notificationView.Index := Sum.inr ⟨⟩

/-- The notifications a condition matches, each with the title of its issue. The inner join is a
    cross join filtered by the condition relating the two sides, which is what an inner join is. -/
private def notificationQuery (cond : DBExpr taxis notificationJoinView .bool) :
    Query taxis notificationView :=
  .project notificationHom
    (.filter
      (.and (.eq (.var (Sum.inl NotificationsIndex.issue_id) .int)
                 (.var (Sum.inr IssuesIndex.id) .int))
        cond)
      (.join (.all notificationsTable) (.all issuesTable)))

private def notificationOfRow (row : notificationView.Entry) : Notification :=
  { id := ⟨Int64.ofInt (row.value (notifCol NotificationsIndex.id))⟩
    actorId := ⟨Int64.ofInt (row.value (notifCol NotificationsIndex.actor_id))⟩
    issueId := ⟨Int64.ofInt (row.value (notifCol NotificationsIndex.issue_id))⟩
    issueTitle := row.value issueTitleCol
    kind := row.value (notifCol NotificationsIndex.kind)
    data :=
      (Json.parse (row.value (notifCol NotificationsIndex.data))).toOption.getD (Json.mkObj [])
    read := row.value (notifCol NotificationsIndex.read)
    done := row.value (notifCol NotificationsIndex.done)
    createdAt := ⟨Int64.ofInt (row.value (notifCol NotificationsIndex.created_at))⟩ }

/-- List `actorId`'s notifications, filtered and sorted. `readFilter`/`kind`/`doneFilter`/
    `parentId`/`labelId`/`q` narrow the result (each `none` disables that filter); `q` matches the
    notification's issue title. `limit`/`offset` page it (a `none` limit returns everything).

    Each filter contributes a condition only when it is given, where the assembled statement
    carried an `IS NULL OR` for every one of them whether or not it was in use. The title match
    escapes the `LIKE` wildcards in `q`, which the hand-written `LIKE` this replaces did not: a
    search for `100%` now looks for those four characters rather than for everything beginning
    `100`. -/
def listNotifications (db : Conn) (actorId : ActorId) (readFilter : Option Bool := none)
    (kind : Option String := none) (doneFilter : Option Bool := none)
    (parentId : Option IssueId := none) (labelId : Option LabelId := none)
    (q : Option String := none) (sortAsc : Bool := false) (limit : Option Nat := none)
    (offset : Nat := 0) : IO (Array Notification) := do
  let conds : List (Option (DBExpr taxis notificationJoinView .bool)) :=
    [ some (.eq (.var (Sum.inl NotificationsIndex.actor_id) .int) (.int actorId.val.toInt)),
      readFilter.map fun b =>
        .eq (.var (Sum.inl NotificationsIndex.read) .bool) (if b then .true else .false),
      kind.map fun k => .eq (.var (Sum.inl NotificationsIndex.kind) .text) (.text k),
      doneFilter.map fun b =>
        .eq (.var (Sum.inl NotificationsIndex.done) .bool) (if b then .true else .false),
      parentId.map fun p => .eq (.var (Sum.inr IssuesIndex.parent_id) .int) (.int p.val.toInt),
      labelId.map fun l =>
        .inSubquery (.var (Sum.inr IssuesIndex.id) .int)
          (.filter (.eq (.var IssueLabelsIndex.label_id .int) (.int l.val.toInt))
            (.all issueLabelsTable))
          IssueLabelsIndex.issue_id,
      q.map fun s => .contains (.var (Sum.inr IssuesIndex.title) .text) s ]
  let ordered : Query taxis notificationView :=
    .orderBy [{ column := notifCol NotificationsIndex.id,
                direction := if sortAsc then .asc else .desc }]
      (notificationQuery (conjoin (conds.filterMap id)))
  let skipped := if offset == 0 then ordered else Query.offset offset ordered
  let paged := match limit with
    | some n => Query.limit n skipped
    | none => skipped
  let rows ← run db <| DBMonad.lookup paged
  return rows.map notificationOfRow

/-- Number of unread notifications for `actorId`. Counted by the database rather than by fetching
    the rows and counting them here. -/
def unreadNotificationCount (db : Conn) (actorId : ActorId) : IO Nat := do
  let n ← run db <| HasModel.count (α := Schema.Notifications)
    { query := .filter
        (.and (.eq (.var NotificationsIndex.actor_id .int) (.int actorId.val.toInt))
              (.eq (.var NotificationsIndex.read .bool) .false))
        (.all _) }
  return n.toNat

/-- Mark one notification read, only if it belongs to `actorId`. Returns whether it existed.
    Does *not* mark it done — reading and resolving are independent. -/
def markNotificationRead (db : Conn) (id : NotificationId) (actorId : ActorId) : IO Bool := do
  let updated ← run db <| HasModel.update (α := Schema.Notifications)
    { value
        | .read => some .true
        | _ => none
      condition := .and (.eq (.var NotificationsIndex.id .int) (.int id.val.toInt))
                        (.eq (.var NotificationsIndex.actor_id .int) (.int actorId.val.toInt)) }
  return updated > 0

/-- Mark every one of `actorId`'s notifications read. -/
def markAllNotificationsRead (db : Conn) (actorId : ActorId) : IO Unit :=
  run db do
    discard <| HasModel.update (α := Schema.Notifications)
      { value
          | .read => some .true
          | _ => none
        condition := .and (.eq (.var NotificationsIndex.actor_id .int) (.int actorId.val.toInt))
                          (.eq (.var NotificationsIndex.read .bool) .false) }

/-- Mark one notification done (and, implicitly, read), only if it belongs to `actorId`. Returns
    whether it existed. -/
def markNotificationDone (db : Conn) (id : NotificationId) (actorId : ActorId) : IO Bool := do
  let updated ← run db <| HasModel.update (α := Schema.Notifications)
    { value
        | .read => some .true
        | .done => some .true
        | _ => none
      condition := .and (.eq (.var NotificationsIndex.id .int) (.int id.val.toInt))
                        (.eq (.var NotificationsIndex.actor_id .int) (.int actorId.val.toInt)) }
  return updated > 0

end Taxis.Db
