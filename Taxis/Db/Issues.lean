import Taxis.Db.Connection
import Taxis.Db.Schema
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

Every statement here is a `Query`, an `Insert`, an `Update` or a `Delete` of the `db` library
rather than SQL text, so the column names, their types and the tables they belong to are checked
when this module is compiled. Where that changed what the database sees — the escaping `contains`
does, `NULLS LAST` in place of an `IS NULL` sort key, and timestamps taken from Lean's clock rather
than from `unixepoch()` — the declaration that changed says so.
-/

open Lean

namespace Taxis.Db

open Schema (IssuesIndex IssueLabelsIndex IssueDependenciesIndex IssueAssigneesIndex
  IssueVisibilityIndex ArtifactsIndex ChecksIndex ActorsIndex)

/-! ### The tables this module reads and writes

Named once, as indices into the one database every `@[model]` structure in `Taxis.Db.Schema`
belongs to. Spelling `(HasModel.model Schema.Issues).index` out at each use site would say nothing
and reads badly inside an expression that already carries a column index. -/

private abbrev taxis : Database := HasModel.database Schema.Issues

private abbrev issuesTable : taxis.Index := (HasModel.model Schema.Issues).index
private abbrev issueLabelsTable : taxis.Index := (HasModel.model Schema.IssueLabels).index
private abbrev issueAssigneesTable : taxis.Index := (HasModel.model Schema.IssueAssignees).index
private abbrev issueVisibilityTable : taxis.Index := (HasModel.model Schema.IssueVisibility).index
private abbrev artifactsTable : taxis.Index := (HasModel.model Schema.Artifacts).index
private abbrev checksTable : taxis.Index := (HasModel.model Schema.Checks).index

/-- The `issues` table as a view: what a condition over an issue row is written against. -/
private abbrev issuesView : View taxis := Table.view issuesTable

/-- The conjunction of a list of conditions, `TRUE` when it is empty.

    An absent filter contributes no condition rather than a tautology the reader has to skip past:
    the translation drops a `TRUE` conjunct as it merges the conditions, so the generated `WHERE`
    mentions exactly the filters the caller supplied. -/
private def conjoin {view : View taxis} (es : List (DBExpr taxis view .bool)) :
    DBExpr taxis view .bool :=
  es.foldl (init := .true) fun acc e => .and acc e

/-- The stored `state` string as the lifecycle enum.

    The column is `text` rather than an enumerated type, so a value the domain does not know is
    possible in principle; it can only come from something other than this application writing the
    row, and reading it as one of the three would be worse than failing. -/
private def issueStateOf (s : String) : IO IssueState :=
  match IssueState.ofString? s with
  | some st => pure st
  | none => throw (IO.userError s!"invalid issue state in database: {s}")

/-! ### Narrow views over `issues`

Four of the reads here want a few columns of an issue rather than all of them, and say so in
their doc comments: the naming index, the graph, the list page and the ancestor walk. A
`Query.project` onto a view declared here is how that is expressed. The view names its columns with
the very same `Database.Name.ident`s the `issues` table view uses, which is what lets
`View.Hom.ofMap` discharge its naming obligation by `rfl`, and a projection generates no SQL beyond
the shorter `SELECT` list.
Reading whole rows instead would select every description and goal in the tracker, which is much
the largest thing in the table. -/

/-- The columns an issue is *named* by: what a breadcrumb, a picker and a graph edge need. -/
private inductive IssueIndexColumn where
  | id | title | parent_id
  deriving DecidableEq, Hashable, Repr, Enum

private def IssueIndexColumn.toIssues : IssueIndexColumn → IssuesIndex
  | .id => .id
  | .title => .title
  | .parent_id => .parent_id

instance : ToString IssueIndexColumn where
  toString
    | .id => "id"
    | .title => "title"
    | .parent_id => "parent_id"

instance : FromString IssueIndexColumn where
  fromString
    | "id" => some .id
    | "title" => some .title
    | "parent_id" => some .parent_id
    | _ => none

instance : Indexing IssueIndexColumn where

private def issueIndexView : View taxis where
  Index := IssueIndexColumn
  name c := .ident { tableName := issuesTable, columnName := c.toIssues }

private def issueIndexHom : issueIndexView.Hom issuesView :=
  View.Hom.ofMap IssueIndexColumn.toIssues

/-- The three naming columns of the issues a query matched. -/
private def issueIndexOf (q : Query taxis issuesView) : Query taxis issueIndexView :=
  .project issueIndexHom q

private def indexEntryOf (row : issueIndexView.Entry) : IssueIndexEntry :=
  { id := ⟨Int64.ofInt (row.value IssueIndexColumn.id)⟩
    title := row.value IssueIndexColumn.title
    parent := (row.value IssueIndexColumn.parent_id).map fun p => ⟨Int64.ofInt p⟩ }

/-- The columns a graph node draws and filters by. -/
private inductive GraphColumn where
  | id | title | state | locked | parent_id | deadline
  deriving DecidableEq, Hashable, Repr, Enum

private def GraphColumn.toIssues : GraphColumn → IssuesIndex
  | .id => .id
  | .title => .title
  | .state => .state
  | .locked => .locked
  | .parent_id => .parent_id
  | .deadline => .deadline

instance : ToString GraphColumn where
  toString
    | .id => "id"
    | .title => "title"
    | .state => "state"
    | .locked => "locked"
    | .parent_id => "parent_id"
    | .deadline => "deadline"

instance : FromString GraphColumn where
  fromString
    | "id" => some .id
    | "title" => some .title
    | "state" => some .state
    | "locked" => some .locked
    | "parent_id" => some .parent_id
    | "deadline" => some .deadline
    | _ => none

instance : Indexing GraphColumn where

private def graphView : View taxis where
  Index := GraphColumn
  name c := .ident { tableName := issuesTable, columnName := c.toIssues }

private def graphHom : graphView.Hom issuesView :=
  View.Hom.ofMap GraphColumn.toIssues

/-- The columns a row of the issue list draws, and the key it pages on.

    The same seven the hand-written statement selected, and for the same reason: a page of the list
    renders none of an issue's prose, and `description` alone averages several hundred bytes an
    issue. Selecting the whole row instead costs that on every page — the backend decodes each
    column of each row through a string — for text no list column has anywhere to put. -/
private inductive IssueListColumn where
  | id | title | state | locked | parent_id | deadline | updated_at
  deriving DecidableEq, Hashable, Repr, Enum

private def IssueListColumn.toIssues : IssueListColumn → IssuesIndex
  | .id => .id
  | .title => .title
  | .state => .state
  | .locked => .locked
  | .parent_id => .parent_id
  | .deadline => .deadline
  | .updated_at => .updated_at

