import Taxis.Db.Connection
import Taxis.Db.Events
import Taxis.Db.Notifications
import Taxis.Domain.Input
import Std.Data.HashMap.Basic
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

/-! ### Batched relation loading

`IssueRow.toIssue` issues one query per relation per issue, which is the right shape for reading a
single issue but costs `O(N)` queries when listing. `listIssues` instead loads each relation table
once and groups it by issue id, so a list costs a fixed number of queries no matter how many rows
it returns. The relation tables hold one narrow row per relation, so scanning one beats `N` point
lookups for the whole-list reads the UI actually makes.

Each of those queries is restricted to the issues the query actually matched. Loading the tables
whole is the right cost for an unfiltered list, where the result *is* every issue, and the wrong
one for every filtered read the UI makes — asking for the seventeen children of one issue used to
scan all six relation tables end to end. -/

/-- A row of a two-column `(issue_id, value)` relation table. -/
private structure RelRow where
  issueId : IssueId
  value : Int64
deriving SQLite.Row, Inhabited

private structure ActorNameRow where
  id : ActorId
  displayName : String
deriving SQLite.Row, Inhabited

/-- Group `(issue_id, value)` rows by issue, keeping each query's ordering within an issue. -/
private def groupRel (rows : Array RelRow) : Std.HashMap Int64 (Array Int64) :=
  rows.foldl (fun m r => m.insert r.issueId.val ((m.getD r.issueId.val #[]).push r.value)) {}

/-- Every issue relation, loaded whole and grouped by issue id. -/
private structure RelationIndex where
  labels : Std.HashMap Int64 (Array Int64)
  dependencies : Std.HashMap Int64 (Array Int64)
  assignees : Std.HashMap Int64 (Array Int64)
  visibility : Std.HashMap Int64 (Array Int64)
  artifacts : Std.HashMap Int64 (Array Int64)
  checks : Std.HashMap Int64 (Array Int64)
  /-- Creator display names, denormalised onto every issue at render time. -/
  actorNames : Std.HashMap Int64 String

/-- An empty index, for a result set with no rows to load relations for. -/
private def RelationIndex.empty : RelationIndex :=
  { labels := {}, dependencies := {}, assignees := {}, visibility := {}, artifacts := {},
    checks := {}, actorNames := {} }

/-- An `(id, id, …)` tuple for an `IN` clause.

    Written into the statement rather than bound: a bound parameter list has to have a fixed arity
    and this one is the size of whatever the query matched. These are `Int64`s that came out of the
    database's own `id` columns and go back in as digits, so there is no text to escape and nothing
    a caller could smuggle through. -/
private def idTuple (ids : Array Int64) : String :=
  "(" ++ ", ".intercalate (ids.toList.map toString) ++ ")"

/-- Run a parameterless statement. The `query!` macro binds every interpolation as a parameter,
    which cannot express an `IN` list of statically-unknown length; this takes the assembled SQL. -/
private def queryAll (db : Conn) (α : Type) [SQLite.Row α] (sql : String) : IO (Array α) := do
  ((← SQLite.prepare db sql).resultsAs α).toArray

/-- Every relation of the issues in `ids`, loaded whole and grouped by issue id. -/
private def loadRelationIndex (db : Conn) (ids : Array Int64) : IO RelationIndex := do
  if ids.isEmpty then return RelationIndex.empty
  let scope := idTuple ids
  -- Every relation table has the same shape — `(issue_id, <the other side>)` — so they load the
  -- same way, restricted to the issues in hand and ordered so each issue's values keep the order
  -- the single-issue reads give them.
  let rel (table col : String) : IO (Array RelRow) :=
    queryAll db RelRow
      s!"SELECT issue_id, {col} FROM {table} WHERE issue_id IN {scope} ORDER BY issue_id, {col}"
  let labels ← rel "issue_labels" "label_id"
  let deps ← rel "issue_dependencies" "depends_on_id"
  let assignees ← rel "issue_assignees" "actor_id"
  let visibility ← rel "issue_visibility" "group_id"
  let artifacts ← rel "artifacts" "id"
  let checks ← rel "checks" "id"
  -- Actors are not scoped: the table is small, there is one row per person rather than per
  -- relation, and narrowing it would mean collecting the creator ids first.
  let actors ← (← db query!"SELECT id, display_name FROM actors" as ActorNameRow).toArray
  pure {
    labels := groupRel labels
    dependencies := groupRel deps
    assignees := groupRel assignees
    visibility := groupRel visibility
    artifacts := groupRel artifacts
    checks := groupRel checks
    actorNames := actors.foldl (fun m a => m.insert a.id.val a.displayName) {} }

/-- Assemble an issue from an already-loaded relation index, without touching the database. -/
private def IssueRow.toIssueWith (r : IssueRow) (idx : RelationIndex) : Issue :=
  let rel (m : Std.HashMap Int64 (Array Int64)) : Array Int64 := m.getD r.id.val #[]
  { id := r.id, title := r.title, description := r.description, goal := r.goal, state := r.state,
    locked := r.locked,
    labels := (rel idx.labels).map (⟨·⟩),
    parent := r.parent,
    dependencies := (rel idx.dependencies).map (⟨·⟩),
    assignees := (rel idx.assignees).map (⟨·⟩),
    artifacts := (rel idx.artifacts).map (⟨·⟩),
    visibility := (rel idx.visibility).map (⟨·⟩),
    checks := (rel idx.checks).map (⟨·⟩),
    creatorId := r.creatorId,
    creatorName := r.creatorId.bind (idx.actorNames[·.val]?),
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
    carrying that label; `parent` filters to the direct children of one issue. `limit`/`offset`
    page the result (a `none` limit returns everything).

    Relations are loaded in bulk (see `loadRelationIndex`), so the cost is a fixed number of
    queries rather than one per returned issue per relation. -/
def listIssues (db : Conn) (state : Option IssueState) (labelId : Option LabelId)
    (q : Option String) (assignee : Option ActorId) (parent : Option IssueId := none)
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
      AND ({parent} IS NULL OR parent_id = {parent})
    ORDER BY updated_at DESC, id DESC
    LIMIT {lim} OFFSET {off}" as IssueRow).toArray
  let idx ← loadRelationIndex db (rows.map (·.id.val))
  pure (rows.map (·.toIssueWith idx))

/-! ### The issue list, one page at a time

The list view reads through here rather than through `listIssues`, for three reasons that only
matter once a tracker is big.

*It returns a page.* Handing the client every row meant 341 KB gzipped at ten thousand issues
before anything could be drawn. A page is a fixed cost no matter how large the tracker is, and the
client keeps asking until it has what it needs.

*It pages on a key, not an offset.* `LIMIT n OFFSET k` makes SQLite walk and discard `k` rows, so
the last page of a long list costs the most; a cursor over `(updated_at, id)` seeks straight into
`idx_issues_updated` and every page costs the same.

*It filters visibility in SQL.* `listIssues` returns rows and the handler drops the ones the actor
may not see, which is correct but cannot be paged: `LIMIT 200` would yield fewer than 200 visible
rows and no way to tell whether the shortfall means "end of list" or "some were hidden". -/

/-- Where a page left off. Opaque to the client, which only echoes it back.

    Two shapes, because the orders differ in what it takes to resume them. The numeric orders carry
    the last row's key and resume with a comparison, so the database seeks straight to the next row
    however far in it is. The text and deadline orders carry a count instead: expressing them as a
    comparison would mean putting a title into the cursor, and the client stops at `FEED_CAP` rows
    anyway, which bounds how far the count can ever get. -/
inductive IssueCursor where
  /-- Resume after `(updated_at, id)`, descending. -/
  | updatedKey (updatedAt : Int64) (id : Int64)
  /-- Resume after `id`, descending. -/
  | idKey (id : Int64)
  /-- Resume by skipping `n` rows, for the orders a key cannot express cheaply. -/
  | offset (n : Nat)
deriving Inhabited

def IssueCursor.encode : IssueCursor → String
  | .updatedKey u i => s!"u.{u}.{i}"
  | .idKey i => s!"i.{i}"
  | .offset n => s!"o.{n}"

def IssueCursor.decode? (s : String) : Option IssueCursor :=
  match s.splitOn "." with
  | ["u", a, b] => match a.toInt?, b.toInt? with
    | some u, some i => some (.updatedKey (Int64.ofInt u) (Int64.ofInt i))
    | _, _ => none
  | ["i", a] => a.toInt?.map (fun i => .idKey (Int64.ofInt i))
  | ["o", a] => a.toNat?.map .offset
  | _ => none

/-- One row of the issue list: what the table draws and what its filters narrow by, and nothing
    else. An issue's description, goal, creator, creation time and visibility groups are all absent
    — no list column renders any of them. Attachments and children collapse to counts, because the
    only thing drawn is how many; dependencies keep their ids, because the "depends on" filter
    tests membership. -/
structure IssueListRow where
  id : IssueId
  title : String
  state : IssueState
  locked : Bool
  parent : Option IssueId
  deadline : Option Timestamp
  updatedAt : Timestamp
  labels : Array LabelId
  assignees : Array ActorId
  dependencies : Array IssueId
  artifactCount : Nat
  checkCount : Nat
  /-- How many issues are filed under this one — what the tree view needs to know whether a node
      unfolds, without reading the level below it. -/
  childCount : Nat
deriving Inhabited, ToJson

private structure ListRowBase where
  id : IssueId
  title : String
  state : IssueState
  locked : Bool
  parent : Option IssueId
  deadline : Option Timestamp
  updatedAt : Timestamp
  artifactCount : Int64
  checkCount : Int64
  childCount : Int64
deriving SQLite.Row, Inhabited

/-- How many matching issues are in each state. -/
structure StateCounts where
  open_ : Nat := 0
  closed : Nat := 0
  completed : Nat := 0
deriving Inhabited

instance : ToJson StateCounts where
  toJson c := Json.mkObj [("open", toJson c.open_), ("closed", toJson c.closed),
                          ("completed", toJson c.completed)]

private structure StateCountRow where
  state : IssueState
  n : Int64
deriving SQLite.Row, Inhabited

/-- A page of list rows, and where to resume. -/
structure IssuePage where
  rows : Array IssueListRow
  /-- Absent when this page reached the end of the result set. -/
  nextCursor : Option IssueCursor
  /-- How many rows match the filters in total. Only computed for the first page — it is a second
      query, and the count cannot change the pages already delivered. -/
  total : Option Nat
  /-- The same count broken down by state, which is what lets a caller show how much of a set is
      finished without holding all of it. Free: it comes from the same pass the total does. -/
  stateCounts : Option StateCounts

/-- The SQL predicate restricting a read to what `actor` may see, and the group ids it needs.

    Expressed over the issue's own visibility rows rather than handed a list of visible ids: the
    set of issues an actor may see is most of the tracker, and naming them all would put the thing
    being avoided — a query proportional to the whole table — back into every page. -/
private def visibilitySql (actorGroups : Option (Array GroupId)) : String :=
  let unrestricted := "NOT EXISTS (SELECT 1 FROM issue_visibility v WHERE v.issue_id = i.id)"
  match actorGroups with
  | none => unrestricted
  | some gs =>
    if gs.isEmpty then unrestricted
    else
      let ids := idTuple (gs.map (·.val))
      s!"({unrestricted} OR EXISTS (SELECT 1 FROM issue_visibility v WHERE v.issue_id = i.id AND v.group_id IN {ids}))"

/-- How the list may be ordered. Each corresponds to an index (see `Schema.lean`), so every one of
    them seeks rather than sorts. -/
inductive IssueSort where
  | updated | title | deadline | id
deriving Inhabited, BEq

def IssueSort.ofString? : String → Option IssueSort
  | "updated" => some .updated
  | "title" => some .title
  | "deadline" => some .deadline
  | "id" => some .id
  | _ => none

/-- The `ORDER BY` for a sort, always paired with an index so it seeks rather than sorts. -/
private def orderSql : IssueSort → String
  | .updated => "i.updated_at DESC, i.id DESC"
  | .title => "i.title COLLATE NOCASE ASC, i.id ASC"
  | .deadline => "i.deadline IS NULL, i.deadline ASC, i.id ASC"
  | .id => "i.id DESC"

/-- Read one page of the issue list.

    `cursor` resumes after a previous page and belongs to the default order; the client sends it
    back with the same filters it got it from. The other orders are read from the start each time,
    which is why the client caps how much of them it pulls. -/
def listIssuePage (db : Conn) (state : Option IssueState) (labelId : Option LabelId)
    (q : Option String) (assignee : Option ActorId) (parent : Option IssueId)
    (topLevelOnly : Bool) (actorGroups : Option (Array GroupId)) (sort : IssueSort)
    (limit : Nat) (cursor : Option IssueCursor) (withTotal : Bool) : IO IssuePage := do
  let stateStr := state.map (·.toString)
  let qlike := q.map (fun s => "%" ++ s ++ "%")
  -- Interpolated rather than bound: every one of these is either a constant of this module or an
  -- integer that came out of the database. The five values a caller supplies are bound below.
  -- A cursor of the wrong shape for this order is ignored rather than trusted: it can only come
  -- from a client that changed the order without restarting, and starting the order over is the
  -- harmless reading.
  let cursorSql := match cursor with
    | some (.updatedKey u i) =>
      if sort == .updated then
        s!" AND (i.updated_at < {u} OR (i.updated_at = {u} AND i.id < {i}))"
      else ""
    | some (.idKey i) => if sort == .id then s!" AND i.id < {i}" else ""
    | _ => ""
  let offsetSql := match cursor with
    | some (.offset n) => if sort == .title || sort == .deadline then s!" OFFSET {Int64.ofNat n}" else ""
    | _ => ""
  let topSql := if topLevelOnly then " AND i.parent_id IS NULL" else ""
  let whereSql :=
    "WHERE (" ++ visibilitySql actorGroups ++ ")
       AND (?1 IS NULL OR i.state = ?1)
       AND (?2 IS NULL OR i.id IN (SELECT issue_id FROM issue_labels WHERE label_id = ?2))
       AND (?3 IS NULL OR i.title LIKE ?3 OR i.description LIKE ?3)
       AND (?4 IS NULL OR i.id IN (SELECT issue_id FROM issue_assignees WHERE actor_id = ?4))
       AND (?5 IS NULL OR i.parent_id = ?5)" ++ topSql

  let bindFilters (stmt : SQLite.Stmt) : IO Unit := do
    SQLite.NullableQueryParam.bind stmt 1 stateStr
    SQLite.NullableQueryParam.bind stmt 2 (labelId.map (·.val))
    SQLite.NullableQueryParam.bind stmt 3 qlike
    SQLite.NullableQueryParam.bind stmt 4 (assignee.map (·.val))
    SQLite.NullableQueryParam.bind stmt 5 (parent.map (·.val))

  let stmt ← SQLite.prepare db (
    "SELECT i.id, i.title, i.state, i.locked, i.parent_id, i.deadline, i.updated_at,
       (SELECT COUNT(*) FROM artifacts a WHERE a.issue_id = i.id),
       (SELECT COUNT(*) FROM checks c WHERE c.issue_id = i.id),
       (SELECT COUNT(*) FROM issues ch WHERE ch.parent_id = i.id)
     FROM issues i " ++ whereSql ++ cursorSql ++
    s!" ORDER BY {orderSql sort} LIMIT {Int64.ofNat limit}" ++ offsetSql)
  bindFilters stmt
  let base ← (stmt.resultsAs ListRowBase).toArray

  let idx ← loadRelationIndex db (base.map (·.id.val))
  let rows := base.map fun r =>
    let rel (m : Std.HashMap Int64 (Array Int64)) : Array Int64 := m.getD r.id.val #[]
    ({ id := r.id, title := r.title, state := r.state, locked := r.locked, parent := r.parent,
       deadline := r.deadline, updatedAt := r.updatedAt,
       labels := (rel idx.labels).map (⟨·⟩),
       assignees := (rel idx.assignees).map (⟨·⟩),
       dependencies := (rel idx.dependencies).map (⟨·⟩),
       artifactCount := r.artifactCount.toNatClampNeg, checkCount := r.checkCount.toNatClampNeg,
       childCount := r.childCount.toNatClampNeg } : IssueListRow)

  -- A short page is the end of the result set. A full one may or may not be; saying "there may be
  -- more" costs at worst one empty request, where being certain would cost a count on every page.
  let nextCursor :=
    if rows.size < limit then none
    else match sort with
      | .updated => base[base.size - 1]?.map fun r => .updatedKey r.updatedAt.epochSeconds r.id.val
      | .id => base[base.size - 1]?.map fun r => .idKey r.id.val
      | .title | .deadline =>
        let sofar := match cursor with | some (.offset n) => n | _ => 0
        some (.offset (sofar + rows.size))

  -- Only for the first page: it is a second pass over the same predicate, and the answer cannot
  -- change what the pages already contain. Grouped by state rather than a bare `COUNT(*)` — the
  -- total is the sum, so the breakdown costs nothing extra and saves the caller from counting
  -- states over rows it may not all be holding.
  let (total, stateCounts) ← if !withTotal then pure (none, none) else do
    let cstmt ← SQLite.prepare db
      ("SELECT i.state, COUNT(*) FROM issues i " ++ whereSql ++ " GROUP BY i.state")
    bindFilters cstmt
    let byState ← (cstmt.resultsAs StateCountRow).toArray
    let counts : StateCounts := byState.foldl (init := {}) fun acc r =>
      match r.state with
      | .open => { acc with open_ := r.n.toNatClampNeg }
      | .closed => { acc with closed := r.n.toNatClampNeg }
      | .completed => { acc with completed := r.n.toNatClampNeg }
    pure (some (counts.open_ + counts.closed + counts.completed), some counts)
  pure { rows, nextCursor, total, stateCounts }

private structure IndexRow where
  id : IssueId
  title : String
  parent : Option IssueId
deriving SQLite.Row, Inhabited

private def IndexRow.toEntry (r : IndexRow) : IssueIndexEntry :=
  { id := r.id, title := r.title, parent := r.parent }

/-- Issues, named. This backs `GET /issues/index`: three fields per issue, and no more.

    It has its own query rather than reducing `listIssues`, because reducing `listIssues` meant
    selecting every description and goal in the tracker — much the largest thing in the table — and
    loading all six relation tables, in order to throw all of it away.

    `ids` and `q` are what keep it from being a copy of the tracker. Every caller wants either a
    handful of issues it can already name by number (a parent, a set of dependencies, the `#123`s
    in one comment) or the issues matching what somebody just typed into a picker; asking for
    either costs what the answer costs. Unfiltered it still returns everything, which is what an
    API client walking the tracker wants and what no page load should ever ask for.

    `q` matches a title by substring, or an issue by its exact number. That is narrower than the
    fuzzy matching this used to get in the browser, and reaches further: the fuzzy matching ran
    over whatever slice of the tracker had been downloaded, and this runs over all of it.

    Visibility is applied in SQL rather than over the result, so `limit` counts rows the caller may
    actually see — a limit applied before the filter would silently return short pages. -/
def listIssueIndex (db : Conn) (actorGroups : Option (Array GroupId))
    (ids : Option (Array IssueId) := none) (q : Option String := none)
    (limit : Option Nat := none) : IO (Array IssueIndexEntry) := do
  -- An explicitly empty id set asks for nothing; `IN ()` is not valid SQL, and a query is not
  -- needed to answer it.
  if ids == some #[] then return #[]
  let idSql := match ids with
    | some arr => " AND i.id IN " ++ idTuple (arr.map (·.val))
    | none => ""
  let qTrimmed := q.map (·.trimAscii.toString)
  let qlike := qTrimmed.map (fun s => "%" ++ s ++ "%")
  -- `#123` in a picker is a search for issue 123, not for the digits in a title.
  let qId := qTrimmed.bind (fun s => (s.dropWhile (· == '#')).toInt?) |>.map Int64.ofInt
  -- SQLite reads a negative LIMIT as "no limit".
  let lim : Int64 := match limit with | some n => Int64.ofNat n | none => -1
  let stmt ← SQLite.prepare db (
    "SELECT i.id, i.title, i.parent_id FROM issues i
     WHERE (" ++ visibilitySql actorGroups ++ ")
       AND (?1 IS NULL OR i.title LIKE ?1 OR i.id = ?2)" ++ idSql ++
    -- The same order `listIssues` returns, so a picker offers recently-touched issues first.
    s!" ORDER BY i.updated_at DESC, i.id DESC LIMIT {lim}")
  SQLite.NullableQueryParam.bind stmt 1 qlike
  SQLite.NullableQueryParam.bind stmt 2 qId
  pure ((← (stmt.resultsAs IndexRow).toArray).map IndexRow.toEntry)

/-- The containment path above `id`: its parent, its parent's parent, and so on, root first and
    excluding `id` itself.

    One statement rather than one query per step, and one response rather than the naming index of
    the whole tracker, which is how the client used to answer this.

    The recursion carries the visibility predicate, so it stops at the first ancestor the reader
    may not see — the same trail the client drew when a parent was missing from its index, and for
    the same reason: a breadcrumb that names an issue you cannot open is worse than a short one.
    The depth bound is a guard against a cycle in the parent chain, which nothing should be able to
    create (`createIssue`/`updateIssue` check) but which a chain-walking query must not hang on. -/
def issueAncestors (db : Conn) (id : IssueId) (actorGroups : Option (Array GroupId)) :
    IO (Array IssueIndexEntry) := do
  let rows ← queryAll db IndexRow
    ("WITH RECURSIVE chain(id, title, parent_id, depth) AS (
        SELECT i.id, i.title, i.parent_id, 0 FROM issues i WHERE i.id = " ++ toString id.val ++ "
        UNION ALL
        SELECT i.id, i.title, i.parent_id, c.depth + 1
          FROM issues i JOIN chain c ON i.id = c.parent_id
         WHERE c.depth < 64 AND (" ++ visibilitySql actorGroups ++ ")
      )
      SELECT id, title, parent_id FROM chain WHERE depth > 0 ORDER BY depth DESC")
  pure (rows.map IndexRow.toEntry)

private structure GraphRow where
  id : IssueId
  title : String
  state : IssueState
  locked : Bool
  parent : Option IssueId
  deadline : Option Timestamp
deriving SQLite.Row, Inhabited

/-- Every visible issue as a graph node: the naming fields, the two edge relations, and the three
    things a card shows.

    Relations are read whole rather than scoped to the matched ids, unlike everywhere else: the
    scope here *is* the whole table, and naming ten thousand ids in an `IN` list to say so would
    cost more than the rows do.

    A dependency on an issue the reader may not see is dropped rather than drawn, so the graph
    never hints at what visibility hides — the same rule the edge list was filtered by before. -/
def graphNodes (db : Conn) (actorGroups : Option (Array GroupId)) : IO (Array GraphNode) := do
  let rows ← queryAll db GraphRow
    ("SELECT i.id, i.title, i.state, i.locked, i.parent_id, i.deadline FROM issues i
      WHERE (" ++ visibilitySql actorGroups ++ ")
      ORDER BY i.updated_at DESC, i.id DESC")
  let relAll (table col : String) : IO (Std.HashMap Int64 (Array Int64)) := do
    pure (groupRel (← queryAll db RelRow
      s!"SELECT issue_id, {col} FROM {table} ORDER BY issue_id, {col}"))
  let labels ← relAll "issue_labels" "label_id"
  let deps ← relAll "issue_dependencies" "depends_on_id"
  let assignees ← relAll "issue_assignees" "actor_id"
  let visibleIds : Std.HashSet Int64 := rows.foldl (fun s r => s.insert r.id.val) {}
  pure <| rows.map fun r =>
    let rel (m : Std.HashMap Int64 (Array Int64)) : Array Int64 := m.getD r.id.val #[]
    { id := r.id, title := r.title, state := r.state, locked := r.locked,
      parent := r.parent.filter (fun p => visibleIds.contains p.val),
      labels := (rel labels).map (⟨·⟩),
      dependencies := ((rel deps).filter visibleIds.contains).map (⟨·⟩),
      assignees := (rel assignees).map (⟨·⟩),
      deadline := r.deadline }

private structure CountRow where
  n : Int64
deriving SQLite.Row, Inhabited

/-- Where `id` sits among the issues sharing `parent`, and the two either side of it.

    Four indexed statements over `idx_issues_parent`, each answering one question about a set the
    caller never has to hold: how many siblings there are, which one this is, and the names of its
    two neighbours. The alternative — listing the children and finding the issue in them — costs
    the whole set to show two links. -/
def issueSiblings (db : Conn) (id : IssueId) (parent : Option IssueId)
    (actorGroups : Option (Array GroupId)) : IO SiblingNav := do
  let some parentId := parent | return {}
  let vis := visibilitySql actorGroups
  let scope := s!"FROM issues i WHERE i.parent_id = {parentId.val} AND (" ++ vis ++ ")"
  let count ← queryAll db CountRow ("SELECT COUNT(*) " ++ scope)
  let position ← queryAll db CountRow ("SELECT COUNT(*) " ++ scope ++ s!" AND i.id <= {id.val}")
  let neighbour (cmp order : String) : IO (Option IssueIndexEntry) := do
    let rows ← queryAll db IndexRow
      ("SELECT i.id, i.title, i.parent_id " ++ scope ++ s!" AND i.id {cmp} {id.val}
        ORDER BY i.id {order} LIMIT 1")
    pure (rows[0]?.map IndexRow.toEntry)
  pure {
    position := (position[0]?.map (·.n.toNatClampNeg)).getD 0
    count := (count[0]?.map (·.n.toNatClampNeg)).getD 0
    prev := ← neighbour "<" "DESC"
    next := ← neighbour ">" "ASC" }

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

/-- All dependency edges in the tracker, as `(issue, dependsOn)` id pairs. The graph reads them off
    the nodes (see `graphNodes`); this remains the direct way to ask the relation a question. -/
def allDependencyEdges (db : Conn) : IO (Array (IssueId × IssueId)) := do
  (← db query!"SELECT issue_id, depends_on_id FROM issue_dependencies" as (IssueId × IssueId)).toArray

end Taxis.Db
