import Taxis.Db.Connection
import Taxis.Db.Events
import Taxis.Db.Notifications
import Taxis.Domain.Input
import Std.Data.HashSet.Basic

/-!
# Issue repository

Issues carry several relations: a single hierarchical **parent** (stored as a nullable column on
the issue, guarded against forming a cycle up the parent chain), a set of **dependencies** (other
issues it depends on — the dependency graph), assignees, visibility groups, plus the ids of their
attached artifacts and checks.
-/

open Lean

namespace Taxis.Db

private structure IssueRow where
  id : IssueId
  title : String
  description : String
  goal : String
  state : IssueState
  locked : Bool
  parent : Option IssueId
  creatorId : Option ActorId
  deadline : Option Timestamp
  createdAt : Timestamp
  updatedAt : Timestamp
deriving SQLite.Row, Inhabited

private structure DisplayNameRow where
  displayName : String
deriving SQLite.Row, Inhabited

/-- The display name of an actor, if they still exist. Used to denormalise the issue creator's
    name without needing a join in every issue query (which `RETURNING` can't express anyway). -/
private def displayNameOf (db : Conn) (id : ActorId) : IO (Option String) := do
  let rows ← (← db query!"SELECT display_name FROM actors WHERE id = {id}" as DisplayNameRow).toArray
  pure (rows[0]?.map (·.displayName))

private def issueDependencies (db : Conn) (id : IssueId) : IO (Array IssueId) := do
  (← db query!"SELECT depends_on_id FROM issue_dependencies WHERE issue_id = {id} ORDER BY depends_on_id" as IssueId).toArray

private def issueAssignees (db : Conn) (id : IssueId) : IO (Array ActorId) := do
  (← db query!"SELECT actor_id FROM issue_assignees WHERE issue_id = {id} ORDER BY actor_id" as ActorId).toArray

private def issueVisibility (db : Conn) (id : IssueId) : IO (Array GroupId) := do
  (← db query!"SELECT group_id FROM issue_visibility WHERE issue_id = {id} ORDER BY group_id" as GroupId).toArray

private def issueArtifactIds (db : Conn) (id : IssueId) : IO (Array ArtifactId) := do
  (← db query!"SELECT id FROM artifacts WHERE issue_id = {id} ORDER BY id" as ArtifactId).toArray

private def issueCheckIds (db : Conn) (id : IssueId) : IO (Array CheckId) := do
  (← db query!"SELECT id FROM checks WHERE issue_id = {id} ORDER BY id" as CheckId).toArray

private def issueLabels (db : Conn) (id : IssueId) : IO (Array LabelId) := do
  (← db query!"SELECT label_id FROM issue_labels WHERE issue_id = {id} ORDER BY label_id" as LabelId).toArray

private def IssueRow.toIssue (r : IssueRow) (db : Conn) : IO Issue := do
  pure {
    id := r.id, title := r.title, description := r.description, goal := r.goal, state := r.state,
    locked := r.locked,
    labels := ← issueLabels db r.id,
    parent := r.parent,
    dependencies := ← issueDependencies db r.id,
    assignees := ← issueAssignees db r.id,
    artifacts := ← issueArtifactIds db r.id,
    visibility := ← issueVisibility db r.id,
    checks := ← issueCheckIds db r.id,
    creatorId := r.creatorId,
    creatorName := ← (match r.creatorId with | some cid => displayNameOf db cid | none => pure none),
    deadline := r.deadline,
    createdAt := r.createdAt, updatedAt := r.updatedAt }

/-- Read the parent id of an issue directly (a single climbing step). -/
private structure ParentRow where
  parent : Option IssueId
deriving SQLite.Row, Inhabited

private def parentOf (db : Conn) (id : IssueId) : IO (Option IssueId) := do
  let rows ← (← db query!"SELECT parent_id FROM issues WHERE id = {id}" as ParentRow).toArray
  pure (rows[0]?.bind (·.parent))

/-- Whether climbing the parent chain from `start` reaches `target` (so making `target`'s parent
    `start` would close a cycle). A visited set guards against pre-existing cycles. -/
private partial def climbReaches (db : Conn) (target : IssueId) (start : Option IssueId)
    (seen : Std.HashSet Int64) : IO Bool := do
  match start with
  | none => pure false
  | some c =>
    if c.val == target.val then pure true
    else if seen.contains c.val then pure false
    else climbReaches db target (← parentOf db c) (seen.insert c.val)

/-- Set (or clear) the single hierarchical parent of `child`, rejecting a self-parent or any
    assignment that would create a cycle up the parent chain. -/
private def setParent (db : Conn) (child : IssueId) (parent : Option IssueId) : IO Unit := do
  match parent with
  | some p =>
    if p.val == child.val then
      validationError "an issue cannot be its own parent"
    if ← climbReaches db child (some p) {} then
      validationError s!"setting parent {p.val} would create a parent cycle"
  | none => pure ()
  db exec!"UPDATE issues SET parent_id = {parent} WHERE id = {child}"

/-- Replace the dependency set of `issue`. Self-dependencies are dropped; no acyclicity is
    imposed (the dependency graph may contain cycles). -/
private def setDependencies (db : Conn) (issue : IssueId) (deps : Array IssueId) : IO Unit := do
  db exec!"DELETE FROM issue_dependencies WHERE issue_id = {issue}"
  for d in deps do
    if d.val != issue.val then
      db exec!"INSERT OR IGNORE INTO issue_dependencies (issue_id, depends_on_id) VALUES ({issue}, {d})"

private def setAssignees (db : Conn) (issue : IssueId) (actors : Array ActorId) : IO Unit := do
  db exec!"DELETE FROM issue_assignees WHERE issue_id = {issue}"
  for a in actors do
    db exec!"INSERT OR IGNORE INTO issue_assignees (issue_id, actor_id) VALUES ({issue}, {a})"

private def setVisibility (db : Conn) (issue : IssueId) (groups : Array GroupId) : IO Unit := do
  db exec!"DELETE FROM issue_visibility WHERE issue_id = {issue}"
  for g in groups do
    db exec!"INSERT OR IGNORE INTO issue_visibility (issue_id, group_id) VALUES ({issue}, {g})"

private def setLabels (db : Conn) (issue : IssueId) (labels : Array LabelId) : IO Unit := do
  db exec!"DELETE FROM issue_labels WHERE issue_id = {issue}"
  for l in labels do
    db exec!"INSERT OR IGNORE INTO issue_labels (issue_id, label_id) VALUES ({issue}, {l})"

/-- Fetch an issue by id, with all relations loaded. -/
def getIssue (db : Conn) (id : IssueId) : IO (Option Issue) := do
  let rows ← (← db query!"SELECT id, title, description, goal, state, locked, parent_id, creator_id, deadline, created_at, updated_at FROM issues WHERE id = {id}" as IssueRow).toArray
  match rows[0]? with
  | none => pure none
  | some r => some <$> r.toIssue db

/-- List issues matching optional filters, most-recently-updated first.
    Text search (`q`) matches title or description via `LIKE`; `labelId` filters to issues
    carrying that label. `limit`/`offset` page the result (a `none` limit returns everything). -/
def listIssues (db : Conn) (state : Option IssueState) (labelId : Option LabelId)
    (q : Option String) (assignee : Option ActorId)
    (limit : Option Nat := none) (offset : Nat := 0) : IO (Array Issue) := do
  let stateStr := state.map (·.toString)
  let qlike := q.map (fun s => "%" ++ s ++ "%")
  -- SQLite treats a negative LIMIT as "no limit".
  let lim : Int64 := match limit with | some n => Int64.ofNat n | none => -1
  let off : Int64 := Int64.ofNat offset
  let rows ← (← db query!"
    SELECT id, title, description, goal, state, locked, parent_id, creator_id, deadline, created_at, updated_at FROM issues
    WHERE ({stateStr} IS NULL OR state = {stateStr})
      AND ({labelId} IS NULL OR id IN (SELECT issue_id FROM issue_labels WHERE label_id = {labelId}))
      AND ({qlike} IS NULL OR title LIKE {qlike} OR description LIKE {qlike})
      AND ({assignee} IS NULL OR id IN (SELECT issue_id FROM issue_assignees WHERE actor_id = {assignee}))
    ORDER BY updated_at DESC, id DESC
    LIMIT {lim} OFFSET {off}" as IssueRow).toArray
  rows.mapM (·.toIssue db)

/-- Create an issue with its relations, attributed to `creatorId`. The creator and every assignee
    automatically participate (get notified of future activity). May raise a validation error on
    a cyclic parent. -/
def createIssue (db : Conn) (input : IssueInput) (creatorId : Option ActorId := none) : IO Issue :=
  withTransaction db do
    let rows ← (← db query!"INSERT INTO issues (title, description, goal, state, locked, creator_id, deadline)
      VALUES ({input.title}, {input.description}, {input.goal}, {input.state}, {input.locked}, {creatorId}, {input.deadline})
      RETURNING id, title, description, goal, state, locked, parent_id, creator_id, deadline, created_at, updated_at" as IssueRow).toArray
    let r := rows[0]!
    setLabels db r.id input.labels
    setParent db r.id input.parent
    setDependencies db r.id input.dependencies
    setAssignees db r.id input.assignees
    setVisibility db r.id input.visibility
    if let some cid := creatorId then addParticipant db r.id cid
    for a in input.assignees do addParticipant db r.id a
    match ← getIssue db r.id with
    | some i => pure i
    | none => throw (IO.userError "issue vanished after insert")

private def sameSet (a b : Array Int64) : Bool :=
  a.size == b.size && a.all (b.contains ·)

/-- Update an issue; absent fields are unchanged. Returns `none` if it does not exist.
    A locked issue rejects changes to its title, description, goal, parent, or dependencies.
    `actorId` attributes the recorded history events to whoever made the change. -/
def updateIssue (db : Conn) (id : IssueId) (upd : IssueUpdate)
    (actorId : Option ActorId := none) : IO (Option Issue) :=
  withTransaction db do
    match ← getIssue db id with
    | none => pure none
    | some cur =>
      if cur.locked then
        match upd.title with
        | some t => if t != cur.title then validationError "issue is locked: title cannot be changed"
        | none => pure ()
        match upd.description with
        | some d => if d != cur.description then validationError "issue is locked: description cannot be changed"
        | none => pure ()
        match upd.goal with
        | some g => if g != cur.goal then validationError "issue is locked: goal cannot be changed"
        | none => pure ()
        match upd.parent with
        | some p =>
          if (p.map (·.val)) != (cur.parent.map (·.val)) then
            validationError "issue is locked: parent cannot be changed"
        | none => pure ()
        match upd.dependencies with
        | some ds =>
          unless sameSet (ds.map (·.val)) (cur.dependencies.map (·.val)) do
            validationError "issue is locked: dependencies cannot be changed"
        | none => pure ()
      let title := upd.title.getD cur.title
      let description := upd.description.getD cur.description
      let goal := upd.goal.getD cur.goal
      let state := upd.state.getD cur.state
      let locked := upd.locked.getD cur.locked
      let deadline := upd.deadline.getD cur.deadline
      db exec!"UPDATE issues SET title = {title}, description = {description}, goal = {goal},
        state = {state}, locked = {locked}, deadline = {deadline}, updated_at = unixepoch() WHERE id = {id}"
      if let some ls := upd.labels then setLabels db id ls
      if let some p := upd.parent then setParent db id p
      if let some ds := upd.dependencies then setDependencies db id ds
      if let some as := upd.assignees then
        setAssignees db id as
        -- Newly-assigned actors automatically participate; `addParticipant` is idempotent.
        for a in as do addParticipant db id a
      if let some vs := upd.visibility then setVisibility db id vs
      let new ← getIssue db id
      if let some n := new then recordIssueChanges db id actorId cur n
      pure new

/-- Delete an issue. Returns whether a row was removed. -/
def deleteIssue (db : Conn) (id : IssueId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM issues WHERE id = {id} RETURNING id" as IssueId).toArray
  pure !removed.isEmpty

/-- All dependency edges in the tracker, as `(issue, dependsOn)` id pairs. Used for the graph. -/
def allDependencyEdges (db : Conn) : IO (Array (IssueId × IssueId)) := do
  (← db query!"SELECT issue_id, depends_on_id FROM issue_dependencies" as (IssueId × IssueId)).toArray

end Taxis.Db
