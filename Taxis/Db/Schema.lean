-- The model layer, the migrations and the SQLite backend. Not the library's root `Db`: see the
-- note on the same import in `Taxis.Db.Connection`.
import Db.Backends.SQLite.Interpretation
import Taxis.Db.Connection

/-!
# Schema and migrations

The schema is **declared in Lean**, with the [`db`](https://github.com/chrisflav/db) library, and
the database is brought to it rather than being described by hand-written DDL.

It is declared in two halves, because the two halves say different kinds of thing:

* the `@[model]` structures below are the *rows*: one structure per table, one field per column,
  with the field name being the column name and the field type its SQL type. They are what a typed
  query returns and what a typed insert takes, and they are all `@[model]` can express;
* everything a column cannot say on its own — primary keys of the join tables, `UNIQUE` groups,
  foreign keys with their `ON DELETE` action, column defaults and indexes — is declared on
  `schema`, the `DatabaseRecipe` the models generate, patched by the small combinators below.

`schema` is what `autoUpdate` targets, so it is the single description of what the database should
look like; `migrate` finishes by asserting that the database it leaves behind really is that
description, columns, indexes and constraints alike.

The column defaults are declared even though every typed insert supplies every column: they keep
the database self-describing (a row written by `sqlite3` by hand is still a valid row), and the
modules that have not been ported yet write `INSERT`s that name only some columns and rely on them.

Full-text search is done with `LIKE` because the bundled SQLite amalgamation is built without the
FTS5 extension.

## The indexes on `issues`

`idx_issues_updated`, `idx_issues_title` and `idx_issues_deadline` are the three orders the issue
list can be read in. Without them every page of the list is a full table scan into a temporary
B-tree: at ten thousand issues that is 41 ms for the default order against 0.7 ms with the index,
and the cost is 2.4% of the database on disk and about 3 µs per issue written.
`updated_at DESC, id DESC` doubles as the key the list pages on, so a cursor walks the index
instead of counting rows with `OFFSET`. The title index is declared `caseInsensitive`, which the
library emits as `lower("title")` — the expression form of the old `COLLATE NOCASE`, and the one
an `order_by … nocase` can actually use.
-/

/-- The insert that supplies **every** column of an entry, the generated key included.

`Database.Insert.ofEntry` leaves an `autoIncrement` column out so the database can assign it, which
is what an application insert wants. Copying rows between two shapes of the same table is the case
that wants the opposite: the id is part of the data, and everything referencing it would otherwise
point at the wrong row. -/
def Database.Insert.ofEntryAll {d : Database} {tableName : d.Index}
    (e : (d.tables tableName).Entry) : d.Insert tableName where
  value idx := some (e.value idx)
  omitted_isOptional := by simp

namespace Taxis.Db.Schema

initialize_database taxisdb

/-- A person or a bot. `google_sub`/`github_id` link the accounts that can sign in as this actor;
`admin` may manage actors, groups and labels, `bot` is only a marker in the interface. -/
@[model (dbName := "actors") taxisdb]
structure Actors where
  id : AutoKey
  email : String
  display_name : String
  google_sub : Option String
  github_id : Option String
  admin : Bool
  bot : Bool
  deriving Repr

/-- A set of actors, used as a visibility filter. -/
@[model (dbName := "groups") taxisdb]
structure Groups where
  id : AutoKey
  name : String
  description : Option String
  deriving Repr

/-- Membership of an actor in a group. -/
@[model (dbName := "actor_groups") taxisdb]
structure ActorGroups where
  actor_id : Int
  group_id : Int
  deriving Repr

/-- An issue: what the tracker tracks. `parent_id` is the hierarchical relation (the Tree view),
`goal` the condition that has to hold for it to be completed, and `locked` freezes the fields that
describe the work. -/
@[model (dbName := "issues") taxisdb]
structure Issues where
  id : AutoKey
  title : String
  description : String
  goal : String
  state : String
  locked : Bool
  parent_id : Option Int
  created_at : Int
  updated_at : Int
  creator_id : Option Int
  deadline : Option Int
  deriving Repr

/-- A reusable named tag an issue can carry any number of. -/
@[model (dbName := "labels") taxisdb]
structure Labels where
  id : AutoKey
  name : String
  description : Option String
  color : String
  deriving Repr

/-- A label carried by an issue. -/
@[model (dbName := "issue_labels") taxisdb]
structure IssueLabels where
  issue_id : Int
  label_id : Int
  deriving Repr

/-- An edge of the dependency graph: `issue_id` depends on `depends_on_id`. -/
@[model (dbName := "issue_dependencies") taxisdb]
structure IssueDependencies where
  issue_id : Int
  depends_on_id : Int
  deriving Repr

/-- An actor assigned to an issue. -/
@[model (dbName := "issue_assignees") taxisdb]
structure IssueAssignees where
  issue_id : Int
  actor_id : Int
  deriving Repr

/-- A group an issue is restricted to. An issue with no such row is visible to everyone. -/
@[model (dbName := "issue_visibility") taxisdb]
structure IssueVisibility where
  issue_id : Int
  group_id : Int
  deriving Repr

/-- Something attached to an issue — a pull request, a branch, a file, a note. `kind` names the
plugin that understands `payload`, which is JSON the core stores verbatim. -/
@[model (dbName := "artifacts") taxisdb]
structure Artifacts where
  id : AutoKey
  issue_id : Int
  kind : String
  payload : String
  deriving Repr

/-- A condition on an issue that something outside the tracker decides — "CI passes on this
branch". `kind` names the plugin, `config` is its JSON configuration, `status`/`detail`/`last_run`
are the last verdict. -/
@[model (dbName := "checks") taxisdb]
structure Checks where
  id : AutoKey
  issue_id : Int
  kind : String
  config : String
  status : String
  detail : Option String
  last_run : Option Int
  deriving Repr

/-- A browser session. The `id` is the opaque token in the cookie, so it is the primary key rather
than a generated one. -/
@[model (dbName := "sessions") taxisdb]
structure Sessions where
  id : String
  actor_id : Int
  created_at : Int
  expires_at : Int
  deriving Repr

/-- A comment on an issue. `author_id` is nullable so a comment outlives its author; a comment with
a `review` verdict is a review. -/
@[model (dbName := "comments") taxisdb]
structure Comments where
  id : AutoKey
  issue_id : Int
  author_id : Option Int
  body : String
  created_at : Int
  updated_at : Int
  review : Option String
  deriving Repr

/-- One recorded change to an issue: its history. `data` is the JSON detail of the change. -/
@[model (dbName := "events") taxisdb]
structure Events where
  id : AutoKey
  issue_id : Int
  actor_id : Option Int
  kind : String
  data : String
  created_at : Int
  deriving Repr

/-- A personal access token. Only the SHA-256 hash is stored; `prefix` is the visible head of the
secret, so a token can be recognised in a list. -/
@[model (dbName := "api_tokens") taxisdb]
structure ApiTokens where
  id : AutoKey
  actor_id : Int
  name : String
  token_hash : String
  «prefix» : String
  created_at : Int
  last_used : Option Int
  deriving Repr

/-- Participants opt in (explicitly, or automatically as creator/assignee) to notifications about
an issue's activity. -/
@[model (dbName := "issue_participants") taxisdb]
structure IssueParticipants where
  issue_id : Int
  actor_id : Int
  deriving Repr

/-- One row per (recipient, activity): fanned out from events/comments to every participant of the
issue except whoever triggered the activity. `read` (seen) and `done` (resolved) are independent.
-/
@[model (dbName := "notifications") taxisdb]
structure Notifications where
  id : AutoKey
  actor_id : Int
  issue_id : Int
  kind : String
  data : String
  read : Bool
  done : Bool
  created_at : Int
  deriving Repr

/-- An explicit ask for `actor_id` to review an issue, independent of assignment. `resolved_at` is
set once that actor posts a review, or the request is withdrawn/fulfilled. -/
@[model (dbName := "review_requests") taxisdb]
structure ReviewRequests where
  id : AutoKey
  issue_id : Int
  actor_id : Int
  requested_by : Option Int
  created_at : Int
  resolved_at : Option Int
  deriving Repr

/-! ## Patching the generated recipe

`@[model]` generates a table with its columns and, for an `AutoKey`, its primary key — and nothing
else, since which of a structure's fields are unique, which reference another table and what a
column defaults to are not things the structure says. These are the combinators that add them; each
takes the recipe last, so a table's constraints read as a pipeline. -/

/-- Apply `f` to the named table of a recipe. -/
private def withTable (name : String) (f : TableRecipe → TableRecipe) (r : DatabaseRecipe) :
    DatabaseRecipe where
  tables := r.tables.map fun n t => if n == name then f t else t

/-- Give a column the value the database fills in when an insert omits it. -/
private def withDefault (col : String) (default : ColumnDefault) (t : TableRecipe) : TableRecipe :=
  { t with columns := t.columns.map fun n c => if n == col then { c with default? := default } else c }

/-- Declare the table's primary key, for the tables whose key is not a generated id. -/
private def withPrimaryKey (cols : List String) (t : TableRecipe) : TableRecipe :=
  { t with primaryKey := cols }

/-- Declare that a column's values are unique across the table. -/
private def withUnique (col : String) (t : TableRecipe) : TableRecipe :=
  { t with unique := t.unique ++ [[col]] }

/-- Declare that a column references a column of another table, and what happens to this row when
the referenced one is deleted. -/
private def withForeignKey (col : String) (foreignTable : String) (foreignColumn : String)
    (onDelete : ForeignKeyAction) (t : TableRecipe) : TableRecipe :=
  { t with
      foreignKeys := t.foreignKeys ++
        [{ columns := [col], foreignTable := foreignTable, foreignColumns := [foreignColumn],
           onDelete := onDelete }] }

/-- The schema this build expects: the models above, with the constraints, defaults and indexes
that `@[model]` cannot express.

This is what `migrate` brings the database to, and what it then checks the database against. -/
def schema : DatabaseRecipe :=
  (%database taxisdb).recipe
    |> withTable "actors" (fun t => t
        |> withUnique "email"
        |> withUnique "google_sub"
        |> withUnique "github_id"
        |> withDefault "admin" (.bool false)
        |> withDefault "bot" (.bool false))
    |> withTable "groups" (withUnique "name")
    |> withTable "actor_groups" (fun t => t
        |> withPrimaryKey ["actor_id", "group_id"]
        |> withForeignKey "actor_id" "actors" "id" .cascade
        |> withForeignKey "group_id" "groups" "id" .cascade)
    |> withTable "issues" (fun t => t
        |> withDefault "description" (.str "")
        |> withDefault "goal" (.str "")
        |> withDefault "state" (.str "open")
        |> withDefault "locked" (.bool false)
        |> withDefault "created_at" (.call "unixepoch()")
        |> withDefault "updated_at" (.call "unixepoch()")
        |> withForeignKey "parent_id" "issues" "id" .setNull
        |> withForeignKey "creator_id" "actors" "id" .setNull)
    |> withTable "labels" (fun t => t
        |> withUnique "name"
        |> withDefault "color" (.str "#6b7280"))
    |> withTable "issue_labels" (fun t => t
        |> withPrimaryKey ["issue_id", "label_id"]
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "label_id" "labels" "id" .cascade)
    |> withTable "issue_dependencies" (fun t => t
        |> withPrimaryKey ["issue_id", "depends_on_id"]
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "depends_on_id" "issues" "id" .cascade)
    |> withTable "issue_assignees" (fun t => t
        |> withPrimaryKey ["issue_id", "actor_id"]
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "actor_id" "actors" "id" .cascade)
    |> withTable "issue_visibility" (fun t => t
        |> withPrimaryKey ["issue_id", "group_id"]
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "group_id" "groups" "id" .cascade)
    |> withTable "artifacts" (fun t => t
        |> withDefault "payload" (.str "null")
        |> withForeignKey "issue_id" "issues" "id" .cascade)
    |> withTable "checks" (fun t => t
        |> withDefault "config" (.str "null")
        |> withDefault "status" (.str "pending")
        |> withForeignKey "issue_id" "issues" "id" .cascade)
    |> withTable "sessions" (fun t => t
        |> withPrimaryKey ["id"]
        |> withDefault "created_at" (.call "unixepoch()")
        |> withForeignKey "actor_id" "actors" "id" .cascade)
    |> withTable "comments" (fun t => t
        |> withDefault "created_at" (.call "unixepoch()")
        |> withDefault "updated_at" (.call "unixepoch()")
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "author_id" "actors" "id" .setNull)
    |> withTable "events" (fun t => t
        |> withDefault "data" (.str "{}")
        |> withDefault "created_at" (.call "unixepoch()")
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "actor_id" "actors" "id" .setNull)
    |> withTable "api_tokens" (fun t => t
        |> withUnique "token_hash"
        |> withDefault "name" (.str "")
        |> withDefault "prefix" (.str "")
        |> withDefault "created_at" (.call "unixepoch()")
        |> withForeignKey "actor_id" "actors" "id" .cascade)
    |> withTable "issue_participants" (fun t => t
        |> withPrimaryKey ["issue_id", "actor_id"]
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "actor_id" "actors" "id" .cascade)
    |> withTable "notifications" (fun t => t
        |> withDefault "data" (.str "{}")
        |> withDefault "read" (.bool false)
        |> withDefault "done" (.bool false)
        |> withDefault "created_at" (.call "unixepoch()")
        |> withForeignKey "actor_id" "actors" "id" .cascade
        |> withForeignKey "issue_id" "issues" "id" .cascade)
    |> withTable "review_requests" (fun t => t
        |> withDefault "created_at" (.call "unixepoch()")
        |> withForeignKey "issue_id" "issues" "id" .cascade
        |> withForeignKey "actor_id" "actors" "id" .cascade
        |> withForeignKey "requested_by" "actors" "id" .setNull)
    -- Every foreign-key column is indexed, so that the graph, assignment and notification queries
    -- do not scan; `tableIndexes` names the columns through the model's index type, so a column
    -- that is renamed takes its index with it instead of leaving a string behind.
    |>.withIndexes "actor_groups" (tableIndexes ActorGroupsIndex
        [{ name := "idx_actor_groups_group", keys := [{ column := .group_id }] }])
    |>.withIndexes "issues" (tableIndexes IssuesIndex
        [{ name := "idx_issues_state", keys := [{ column := .state }] },
         { name := "idx_issues_parent", keys := [{ column := .parent_id }] },
         { name := "idx_issues_updated",
           keys := [{ column := .updated_at, direction := .desc },
                    { column := .id, direction := .desc }] },
         { name := "idx_issues_title",
           keys := [{ column := .title, collation := .caseInsensitive }, { column := .id }] },
         { name := "idx_issues_deadline",
           keys := [{ column := .deadline }, { column := .id }] }])
    |>.withIndexes "issue_labels" (tableIndexes IssueLabelsIndex
        [{ name := "idx_issue_labels_label", keys := [{ column := .label_id }] }])
    |>.withIndexes "issue_dependencies" (tableIndexes IssueDependenciesIndex
        [{ name := "idx_issue_dependencies_dep", keys := [{ column := .depends_on_id }] }])
    |>.withIndexes "issue_assignees" (tableIndexes IssueAssigneesIndex
        [{ name := "idx_issue_assignees_actor", keys := [{ column := .actor_id }] }])
    |>.withIndexes "issue_visibility" (tableIndexes IssueVisibilityIndex
        [{ name := "idx_issue_visibility_group", keys := [{ column := .group_id }] }])
    |>.withIndexes "artifacts" (tableIndexes ArtifactsIndex
        [{ name := "idx_artifacts_issue", keys := [{ column := .issue_id }] }])
    |>.withIndexes "checks" (tableIndexes ChecksIndex
        [{ name := "idx_checks_issue", keys := [{ column := .issue_id }] }])
    |>.withIndexes "sessions" (tableIndexes SessionsIndex
        [{ name := "idx_sessions_actor", keys := [{ column := .actor_id }] }])
    |>.withIndexes "comments" (tableIndexes CommentsIndex
        [{ name := "idx_comments_issue", keys := [{ column := .issue_id }] },
         { name := "idx_comments_author", keys := [{ column := .author_id }] }])
    |>.withIndexes "events" (tableIndexes EventsIndex
        [{ name := "idx_events_issue", keys := [{ column := .issue_id }] },
         { name := "idx_events_author", keys := [{ column := .actor_id }] }])
    |>.withIndexes "api_tokens" (tableIndexes ApiTokensIndex
        [{ name := "idx_api_tokens_actor", keys := [{ column := .actor_id }] }])
    |>.withIndexes "issue_participants" (tableIndexes IssueParticipantsIndex
        [{ name := "idx_issue_participants_actor", keys := [{ column := .actor_id }] }])
    |>.withIndexes "notifications" (tableIndexes NotificationsIndex
        [{ name := "idx_notifications_actor",
           keys := [{ column := .actor_id }, { column := .read }] },
         { name := "idx_notifications_issue", keys := [{ column := .issue_id }] }])
    |>.withIndexes "review_requests" (tableIndexes ReviewRequestsIndex
        [{ name := "idx_review_requests_issue", keys := [{ column := .issue_id }] },
         { name := "idx_review_requests_actor", keys := [{ column := .actor_id }] }])

/-- Insert a model value with the value its `AutoKey` already has, rather than letting the database
assign one. For copying rows that already exist and are already referenced — see
`Database.Insert.ofEntryAll`. -/
def insertFull {α : Type} {m : Type → Type} [HasModel α]
    [DBMonad (HasModel.database α) m] (x : α) : m Unit :=
  -- The ascription is what fixes the table the insert is into: without it the `HasTable` instance
  -- is asked for at an index that is still a metavariable.
  let data : (HasModel.database α).Insert (HasModel.model α).index :=
    .ofEntryAll <| HasTable.encoding.toFun x
  DBMonad.insert data

/-! ## The database the last release wrote

`schema_version` is not part of `schema`: it is the bookkeeping of the schema layer this one
replaces, and the cutover in `Taxis.Db.migrate` reads it once and then drops it. It lives in a
database of its own so that it cannot be mistaken for a table the target schema declares. -/

initialize_database taxisLegacy

/-- The single row of the `schema_version` table of a database written by an older release. -/
@[model (dbName := "schema_version") taxisLegacy]
structure SchemaVersion where
  version : Int
  deriving Repr

/-- The schema version the last release before the port left behind, and the only one this
release's cutover can read. -/
def legacyVersion : Int := 14

end Taxis.Db.Schema

namespace Taxis.Db

open Taxis.Db.Schema

/-- Rebuild a database written by the pre-`db` releases through the typed API.

This is a one-off copy rather than an `autoUpdate` because `autoUpdate` cannot get there:

* the old databases exist in two constraint shapes. A column added by one of the old `ALTER`
  ladders has neither the `UNIQUE` nor the `NOT NULL` that the same column got from a fresh
  `CREATE TABLE` — `actors.github_id` is unique in a database created at v12 or later and not
  unique in one that grew into it — and a constraint change on an existing table is exactly what
  `autoUpdate` refuses to do;
* the flag columns change type, from SQLite `integer` to the library's `bool`.

So every row is read out through the new schema's views, every table is dropped, the target tables
are created from the declaration, and the rows are written back with their keys. Foreign keys are
off for the duration: the tables reference each other, the rows go back in whatever order the
tables are listed in, and an issue may perfectly well have a parent with a higher id. The pragma is
a no-op inside a transaction, so it is set around the one this runs in, and what it would have
caught is checked with `PRAGMA foreign_key_check` afterwards. -/
private def cutOverLegacyDatabase : Sqlite.M Unit := do
  let versionRows ← DBMonad.lookup (Query.all (HasModel.model SchemaVersion).index)
  let stored : Option Int := versionRows[0]?.map fun row => row.value SchemaVersionIndex.version
  unless stored == some legacyVersion do
    throw <| IO.userError <|
      s!"this database is at schema version {repr stored}, and this release can only convert " ++
      s!"version {legacyVersion}. Run the previous release of taxis against it first: its " ++
      "`migrate` brings any older database up to 14."
  -- Before the transaction: `PRAGMA foreign_keys` is a no-op inside one.
  DBMonadWithMigrations.rawExecute "PRAGMA foreign_keys = OFF"
  try
    DBMonadTransactional.withTransaction (m := Sqlite.M) do
      -- The old tables carry every column the new views select; the retired `issues.label` is
      -- simply not one of them, and the integer flag columns decode as `Bool`.
      let mut saved : Array ((t : (%database taxisdb).Index) × Array (Table.view t).Entry) := #[]
      for t in Enum.all (%database taxisdb).Index do
        saved := saved.push ⟨t, ← DBMonad.lookup (Query.all t)⟩
      for name in (← DBMonadWithMigrations.currentDatabase).tables.keys do
        DBMonadWithMigrations.execute (.remove name)
      DBMonadWithMigrations.executeMany ((∅ : DatabaseRecipe).operations schema)
      for ⟨t, rows⟩ in saved do
        for row in rows do
          DBMonad.insert (name := t) (.ofEntryAll ((Table.entryViewEquiv t).toFun row))
  finally
    DBMonadWithMigrations.rawExecute "PRAGMA foreign_keys = ON"
  let violations ← Sqlite.query "PRAGMA foreign_key_check"
  unless violations.isEmpty do
    throw <| IO.userError <|
      s!"converting the legacy database left {violations.size} row(s) violating a foreign key"
  IO.println "[taxis] converted a legacy (schema_version 14) database to the declared schema"

/-- Bring the database at `db` to `Taxis.Db.Schema.schema`.

Three steps, of which the middle one is only for a database the previous releases wrote:

1. read what is actually there;
2. if it has a `schema_version` table it was written before the port, so rebuild it through the
   typed API (`cutOverLegacyDatabase`);
3. `autoUpdate` to the declared schema — which creates everything on a fresh database, creates the
   indexes after a cutover, and applies whatever column additions a future release declares — and
   then assert that the database and the declaration have converged.

The assertion at the end is what catches a declaration the database cannot be brought to: an
`autoUpdate` that silently leaves work undone would otherwise be discovered by a query failing
much later. -/
def migrate (db : Conn) : IO Unit := do
  let act : Sqlite.M Unit := do
    let current ← DBMonadWithMigrations.currentDatabase
    if current.tables.contains "schema_version" then
      cutOverLegacyDatabase
    DBMonadWithMigrations.autoUpdate schema
    -- `.without` for the same reason `autoUpdate` reads its source that way: the tables the
    -- migration framework owns are nobody's application schema, so they are not a difference.
    let after := (← DBMonadWithMigrations.currentDatabase).without Db.Migration.frameworkTables
    let pending := after.operations schema
    let indexPending := after.indexOperations schema
    let mismatches := after.constraintMismatches schema
    unless pending.isEmpty && indexPending.isEmpty && mismatches.isEmpty do
      throw <| IO.userError <|
        s!"the database did not converge to the declared schema. Pending operations: " ++
        s!"{repr pending}. Pending index operations: {repr indexPending}. Tables whose " ++
        s!"constraints differ: {repr mismatches}."
  act.run db

end Taxis.Db
