import Taxis.Db.Schema
import Taxis.Db.Migrations

/-!
# Bringing a database to the declared schema

The database is built and evolved by the migrations in `Taxis.Db.Migrations`, applied by
`Db.Migration.migrate`, which records each in the `db_migrations` table and never applies one
twice. Nothing here introspects a database and works out what to do to it: what a deployment gets
is what the committed migration list says, the same on every machine.

`Taxis.Db.Schema.schema` still has a job, two in fact. It is the declaration `makemigrations`
diffs the migrations against, so that a schema change is written by the library rather than by
hand; and it is what `migrate` asserts the database against once the migrations have run, which is
the check that the two halves have not drifted apart.

The one database this cannot describe is one an **earlier release** wrote. Those predate the
migration framework and carry a `schema_version` table instead, so they are converted first, into
exactly the state migration `0001_initial` would have left — see `cutOverLegacyDatabase`.
-/

namespace Taxis.Db

open Taxis.Db.Schema

/-- Rebuild a database written by the pre-`db` releases so that it is indistinguishable from one
this release created.

This is a one-off copy rather than a migration step because no schema operation gets there:

* the old databases exist in two constraint shapes. A column added by one of the old `ALTER`
  ladders has neither the `UNIQUE` nor the `NOT NULL` that the same column got from a fresh
  `CREATE TABLE` — `actors.github_id` is unique in a database created at v12 or later and not
  unique in one that grew into it — and a constraint change on an existing table is exactly what
  the operation language cannot say;
* the flag columns change type, from SQLite `integer` to the library's `bool`.

So every row is read out through the new schema's views, every table the database has is dropped —
`schema_version` included — and the tables are then created by running the steps of
`migration_0001_initial`, which is what makes the result the same object a fresh database is: the
same `CREATE TABLE`s and the same 23 `CREATE INDEX`es, from the same committed source, rather than
a second rendering of the declaration that could differ from it. The rows go back in with their
keys, and the migration is recorded, so the converted database has applied `0001_initial` exactly
as a fresh one has and every later migration is applied to both by the same call.

Foreign keys are off for the duration: the tables reference each other, the rows go back in
whatever order the tables are listed in, and an issue may perfectly well have a parent with a
higher id. The pragma is a no-op inside a transaction, so it is set around the one this runs in,
and what it would have caught is checked with `PRAGMA foreign_key_check` afterwards. -/
private def cutOverLegacyDatabase (now : Int) : Sqlite.M Unit := do
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
      for step in migration_0001_initial.steps do
        Db.Migration.Step.execute step
      for ⟨t, rows⟩ in saved do
        for row in rows do
          DBMonad.insert (name := t) (.ofEntryAll ((Table.entryViewEquiv t).toFun row))
      Db.Migration.ensureTrackingTable
      Db.Migration.record migration_0001_initial.name now
  finally
    DBMonadWithMigrations.rawExecute "PRAGMA foreign_keys = ON"
  let violations ← Sqlite.query "PRAGMA foreign_key_check"
  unless violations.isEmpty do
    throw <| IO.userError <|
      s!"converting the legacy database left {violations.size} row(s) violating a foreign key"
  IO.println "[taxis] converted a legacy (schema_version 14) database to the declared schema"

/-- Bring the database at `db` to `Taxis.Db.Schema.schema`.

Three steps, of which the first two only concern a database that is not already one of this
release's:

1. read what is actually there. A database with a `schema_version` table was written before the
   port, so it is converted (`cutOverLegacyDatabase`) into the state `0001_initial` leaves, and
   carries on from there like any other;
2. a database with application tables but **no** migration record and no `schema_version` is
   refused. It is not a state any release produces: it can only have been created by a development
   build of this branch, before the migrations existed, and `Db.Migration.migrate` would run
   `0001_initial`'s `CREATE TABLE`s against the tables it already has and fail on the first one,
   which says nothing about what is wrong;
3. `Db.Migration.migrate`, which applies the migrations the database has not recorded, in order,
   and records each.

Then the assertion: the database is compared back against the declaration, and anything still
pending — a table, a column, an index, a constraint — stops the server. That is what keeps the two
halves honest in the direction `taxis-migrate check` cannot see, which is whether the migrations
really produce the declared schema *on a database*, rather than only on the recipe the fold
computes. `.without` the framework's own tables, because `db_migrations` is nobody's application
schema and so is not a difference. -/
def migrate (db : Conn) : IO Unit := do
  let now ← nowSeconds
  let act : Sqlite.M Unit := do
    let current ← DBMonadWithMigrations.currentDatabase
    if current.tables.contains "schema_version" then
      cutOverLegacyDatabase now
    else if !current.tables.contains Db.Migration.trackingTableName &&
        !(current.without Db.Migration.frameworkTables).tables.isEmpty then
      throw <| IO.userError <|
        "this database has the schema but no migration record; it was created by a development " ++
        "build of the port, before the migrations existed. Recreate it, or record the " ++
        "migrations it already has by hand with `taxis-migrate`."
    for name in ← Db.Migration.migrate migrations now do
      IO.println s!"[taxis] applied migration {name}"
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