instance : ToString IssueListColumn where
  toString
    | .id => "id"
    | .title => "title"
    | .state => "state"
    | .locked => "locked"
    | .parent_id => "parent_id"
    | .deadline => "deadline"
    | .updated_at => "updated_at"

instance : FromString IssueListColumn where
  fromString
    | "id" => some .id
    | "title" => some .title
    | "state" => some .state
    | "locked" => some .locked
    | "parent_id" => some .parent_id
    | "deadline" => some .deadline
    | "updated_at" => some .updated_at
    | _ => none

instance : Indexing IssueListColumn where

private def issueListView : View taxis where
  Index := IssueListColumn
  name c := .ident { tableName := issuesTable, columnName := c.toIssues }

private def issueListHom : issueListView.Hom issuesView :=
  View.Hom.ofMap IssueListColumn.toIssues

/-! ### Narrow views over `artifacts` and `checks`

A relation read wants an issue's id and the id on the other side of the relation, and no more. Four
of the six tables *are* those two columns, so the model layer's whole-row fetch already reads
exactly them. `artifacts` and `checks` are not: they also carry a plugin's payload and a check's
configuration and last verdict, and nothing reading a relation looks at either — an issue lists its
attachments by id and the list page only counts them. Both tables call the two columns `issue_id`
and `id`, so one index type serves both. -/

/-- The two columns a relation read wants from `artifacts` or `checks`. -/
private inductive RelPairColumn where
  | issue_id | id
  deriving DecidableEq, Hashable, Repr, Enum

instance : ToString RelPairColumn where
  toString
    | .issue_id => "issue_id"
    | .id => "id"

instance : FromString RelPairColumn where
  fromString
    | "issue_id" => some .issue_id
    | "id" => some .id
    | _ => none

instance : Indexing RelPairColumn where

private def RelPairColumn.toArtifacts : RelPairColumn → ArtifactsIndex
  | .issue_id => .issue_id
  | .id => .id

private def RelPairColumn.toChecks : RelPairColumn → ChecksIndex
  | .issue_id => .issue_id
  | .id => .id

private def artifactPairView : View taxis where
  Index := RelPairColumn
  name c := .ident { tableName := artifactsTable, columnName := c.toArtifacts }

private def checkPairView : View taxis where
  Index := RelPairColumn
  name c := .ident { tableName := checksTable, columnName := c.toChecks }

private def artifactPairHom : artifactPairView.Hom (Table.view artifactsTable) :=
  View.Hom.ofMap RelPairColumn.toArtifacts

private def checkPairHom : checkPairView.Hom (Table.view checksTable) :=
  View.Hom.ofMap RelPairColumn.toChecks

/-! ### Visibility -/

