import Taxis.Db.Migrations.«0001_initial»

/-!
# The migrations

The schema is a function of this list. `Taxis.Db.Schema.schema` says what the database should look
like; the migrations below are how a database gets there, and the two are kept in step by
`taxis-migrate check` — which the test suite runs as well, so a declaration that has run ahead of
the migrations fails the build rather than the next deployment.

One file per migration under `Taxis/Db/Migrations/`, named `NNNN_description`, where `NNNN` is one
more than the highest number the list already has. A schema change is three steps:

1. edit the declaration in `Taxis.Db.Schema`;
2. `lake exe taxis-migrate makemigrations <description>`, which writes the file;
3. add its `migration_NNNN_description` to `migrations` below, and import the file above.

A migration that has been released is never edited: a database that has applied it will not apply
it again, so the change would take effect in some deployments and not others. Superseding it with
a new migration is the way.
-/

namespace Taxis.Db

/-- Every migration this build declares, oldest first. -/
def migrations : List Db.Migration.Migration :=
  [migration_0001_initial]

end Taxis.Db
