import Issues.Db.Connection
import Issues.Domain.Input
import Std.Data.HashSet.Basic

/-!
# Issue repository

Issues carry several relations: parents (forming a dependency DAG), assignees, visibility
groups, plus the ids of their attached artifacts and checks. Setting parents is guarded
against introducing cycles.
-/

open Lean

namespace Issues.Db

private structure IssueRow where
  id : IssueId
  title : String
  description : String
  state : IssueState
  locked : Bool
  createdAt : Timestamp
  updatedAt : Timestamp
deriving SQLite.Row, Inhabited

private def issueParents (db : Conn) (id : IssueId) : IO (Array IssueId) := do
  (← db query!"SELECT parent_id FROM issue_parents WHERE child_id = {id} ORDER BY parent_id" as IssueId).toArray

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
    id := r.id, title := r.title, description := r.description, state := r.state, locked := r.locked,
    labels := ← issueLabels db r.id,
    parents := ← issueParents db r.id,
    assignees := ← issueAssignees db r.id,
    artifacts := ← issueArtifactIds db r.id,
    visibility := ← issueVisibility db r.id,
    checks := ← issueCheckIds db r.id,
    createdAt := r.createdAt, updatedAt := r.updatedAt }

/-- Collect all ancestors (parents, grandparents, …) of `start`, guarding against pre-existing
    cycles via a visited set. -/
private def ancestors (db : Conn) (start : IssueId) : IO (Std.HashSet Int64) := do
  let mut seen : Std.HashSet Int64 := {}
  let mut frontier := #[start]
  while !frontier.isEmpty do
    let cur := frontier.back!
    frontier := frontier.pop
    let ps ← issueParents db cur
    for p in ps do
      if !seen.contains p.val then
        seen := seen.insert p.val
        frontier := frontier.push p
  return seen

/-- Replace the parents of `child`, rejecting any assignment that would create a cycle. -/
private def setParents (db : Conn) (child : IssueId) (parents : Array IssueId) : IO Unit := do
  db exec!"DELETE FROM issue_parents WHERE child_id = {child}"
  for p in parents do
    if p.val == child.val then
      validationError "an issue cannot be its own parent"
    -- Adding edge child → p creates a cycle iff `child` is already an ancestor of `p`.
    let anc ← ancestors db p
    if anc.contains child.val then
      validationError s!"adding parent {p.val} would create a dependency cycle"
    db exec!"INSERT OR IGNORE INTO issue_parents (child_id, parent_id) VALUES ({child}, {p})"

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
  let rows ← (← db query!"SELECT id, title, description, state, locked, created_at, updated_at FROM issues WHERE id = {id}" as IssueRow).toArray
  match rows[0]? with
  | none => pure none
  | some r => some <$> r.toIssue db

/-- List issues matching optional filters, most-recently-updated first.
    Text search (`q`) matches title or description via `LIKE`; `labelId` filters to issues
    carrying that label. -/
def listIssues (db : Conn) (state : Option IssueState) (labelId : Option LabelId)
    (q : Option String) (assignee : Option ActorId) : IO (Array Issue) := do
  let stateStr := state.map (·.toString)
  let qlike := q.map (fun s => "%" ++ s ++ "%")
  let rows ← (← db query!"
    SELECT id, title, description, state, locked, created_at, updated_at FROM issues
    WHERE ({stateStr} IS NULL OR state = {stateStr})
      AND ({labelId} IS NULL OR id IN (SELECT issue_id FROM issue_labels WHERE label_id = {labelId}))
      AND ({qlike} IS NULL OR title LIKE {qlike} OR description LIKE {qlike})
      AND ({assignee} IS NULL OR id IN (SELECT issue_id FROM issue_assignees WHERE actor_id = {assignee}))
    ORDER BY updated_at DESC, id DESC" as IssueRow).toArray
  rows.mapM (·.toIssue db)

/-- Create an issue with its relations. May raise a validation error on a cyclic parent. -/
def createIssue (db : Conn) (input : IssueInput) : IO Issue :=
  withTransaction db do
    let rows ← (← db query!"INSERT INTO issues (title, description, state, locked)
      VALUES ({input.title}, {input.description}, {input.state}, {input.locked})
      RETURNING id, title, description, state, locked, created_at, updated_at" as IssueRow).toArray
    let r := rows[0]!
    setLabels db r.id input.labels
    setParents db r.id input.parents
    setAssignees db r.id input.assignees
    setVisibility db r.id input.visibility
    r.toIssue db

private def sameSet (a b : Array Int64) : Bool :=
  a.size == b.size && a.all (b.contains ·)

/-- Update an issue; absent fields are unchanged. Returns `none` if it does not exist.
    A locked issue rejects changes to its title, description, or dependency (parent) relations. -/
def updateIssue (db : Conn) (id : IssueId) (upd : IssueUpdate) : IO (Option Issue) :=
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
        match upd.parents with
        | some ps =>
          unless sameSet (ps.map (·.val)) (cur.parents.map (·.val)) do
            validationError "issue is locked: dependencies cannot be changed"
        | none => pure ()
      let title := upd.title.getD cur.title
      let description := upd.description.getD cur.description
      let state := upd.state.getD cur.state
      let locked := upd.locked.getD cur.locked
      db exec!"UPDATE issues SET title = {title}, description = {description}, state = {state},
        locked = {locked}, updated_at = unixepoch() WHERE id = {id}"
      if let some ls := upd.labels then setLabels db id ls
      if let some ps := upd.parents then setParents db id ps
      if let some as := upd.assignees then setAssignees db id as
      if let some vs := upd.visibility then setVisibility db id vs
      getIssue db id

/-- Delete an issue. Returns whether a row was removed. -/
def deleteIssue (db : Conn) (id : IssueId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM issues WHERE id = {id} RETURNING id" as IssueId).toArray
  pure !removed.isEmpty

/-- All parent edges in the tracker, as `(child, parent)` id pairs. Used for the graph view. -/
def allParentEdges (db : Conn) : IO (Array (IssueId × IssueId)) := do
  (← db query!"SELECT child_id, parent_id FROM issue_parents" as (IssueId × IssueId)).toArray

end Issues.Db