/-- The condition restricting a read to what an actor may see, over whatever view the issue row
    sits in.

    Expressed over the issue's own visibility rows rather than handed a list of visible ids: the
    set of issues an actor may see is most of the tracker, and naming them all would put the thing
    being avoided — a query proportional to the whole table — back into every page.

    A function of the issue's id expression rather than a fixed condition, because the same
    predicate is needed over three different views: the plain `issues` view of the list, the joined
    view inside the ancestor walk's recursive step, and the sibling queries. `NOT EXISTS (SELECT 1
    FROM issue_visibility v WHERE v.issue_id = i.id)` and `i.id NOT IN (SELECT issue_id FROM
    issue_visibility)` decide the same rows, and the second is what the query language says. -/
private def visibilityExpr {view : View taxis} (issueId : DBExpr taxis view .int)
    (actorGroups : Option (Array GroupId)) : DBExpr taxis view .bool :=
  let unrestricted : DBExpr taxis view .bool :=
    .not (.inSubquery issueId (.all issueVisibilityTable) IssueVisibilityIndex.issue_id)
  match actorGroups with
  | none => unrestricted
  | some gs =>
    if gs.isEmpty then unrestricted
    else
      .or unrestricted
        (.inSubquery issueId
          (.filter (.inList (.var IssueVisibilityIndex.group_id .int) (gs.toList.map (·.val.toInt)))
            (.all issueVisibilityTable))
          IssueVisibilityIndex.issue_id)

/-! ### Single-issue reads -/

/-- The display name of an actor, if they still exist. Used to denormalise the issue creator's
    name without needing a join in every issue query. -/
private def displayNameOf (db : Conn) (id : ActorId) : IO (Option String) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Actors)
    { query := .filter (.eq (.var ActorsIndex.id .int) (.int id.val.toInt)) (.all _) }
  return rows[0]?.map (·.display_name)

private def issueDependencies (db : Conn) (id : IssueId) : IO (Array IssueId) := do
  let rows ← run db <| HasModel.fetch (α := Schema.IssueDependencies)
    { query := .orderBy [{ column := IssueDependenciesIndex.depends_on_id }]
        (.filter (.eq (.var IssueDependenciesIndex.issue_id .int) (.int id.val.toInt)) (.all _)) }
  return rows.map fun r => ⟨Int64.ofInt r.depends_on_id⟩

private def issueAssignees (db : Conn) (id : IssueId) : IO (Array ActorId) := do
  let rows ← run db <| HasModel.fetch (α := Schema.IssueAssignees)
    { query := .orderBy [{ column := IssueAssigneesIndex.actor_id }]
        (.filter (.eq (.var IssueAssigneesIndex.issue_id .int) (.int id.val.toInt)) (.all _)) }
  return rows.map fun r => ⟨Int64.ofInt r.actor_id⟩

private def issueVisibility (db : Conn) (id : IssueId) : IO (Array GroupId) := do
  let rows ← run db <| HasModel.fetch (α := Schema.IssueVisibility)
    { query := .orderBy [{ column := IssueVisibilityIndex.group_id }]
        (.filter (.eq (.var IssueVisibilityIndex.issue_id .int) (.int id.val.toInt)) (.all _)) }
  return rows.map fun r => ⟨Int64.ofInt r.group_id⟩

private def issueArtifactIds (db : Conn) (id : IssueId) : IO (Array ArtifactId) := do
  let rows ← run db <| DBMonad.lookup <| Query.project artifactPairHom
    (.orderBy [{ column := ArtifactsIndex.id }]
      (.filter (.eq (.var ArtifactsIndex.issue_id .int) (.int id.val.toInt))
        (.all artifactsTable)))
  return rows.map fun r => ⟨Int64.ofInt (r.value RelPairColumn.id)⟩

private def issueCheckIds (db : Conn) (id : IssueId) : IO (Array CheckId) := do
  let rows ← run db <| DBMonad.lookup <| Query.project checkPairHom
    (.orderBy [{ column := ChecksIndex.id }]
      (.filter (.eq (.var ChecksIndex.issue_id .int) (.int id.val.toInt)) (.all checksTable)))
  return rows.map fun r => ⟨Int64.ofInt (r.value RelPairColumn.id)⟩

private def issueLabels (db : Conn) (id : IssueId) : IO (Array LabelId) := do
  let rows ← run db <| HasModel.fetch (α := Schema.IssueLabels)
    { query := .orderBy [{ column := IssueLabelsIndex.label_id }]
        (.filter (.eq (.var IssueLabelsIndex.issue_id .int) (.int id.val.toInt)) (.all _)) }
  return rows.map fun r => ⟨Int64.ofInt r.label_id⟩

/-- Assemble an issue from a stored row, reading each relation as its own query. -/
private def issueOfRow (r : Schema.Issues) (db : Conn) : IO Issue := do
  let id : IssueId := ⟨Int64.ofInt r.id⟩
  let creatorId : Option ActorId := r.creator_id.map fun c => ⟨Int64.ofInt c⟩
  pure {
    id := id, title := r.title, description := r.description, goal := r.goal,
    state := ← issueStateOf r.state,
    locked := r.locked,
    labels := ← issueLabels db id,
    parent := r.parent_id.map fun p => ⟨Int64.ofInt p⟩,
    dependencies := ← issueDependencies db id,
    assignees := ← issueAssignees db id,
    artifacts := ← issueArtifactIds db id,
    visibility := ← issueVisibility db id,
    checks := ← issueCheckIds db id,
    creatorId := creatorId,
    creatorName := ← (match creatorId with | some cid => displayNameOf db cid | none => pure none),
    deadline := r.deadline.map fun t => ⟨Int64.ofInt t⟩,
    createdAt := ⟨Int64.ofInt r.created_at⟩, updatedAt := ⟨Int64.ofInt r.updated_at⟩ }

/-! ### Batched relation loading

`issueOfRow` issues one query per relation per issue, which is the right shape for reading a
single issue but costs `O(N)` queries when listing. `listIssues` instead loads each relation table
once and groups it by issue id, so a list costs a fixed number of queries no matter how many rows
it returns. Four of the six tables hold one narrow row per relation, so scanning one beats `N`
point lookups for the whole-list reads the UI actually makes; `artifacts` and `checks` are read
through `artifactPairView`/`checkPairView` rather than through the model layer, which fetches a
whole row and would carry every plugin payload in the result past a caller that wants two ids.

Each of those queries is restricted to the issues the query actually matched. Loading the tables
whole is the right cost for an unfiltered list, where the result *is* every issue, and the wrong
one for every filtered read the UI makes — asking for the seventeen children of one issue used to
scan all six relation tables end to end. -/

/-- Group `(issue_id, value)` pairs by issue, keeping each query's ordering within an issue. -/
private def groupRel (rows : Array (Int64 × Int64)) : Std.HashMap Int64 (Array Int64) :=
  rows.foldl (fun m p => m.insert p.1 ((m.getD p.1 #[]).push p.2)) {}

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

/-- Every relation of the issues in `ids`, loaded whole and grouped by issue id.

    The scope is an `IN` list over the ids in hand, which for an empty list is `FALSE` rather than
    the invalid SQL `IN ()` the assembled statement used to have to avoid. The early return stays
    all the same: an empty result set needs no queries at all. -/
private def loadRelationIndex (db : Conn) (ids : Array Int64) : IO RelationIndex := do
  if ids.isEmpty then return RelationIndex.empty
  let scope : List Int := ids.toList.map (·.toInt)
  run db do
    -- Every relation is read as `(issue_id, <the other side>)`, restricted to the issues in hand
    -- and ordered so each issue's values keep the order the single-issue reads give them.
    let labels ← HasModel.fetch (α := Schema.IssueLabels)
      { query := .orderBy [{ column := IssueLabelsIndex.issue_id },
                           { column := IssueLabelsIndex.label_id }]
          (.filter (.inList (.var IssueLabelsIndex.issue_id .int) scope) (.all _)) }
    let deps ← HasModel.fetch (α := Schema.IssueDependencies)
      { query := .orderBy [{ column := IssueDependenciesIndex.issue_id },
                           { column := IssueDependenciesIndex.depends_on_id }]
          (.filter (.inList (.var IssueDependenciesIndex.issue_id .int) scope) (.all _)) }
    let assignees ← HasModel.fetch (α := Schema.IssueAssignees)
      { query := .orderBy [{ column := IssueAssigneesIndex.issue_id },
                           { column := IssueAssigneesIndex.actor_id }]
          (.filter (.inList (.var IssueAssigneesIndex.issue_id .int) scope) (.all _)) }
    let visibility ← HasModel.fetch (α := Schema.IssueVisibility)
      { query := .orderBy [{ column := IssueVisibilityIndex.issue_id },
                           { column := IssueVisibilityIndex.group_id }]
          (.filter (.inList (.var IssueVisibilityIndex.issue_id .int) scope) (.all _)) }
    let artifacts ← DBMonad.lookup <| Query.project artifactPairHom
      (.orderBy [{ column := ArtifactsIndex.issue_id }, { column := ArtifactsIndex.id }]
        (.filter (.inList (.var ArtifactsIndex.issue_id .int) scope) (.all artifactsTable)))
    let checks ← DBMonad.lookup <| Query.project checkPairHom
      (.orderBy [{ column := ChecksIndex.issue_id }, { column := ChecksIndex.id }]
        (.filter (.inList (.var ChecksIndex.issue_id .int) scope) (.all checksTable)))
    -- Actors are not scoped: the table is small, there is one row per person rather than per
    -- relation, and narrowing it would mean collecting the creator ids first.
    let actors ← HasModel.fetch (QuerySet.all (α := Schema.Actors))
    return {
      labels := groupRel (labels.map fun r => (Int64.ofInt r.issue_id, Int64.ofInt r.label_id))
      dependencies :=
        groupRel (deps.map fun r => (Int64.ofInt r.issue_id, Int64.ofInt r.depends_on_id))
      assignees :=
        groupRel (assignees.map fun r => (Int64.ofInt r.issue_id, Int64.ofInt r.actor_id))
      visibility :=
        groupRel (visibility.map fun r => (Int64.ofInt r.issue_id, Int64.ofInt r.group_id))
      artifacts := groupRel (artifacts.map fun r =>
        (Int64.ofInt (r.value RelPairColumn.issue_id), Int64.ofInt (r.value RelPairColumn.id)))
      checks := groupRel (checks.map fun r =>
        (Int64.ofInt (r.value RelPairColumn.issue_id), Int64.ofInt (r.value RelPairColumn.id)))
      actorNames := actors.foldl (fun m a => m.insert (Int64.ofInt a.id) a.display_name) {} }

/-- Assemble an issue from an already-loaded relation index, without touching the database. -/
private def issueOfRowWith (r : Schema.Issues) (idx : RelationIndex) : IO Issue := do
  let key := Int64.ofInt r.id
  let rel (m : Std.HashMap Int64 (Array Int64)) : Array Int64 := m.getD key #[]
  return {
    id := ⟨key⟩, title := r.title, description := r.description, goal := r.goal,
    state := ← issueStateOf r.state,
    locked := r.locked,
    labels := (rel idx.labels).map (⟨·⟩),
    parent := r.parent_id.map fun p => ⟨Int64.ofInt p⟩,
    dependencies := (rel idx.dependencies).map (⟨·⟩),
    assignees := (rel idx.assignees).map (⟨·⟩),
    artifacts := (rel idx.artifacts).map (⟨·⟩),
    visibility := (rel idx.visibility).map (⟨·⟩),
    checks := (rel idx.checks).map (⟨·⟩),
    creatorId := r.creator_id.map fun c => ⟨Int64.ofInt c⟩,
    creatorName := r.creator_id.bind fun c => idx.actorNames[Int64.ofInt c]?,
    deadline := r.deadline.map fun t => ⟨Int64.ofInt t⟩,
    createdAt := ⟨Int64.ofInt r.created_at⟩, updatedAt := ⟨Int64.ofInt r.updated_at⟩ }

/-- Read the parent id of an issue directly (a single climbing step). Only the naming columns are
    selected: a climb reads one row per level and none of their prose. -/
private def parentOf (db : Conn) (id : IssueId) : IO (Option IssueId) := do
  let rows ← run db <| DBMonad.lookup <| issueIndexOf
    (.filter (.eq (.var IssuesIndex.id .int) (.int id.val.toInt)) (.all issuesTable))
  return rows[0]?.bind fun row =>
    (row.value IssueIndexColumn.parent_id).map fun p => ⟨Int64.ofInt p⟩

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
  discard <| run db <| HasModel.update (α := Schema.Issues)
    { value
        | .parent_id => some (match parent with
                              | some p => .int p.val.toInt
                              | none => .null .int)
        | _ => none
      condition := .eq (.var IssuesIndex.id .int) (.int child.val.toInt) }

/-- Replace the dependency set of `issue`. Self-dependencies are dropped; no acyclicity is
    imposed (the dependency graph may contain cycles). -/
private def setDependencies (db : Conn) (issue : IssueId) (deps : Array IssueId) : IO Unit :=
  run db do
    discard <| HasModel.delete (α := Schema.IssueDependencies)
      (.eq (.var IssueDependenciesIndex.issue_id .int) (.int issue.val.toInt))
    for d in deps do
      if d.val != issue.val then
        -- The pair is the primary key, so a repeated id in the input conflicts and is skipped.
        discard <| HasModel.insertIfAbsent
          ({ issue_id := issue.val.toInt, depends_on_id := d.val.toInt } :
            Schema.IssueDependencies)

private def setAssignees (db : Conn) (issue : IssueId) (actors : Array ActorId) : IO Unit :=
  run db do
    discard <| HasModel.delete (α := Schema.IssueAssignees)
      (.eq (.var IssueAssigneesIndex.issue_id .int) (.int issue.val.toInt))
    for a in actors do
      discard <| HasModel.insertIfAbsent
        ({ issue_id := issue.val.toInt, actor_id := a.val.toInt } : Schema.IssueAssignees)

private def setVisibility (db : Conn) (issue : IssueId) (groups : Array GroupId) : IO Unit :=
  run db do
    discard <| HasModel.delete (α := Schema.IssueVisibility)
      (.eq (.var IssueVisibilityIndex.issue_id .int) (.int issue.val.toInt))
    for g in groups do
      discard <| HasModel.insertIfAbsent
        ({ issue_id := issue.val.toInt, group_id := g.val.toInt } : Schema.IssueVisibility)

private def setLabels (db : Conn) (issue : IssueId) (labels : Array LabelId) : IO Unit :=
  run db do
    discard <| HasModel.delete (α := Schema.IssueLabels)
      (.eq (.var IssueLabelsIndex.issue_id .int) (.int issue.val.toInt))
    for l in labels do
      discard <| HasModel.insertIfAbsent
        ({ issue_id := issue.val.toInt, label_id := l.val.toInt } : Schema.IssueLabels)

/-- Fetch an issue by id, with all relations loaded. -/
def getIssue (db : Conn) (id : IssueId) : IO (Option Issue) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Issues)
    { query := .filter (.eq (.var IssuesIndex.id .int) (.int id.val.toInt)) (.all _) }
  match rows[0]? with
  | none => pure none
  | some r => some <$> issueOfRow r db

/-- The five optional filters the list reads share, as conditions over the `issues` view. An
    absent filter contributes no condition at all. -/
private def listFilters (state : Option IssueState) (labelId : Option LabelId) (q : Option String)
    (assignee : Option ActorId) (parent : Option IssueId) : List (DBExpr taxis issuesView .bool) :=
  let conds : List (Option (DBExpr taxis issuesView .bool)) :=
    [ state.map fun s => .eq (.var IssuesIndex.state .text) (.text s.toString),
      labelId.map fun l =>
        .inSubquery (.var IssuesIndex.id .int)
          (.filter (.eq (.var IssueLabelsIndex.label_id .int) (.int l.val.toInt))
            (.all issueLabelsTable))
          IssueLabelsIndex.issue_id,
      q.map fun s =>
        .or (.contains (.var IssuesIndex.title .text) s)
            (.contains (.var IssuesIndex.description .text) s),
      assignee.map fun a =>
        .inSubquery (.var IssuesIndex.id .int)
          (.filter (.eq (.var IssueAssigneesIndex.actor_id .int) (.int a.val.toInt))
            (.all issueAssigneesTable))
          IssueAssigneesIndex.issue_id,
      parent.map fun p => .eq (.var IssuesIndex.parent_id .int) (.int p.val.toInt) ]
  conds.filterMap id

/-- List issues matching optional filters, most-recently-updated first.
    Text search (`q`) matches title or description by substring; `labelId` filters to issues
    carrying that label; `parent` filters to the direct children of one issue. `limit`/`offset`
    page the result (a `none` limit returns everything).

    The substring match escapes the `LIKE` wildcards in `q`, which the hand-written `LIKE` this
    replaces did not: a search for `100%` now looks for those four characters rather than for
    everything beginning `100`.

    Relations are loaded in bulk (see `loadRelationIndex`), so the cost is a fixed number of
    queries rather than one per returned issue per relation. -/
def listIssues (db : Conn) (state : Option IssueState) (labelId : Option LabelId)
    (q : Option String) (assignee : Option ActorId) (parent : Option IssueId := none)
    (limit : Option Nat := none) (offset : Nat := 0) : IO (Array Issue) := do
  let ordered : Query taxis issuesView :=
    .orderBy [{ column := IssuesIndex.updated_at, direction := .desc },
              { column := IssuesIndex.id, direction := .desc }]
      (.filter (conjoin (listFilters state labelId q assignee parent)) (.all issuesTable))
  let skipped := if offset == 0 then ordered else Query.offset offset ordered
  let paged := match limit with
    | some n => Query.limit n skipped
    | none => skipped
  let rows ← run db <| HasModel.fetch (α := Schema.Issues) { query := paged }
  let idx ← loadRelationIndex db (rows.map fun r => Int64.ofInt r.id)
  rows.mapM (issueOfRowWith · idx)

/-! ### The issue list, one page at a time

The list view reads through here rather than through `listIssues`, for three reasons that only
matter once a tracker is big.

*It returns a page.* Handing the client every row meant 341 KB gzipped at ten thousand issues
before anything could be drawn. A page is a fixed cost no matter how large the tracker is, and the
client keeps asking until it has what it needs.

*It pages on a key, not an offset.* `LIMIT n OFFSET k` makes SQLite walk and discard `k` rows, so
the last page of a long list costs the most; a cursor over `(updated_at, id)` seeks straight into
`idx_issues_updated` and every page costs the same.

*It filters visibility in the query.* `listIssues` returns rows and the handler drops the ones the
actor may not see, which is correct but cannot be paged: `LIMIT 200` would yield fewer than 200
visible rows and no way to tell whether the shortfall means "end of list" or "some were hidden". -/

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

/-- How many matching issues are in each state. -/
structure StateCounts where
  open_ : Nat := 0
  closed : Nat := 0
  completed : Nat := 0
deriving Inhabited

instance : ToJson StateCounts where
  toJson c := Json.mkObj [("open", toJson c.open_), ("closed", toJson c.closed),
                          ("completed", toJson c.completed)]

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

/-! #### The shape of a page query

A list row carries three counts of rows in other tables, which is what `Query.correlate` is for:
one scalar subquery per count, evaluated per issue the page returned. A join would multiply the
issues by their artifacts instead of counting them, and an aggregate over a join would lose the
issue that has none.

Each `correlate` puts its column to the right of the query it wraps, so three of them nest the
issue's own columns three `Sum.inl`s deep. The abbreviations below are what keep the sort keys and
the row decoding readable.

The issue columns they nest are `issueListView`'s seven and not the whole row. The projection goes
*under* the correlates rather than over them, so that the outer view the conditions are written
against is already the narrow one; `Query.project` generates no SQL of its own, so the statement
stays the one flat `SELECT` that lets the planner walk the sort's index and evaluate the three
scalar subqueries only for the rows the `LIMIT` keeps. -/

private abbrev countColumn : Column := { type := .int, nullable := false }

/-- A list row's issue columns with the three correlated counts beside them. -/
private abbrev pageView : View taxis :=
  ((issueListView.prod (View.singleton taxis "artifact_count" countColumn)).prod
      (View.singleton taxis "check_count" countColumn)).prod
    (View.singleton taxis "child_count" countColumn)

private abbrev pageIssue (c : IssueListColumn) : pageView.Index := Sum.inl (Sum.inl (Sum.inl c))
private abbrev pageArtifactCount : pageView.Index := Sum.inl (Sum.inl (Sum.inr ⟨⟩))
private abbrev pageCheckCount : pageView.Index := Sum.inl (Sum.inr ⟨⟩)
private abbrev pageChildCount : pageView.Index := Sum.inr ⟨⟩

/-- The page query: the issues a condition matches, each with how many artifacts, checks and
    children it has. -/
private def pageQuery (cond : DBExpr taxis issuesView .bool) : Query taxis pageView :=
  .correlate "child_count"
    (.correlate "check_count"
      (.correlate "artifact_count"
        (.project issueListHom (.filter cond (.all issuesTable)))
        (.all artifactsTable)
        (.eq (.var (Sum.inr ArtifactsIndex.issue_id) .int)
             (.var (Sum.inl IssueListColumn.id) .int))
        .countAll)
      (.all checksTable)
      (.eq (.var (Sum.inr ChecksIndex.issue_id) .int)
           (.var (Sum.inl (Sum.inl IssueListColumn.id)) .int))
      .countAll)
    (.all issuesTable)
    (.eq (.var (Sum.inr IssuesIndex.parent_id) .int)
         (.var (Sum.inl (Sum.inl (Sum.inl IssueListColumn.id))) .int))
    .countAll

/-- The sort keys for an order, always paired with an index so it seeks rather than sorts.

    The title key folds case, which the library emits as `lower("title")` — the expression
    `idx_issues_title` is declared on. The deadline key places its `NULL`s explicitly rather than
    sorting on `deadline IS NULL` first; that is the same order, said as a property of the key. -/
private def sortKeys : IssueSort → List (SortKey pageView)
  | .updated => [{ column := pageIssue IssueListColumn.updated_at, direction := .desc },
                 { column := pageIssue IssueListColumn.id, direction := .desc }]
  | .title => [{ column := pageIssue IssueListColumn.title, collation := .caseInsensitive },
               { column := pageIssue IssueListColumn.id }]
  | .deadline => [{ column := pageIssue IssueListColumn.deadline, nulls := .last },
                  { column := pageIssue IssueListColumn.id }]
  | .id => [{ column := pageIssue IssueListColumn.id, direction := .desc }]

/-- The output of the state breakdown: the grouped `state` column and how many issues are in it.

    Declared by hand because the shape is the caller's to name: `Query.aggregate` takes the view its
    result has, and `state` has to be declared exactly as the `issues` column it groups over, or
    the backend would read a value into a type with no room for it. -/
private inductive StateCountColumn where
  | state | n
  deriving DecidableEq, Hashable, Repr, Enum

instance : ToString StateCountColumn where
  toString
    | .state => "state"
    | .n => "n"

instance : FromString StateCountColumn where
  fromString
    | "state" => some .state
    | "n" => some .n
    | _ => none

instance : Indexing StateCountColumn where

private def stateCountView : View taxis where
  Index := StateCountColumn
  name
    | .state => .computation "state" { type := .text, nullable := false }
    | .n => .computation "n" { type := .int, nullable := false }

/-- `SELECT state, COUNT(*) FROM issues WHERE <cond> GROUP BY state`. -/
private def stateCountQuery (cond : DBExpr taxis issuesView .bool) : Query taxis stateCountView :=
  .aggregate
    { entry
        | .state => .group IssuesIndex.state
        | .n => .countAll }
    (.filter cond (.all issuesTable))

/-- Read one page of the issue list.

    `cursor` resumes after a previous page and belongs to the default order; the client sends it
    back with the same filters it got it from. The other orders are read from the start each time,
    which is why the client caps how much of them it pulls.

    A cursor of the wrong shape for this order is ignored rather than trusted: it can only come
    from a client that changed the order without restarting, and starting the order over is the
    harmless reading. -/
def listIssuePage (db : Conn) (state : Option IssueState) (labelId : Option LabelId)
    (q : Option String) (assignee : Option ActorId) (parent : Option IssueId)
    (topLevelOnly : Bool) (actorGroups : Option (Array GroupId)) (sort : IssueSort)
    (limit : Nat) (cursor : Option IssueCursor) (withTotal : Bool) : IO IssuePage := do
  let topConds : List (DBExpr taxis issuesView .bool) :=
    if topLevelOnly then [.isNull (.var IssuesIndex.parent_id .int)] else []
  -- What the page and its counts agree on: everything except where the page resumes.
  let filters :=
    visibilityExpr (.var IssuesIndex.id .int) actorGroups ::
      (listFilters state labelId q assignee parent ++ topConds)
  let cursorConds : List (DBExpr taxis issuesView .bool) := match cursor with
    | some (.updatedKey u i) =>
      if sort == .updated then
        [.or (.lt (.var IssuesIndex.updated_at .int) (.int u.toInt))
             (.and (.eq (.var IssuesIndex.updated_at .int) (.int u.toInt))
                   (.lt (.var IssuesIndex.id .int) (.int i.toInt)))]
      else []
    | some (.idKey i) => if sort == .id then [.lt (.var IssuesIndex.id .int) (.int i.toInt)] else []
    | _ => []
  let skip := match cursor with
    | some (.offset n) => if sort == .title || sort == .deadline then n else 0
    | _ => 0

  let ordered : Query taxis pageView :=
    .orderBy (sortKeys sort) (pageQuery (conjoin (filters ++ cursorConds)))
  let skipped := if skip == 0 then ordered else Query.offset skip ordered
  let entries ← run db <| DBMonad.lookup (Query.limit limit skipped)

  let idx ← loadRelationIndex db
    (entries.map fun row => Int64.ofInt (row.value (pageIssue IssueListColumn.id)))
  let rows ← entries.mapM fun row => do
    let key := Int64.ofInt (row.value (pageIssue IssueListColumn.id))
    let rel (m : Std.HashMap Int64 (Array Int64)) : Array Int64 := m.getD key #[]
    return ({ id := ⟨key⟩, title := row.value (pageIssue IssueListColumn.title),
              state := ← issueStateOf (row.value (pageIssue IssueListColumn.state)),
              locked := row.value (pageIssue IssueListColumn.locked),
              parent := (row.value (pageIssue IssueListColumn.parent_id)).map fun p =>
                ⟨Int64.ofInt p⟩,
              deadline := (row.value (pageIssue IssueListColumn.deadline)).map fun t =>
                ⟨Int64.ofInt t⟩,
              updatedAt := ⟨Int64.ofInt (row.value (pageIssue IssueListColumn.updated_at))⟩,
              labels := (rel idx.labels).map (⟨·⟩),
              assignees := (rel idx.assignees).map (⟨·⟩),
              dependencies := (rel idx.dependencies).map (⟨·⟩),
              artifactCount := (row.value pageArtifactCount).toNat,
              checkCount := (row.value pageCheckCount).toNat,
              childCount := (row.value pageChildCount).toNat } : IssueListRow)

  -- A short page is the end of the result set. A full one may or may not be; saying "there may be
  -- more" costs at worst one empty request, where being certain would cost a count on every page.
  let nextCursor :=
    if rows.size < limit then none
    else match sort with
      | .updated => entries[entries.size - 1]?.map fun r =>
          .updatedKey (Int64.ofInt (r.value (pageIssue IssueListColumn.updated_at)))
            (Int64.ofInt (r.value (pageIssue IssueListColumn.id)))
      | .id => entries[entries.size - 1]?.map fun r =>
          .idKey (Int64.ofInt (r.value (pageIssue IssueListColumn.id)))
      | .title | .deadline =>
        let sofar := match cursor with | some (.offset n) => n | _ => 0
        some (.offset (sofar + rows.size))

  -- Only for the first page: it is a second pass over the same predicate, and the answer cannot
  -- change what the pages already contain. Grouped by state rather than a bare `COUNT(*)` — the
  -- total is the sum, so the breakdown costs nothing extra and saves the caller from counting
  -- states over rows it may not all be holding.
  let (total, stateCounts) ← if !withTotal then pure (none, none) else do
    let byState ← run db <| DBMonad.lookup (stateCountQuery (conjoin filters))
    let counts ← byState.foldlM (init := ({} : StateCounts)) fun acc row => do
      let n := (row.value StateCountColumn.n).toNat
      match ← issueStateOf (row.value StateCountColumn.state) with
      | .open => pure { acc with open_ := n }
      | .closed => pure { acc with closed := n }
      | .completed => pure { acc with completed := n }
    pure (some (counts.open_ + counts.closed + counts.completed), some counts)
  pure { rows, nextCursor, total, stateCounts }

/-- Issues, named. This backs `GET /issues/index`: three fields per issue, and no more.

    It has its own query rather than reducing `listIssues`, because reducing `listIssues` meant
    selecting every description and goal in the tracker — much the largest thing in the table — and
    loading all six relation tables, in order to throw all of it away. The projection onto
    `issueIndexView` is what says so: the statement selects three columns.

    `ids` and `q` are what keep it from being a copy of the tracker. Every caller wants either a
    handful of issues it can already name by number (a parent, a set of dependencies, the `#123`s
    in one comment) or the issues matching what somebody just typed into a picker; asking for
    either costs what the answer costs. Unfiltered it still returns everything, which is what an
    API client walking the tracker wants and what no page load should ever ask for.

    `q` matches a title by substring, or an issue by its exact number. That is narrower than the
    fuzzy matching this used to get in the browser, and reaches further: the fuzzy matching ran
    over whatever slice of the tracker had been downloaded, and this runs over all of it. The
    substring match escapes the `LIKE` wildcards in `q`, so `50%` is three characters rather than a
    prefix.

    Visibility is applied in the query rather than over the result, so `limit` counts rows the
    caller may actually see — a limit applied before the filter would silently return short
    pages. -/
def listIssueIndex (db : Conn) (actorGroups : Option (Array GroupId))
    (ids : Option (Array IssueId) := none) (q : Option String := none)
    (limit : Option Nat := none) : IO (Array IssueIndexEntry) := do
  -- An explicitly empty id set asks for nothing, and a query is not needed to answer it.
  if ids == some #[] then return #[]
  let qTrimmed := q.map (·.trimAscii.toString)
  -- `#123` in a picker is a search for issue 123, not for the digits in a title.
  let qId := qTrimmed.bind (fun s => (s.dropWhile (· == '#')).toInt?)
  let idConds : List (DBExpr taxis issuesView .bool) := match ids with
    | some arr => [.inList (.var IssuesIndex.id .int) (arr.toList.map (·.val.toInt))]
    | none => []
  let qConds : List (DBExpr taxis issuesView .bool) := match qTrimmed with
    | none => []
    | some s =>
      let byTitle : DBExpr taxis issuesView .bool := .contains (.var IssuesIndex.title .text) s
      [match qId with
       | some n => .or byTitle (.eq (.var IssuesIndex.id .int) (.int n))
       | none => byTitle]
  let ordered : Query taxis issuesView :=
    -- The same order `listIssues` returns, so a picker offers recently-touched issues first.
    .orderBy [{ column := IssuesIndex.updated_at, direction := .desc },
              { column := IssuesIndex.id, direction := .desc }]
      (.filter
        (conjoin (visibilityExpr (.var IssuesIndex.id .int) actorGroups :: (idConds ++ qConds)))
        (.all issuesTable))
  let paged := match limit with
    | some n => Query.limit n ordered
    | none => ordered
  let rows ← run db <| DBMonad.lookup (issueIndexOf paged)
  return rows.map indexEntryOf

/-! ### The ancestor walk

`Query.recursive` is the `WITH RECURSIVE` the containment path is read with: the row to start from
at depth `0`, then repeatedly the issue its `parent_id` names, one step deeper. The step reaches
the rows found so far through `Query.cteRef`, joined with the whole `issues` table — a shape that
translates to one flat `SELECT`, which is what lets the self-reference stand directly in the step's
`FROM`. SQLite rejects it anywhere else, with `circular reference: chain`. -/

private abbrev depthColumn : Column := { type := .int, nullable := false }

/-- What the walk carries: an issue's naming columns and how far above the start it was found. -/
private abbrev chainView : View taxis :=
  issueIndexView.prod (View.singleton taxis "depth" depthColumn)

/-- The row to start from, at depth `0`. -/
private def ancestorBase (start : Int) : Query taxis chainView :=
  .extend "depth" depthColumn (.int 0)
    (issueIndexOf (.filter (.eq (.var IssuesIndex.id .int) (.int start)) (.all issuesTable)))

/-- For every row found so far, the issue its `parent_id` names, one step deeper.

    The step joins the rows found so far with the whole table, so it is written over
    `(chain × depth) × issues`: `Sum.inl (Sum.inl _)` is a naming column of a row found so far,
    `Sum.inl (Sum.inr ⟨⟩)` is that row's depth, and `Sum.inr _` a column of the candidate parent.
    The `extend` puts the new depth next to all of it and the `project` brings the result back onto
    `chainView`, which is the view the base and the step have to agree on.

    The depth bound guards against a cycle in the parent chain, which nothing should be able to
    create (`createIssue`/`updateIssue` check) but which a chain-walking query must not hang on:
    `UNION ALL` returns a row every time it is reached, so nothing else would stop it. -/
private def ancestorStep (actorGroups : Option (Array GroupId)) : Query taxis chainView :=
  .project
    (View.Hom.ofMap fun i =>
      match i with
      | Sum.inl col => Sum.inl (Sum.inr col.toIssues)
      | Sum.inr depth => Sum.inr depth)
    (.filter
      (.and
        (.and
          (.eq (.var (Sum.inl (Sum.inr IssuesIndex.id)) .int)
               (.var (Sum.inl (Sum.inl (Sum.inl IssueIndexColumn.parent_id))) .int))
          (.lt (.var (Sum.inl (Sum.inl (Sum.inr ⟨⟩))) .int) (.int 64)))
        (visibilityExpr (.var (Sum.inl (Sum.inr IssuesIndex.id)) .int) actorGroups))
      (.extend "depth" depthColumn
        (.add (.var (Sum.inl (Sum.inr ⟨⟩)) .int) (.int 1))
        (.join (.cteRef "chain" chainView) (.all issuesTable))))

/-- The containment path above `id`: its parent, its parent's parent, and so on, root first and
    excluding `id` itself.

    One statement rather than one query per step, and one response rather than the naming index of
    the whole tracker, which is how the client used to answer this.

    The recursion carries the visibility predicate, so it stops at the first ancestor the reader
    may not see — the same trail the client drew when a parent was missing from its index, and for
    the same reason: a breadcrumb that names an issue you cannot open is worse than a short one.
    Depth `0` is the issue itself, which is dropped, and the rest come back deepest first, which is
    root first. -/
def issueAncestors (db : Conn) (id : IssueId) (actorGroups : Option (Array GroupId)) :
    IO (Array IssueIndexEntry) := do
  let walk : Query taxis chainView :=
    .orderBy [{ column := Sum.inr ⟨⟩, direction := .desc }]
      (.filter (.gt (.var (Sum.inr (⟨⟩ : IUnit "depth")) .int) (.int 0))
        (.recursive "chain" (ancestorBase id.val.toInt) (ancestorStep actorGroups)))
  let rows ← run db <| DBMonad.lookup walk
  return rows.map fun row =>
    { id := ⟨Int64.ofInt (row.value (Sum.inl IssueIndexColumn.id))⟩
      title := row.value (Sum.inl IssueIndexColumn.title)
      parent := (row.value (Sum.inl IssueIndexColumn.parent_id)).map fun p => ⟨Int64.ofInt p⟩ }

/-- Every visible issue as a graph node: the naming fields, the two edge relations, and the three
    things a card shows.

    Relations are read whole rather than scoped to the matched ids, unlike everywhere else: the
    scope here *is* the whole table, and naming ten thousand ids in an `IN` list to say so would
    cost more than the rows do.

    A dependency on an issue the reader may not see is dropped rather than drawn, so the graph
    never hints at what visibility hides — the same rule the edge list was filtered by before. -/
def graphNodes (db : Conn) (actorGroups : Option (Array GroupId)) : IO (Array GraphNode) := do
  let nodes : Query taxis graphView :=
    .project graphHom
      (.orderBy [{ column := IssuesIndex.updated_at, direction := .desc },
                 { column := IssuesIndex.id, direction := .desc }]
        (.filter (visibilityExpr (.var IssuesIndex.id .int) actorGroups) (.all issuesTable)))
  let (rows, labels, deps, assignees) ← run db do
    let rows ← DBMonad.lookup nodes
    let labels ← HasModel.fetch (α := Schema.IssueLabels)
      { query := .orderBy [{ column := IssueLabelsIndex.issue_id },
                           { column := IssueLabelsIndex.label_id }] (.all _) }
    let deps ← HasModel.fetch (α := Schema.IssueDependencies)
      { query := .orderBy [{ column := IssueDependenciesIndex.issue_id },
                           { column := IssueDependenciesIndex.depends_on_id }] (.all _) }
    let assignees ← HasModel.fetch (α := Schema.IssueAssignees)
      { query := .orderBy [{ column := IssueAssigneesIndex.issue_id },
                           { column := IssueAssigneesIndex.actor_id }] (.all _) }
    return (rows,
      groupRel (labels.map fun r => (Int64.ofInt r.issue_id, Int64.ofInt r.label_id)),
      groupRel (deps.map fun r => (Int64.ofInt r.issue_id, Int64.ofInt r.depends_on_id)),
      groupRel (assignees.map fun r => (Int64.ofInt r.issue_id, Int64.ofInt r.actor_id)))
  let visibleIds : Std.HashSet Int64 :=
    rows.foldl (fun s row => s.insert (Int64.ofInt (row.value GraphColumn.id))) {}
  rows.mapM fun row => do
    let key := Int64.ofInt (row.value GraphColumn.id)
    let rel (m : Std.HashMap Int64 (Array Int64)) : Array Int64 := m.getD key #[]
    let parent : Option IssueId :=
      (row.value GraphColumn.parent_id).map fun p => ⟨Int64.ofInt p⟩
    return {
      id := ⟨key⟩, title := row.value GraphColumn.title,
      state := ← issueStateOf (row.value GraphColumn.state),
      locked := row.value GraphColumn.locked,
      parent := parent.filter (fun p => visibleIds.contains p.val),
      labels := (rel labels).map (⟨·⟩),
      dependencies := ((rel deps).filter visibleIds.contains).map (⟨·⟩),
      assignees := (rel assignees).map (⟨·⟩),
      deadline := (row.value GraphColumn.deadline).map fun t => ⟨Int64.ofInt t⟩ }

/-- Where `id` sits among the issues sharing `parent`, and the two either side of it.

    Four indexed statements over `idx_issues_parent`, each answering one question about a set the
    caller never has to hold: how many siblings there are, which one this is, and the names of its
    two neighbours. The alternative — listing the children and finding the issue in them — costs
    the whole set to show two links. -/
def issueSiblings (db : Conn) (id : IssueId) (parent : Option IssueId)
    (actorGroups : Option (Array GroupId)) : IO SiblingNav := do
  let some parentId := parent | return {}
  let scope : List (DBExpr taxis issuesView .bool) :=
    [.eq (.var IssuesIndex.parent_id .int) (.int parentId.val.toInt),
     visibilityExpr (.var IssuesIndex.id .int) actorGroups]
  let count ← run db <| HasModel.count (α := Schema.Issues)
    { query := .filter (conjoin scope) (.all _) }
  let position ← run db <| HasModel.count (α := Schema.Issues)
    { query := .filter (conjoin (scope ++ [.le (.var IssuesIndex.id .int) (.int id.val.toInt)]))
        (.all _) }
  let neighbour (side : DBExpr taxis issuesView .bool) (direction : SortDirection) :
      IO (Option IssueIndexEntry) := do
    let rows ← run db <| DBMonad.lookup <| issueIndexOf <| Query.limit 1
      (.orderBy [{ column := IssuesIndex.id, direction := direction }]
        (.filter (conjoin (scope ++ [side])) (.all issuesTable)))
    return rows[0]?.map indexEntryOf
  pure {
    position := position.toNat
    count := count.toNat
    prev := ← neighbour (.lt (.var IssuesIndex.id .int) (.int id.val.toInt)) .desc
    next := ← neighbour (.gt (.var IssuesIndex.id .int) (.int id.val.toInt)) .asc }

/-- Create an issue with its relations, attributed to `creatorId`. The creator and every assignee
    automatically participate (get notified of future activity). May raise a validation error on
    a cyclic parent.

    The insert supplies every column, timestamps included: the model declares no defaults, and the
    `unixepoch()` the database used to fill in is now `nowSeconds`. It is `insertReturning` that
    reports the generated id, which is what the `RETURNING` clause used to do. `parent_id` is left
    `NULL` here and set by `setParent`, which is where the cycle check lives. -/
def createIssue (db : Conn) (input : IssueInput) (creatorId : Option ActorId := none) : IO Issue :=
  withTransaction db do
    let now ← nowSeconds
    let stored ← run db <| HasModel.insertReturning
      ({ id := 0, title := input.title, description := input.description, goal := input.goal,
         state := input.state.toString, locked := input.locked, parent_id := none,
         created_at := now, updated_at := now,
         creator_id := creatorId.map (·.val.toInt),
         deadline := input.deadline.map (·.epochSeconds.toInt) } : Schema.Issues)
    let id : IssueId := ⟨Int64.ofInt stored.id⟩
    setLabels db id input.labels
    setParent db id input.parent
    setDependencies db id input.dependencies
    setAssignees db id input.assignees
    setVisibility db id input.visibility
    if let some cid := creatorId then addParticipant db id cid
    for a in input.assignees do addParticipant db id a
    match ← getIssue db id with
    | some i => pure i
    | none => throw (IO.userError "issue vanished after insert")

private def sameSet (a b : Array Int64) : Bool :=
  a.size == b.size && a.all (b.contains ·)

/-- Update an issue; absent fields are unchanged. Returns `none` if it does not exist.
    A locked issue rejects changes to its title, description, goal, parent, or dependencies.
    `actorId` attributes the recorded history events to whoever made the change.

    `updated_at` is stamped from `nowSeconds` rather than by the database: the query language has
    no expression for a call the database evaluates, and the two agree to the second. -/
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
      let now ← nowSeconds
      discard <| run db <| HasModel.update (α := Schema.Issues)
        { value
            | .title => some (.text title)
            | .description => some (.text description)
            | .goal => some (.text goal)
            | .state => some (.text state.toString)
            | .locked => some (if locked then .true else .false)
            | .deadline => some (match deadline with
                                 | some t => .int t.epochSeconds.toInt
                                 | none => .null .int)
            | .updated_at => some (.int now)
            | _ => none
          condition := .eq (.var IssuesIndex.id .int) (.int id.val.toInt) }
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
  let removed ← run db <| HasModel.delete (α := Schema.Issues)
    (.eq (.var IssuesIndex.id .int) (.int id.val.toInt))
  return removed > 0

/-- All dependency edges in the tracker, as `(issue, dependsOn)` id pairs. The graph reads them off
    the nodes (see `graphNodes`); this remains the direct way to ask the relation a question. -/
def allDependencyEdges (db : Conn) : IO (Array (IssueId × IssueId)) := do
  let rows ← run db <| HasModel.fetch (QuerySet.all (α := Schema.IssueDependencies))
  return rows.map fun r => (⟨Int64.ofInt r.issue_id⟩, ⟨Int64.ofInt r.depends_on_id⟩)

end Taxis.Db
