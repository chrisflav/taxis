import SQLite
-- The library root: the query language, the model layer, the declarative migrations and the SQLite
-- backend. This used to be the backend module alone, because the `query%` DSL made `limit`,
-- `offset`, `select` and `guard` keywords in every module downstream of it; the DSL recognises
-- those words inside a `query%` block only now, so there is nothing left to avoid.
import Db
import Taxis.Domain

/-!
# Database connection

A thin wrapper over a `leansqlite` connection. On open we enable foreign-key enforcement and
WAL journalling, and set a busy timeout so concurrent writers retry rather than fail.

Transactions are the `db` library's: `Sqlite.M` is a reader over exactly this connection type, so
running one against a `Conn` is `.run db` and nothing else.
-/

namespace Taxis.Db

/-- A database connection. -/
abbrev Conn := SQLite

/-- Open (creating if necessary) the database at `path` and configure pragmas. -/
def connect (path : System.FilePath) : IO Conn := do
  let db ← SQLite.openWith path .readWriteCreate (busyTimeoutMs := 5000)
  db.exec "PRAGMA foreign_keys = ON"
  db.exec "PRAGMA journal_mode = WAL"
  pure db

/-- Open the database at `path` for reading only.

    WAL journalling — set once, by `connect`, since it is a property of the file rather than of a
    connection — is what makes these worth having: readers on separate connections proceed at the
    same time as each other and as a writer, where readers sharing one connection cannot.

    Neither pragma `connect` sets applies here. `journal_mode` is already recorded in the file and
    setting it needs write access; `foreign_keys` constrains statements that modify data, and this
    connection cannot issue any. -/
def connectReadOnly (path : System.FilePath) : IO Conn :=
  SQLite.openWith path .readonly (busyTimeoutMs := 5000)

/-- Marker prefix on `IO.userError` messages that represent client-side validation failures
    (mapped to HTTP 422 by the API layer). -/
def validationPrefix : String := "VALIDATION: "

/-- Signal a validation failure that the API layer should surface as a 422. -/
def validationError (msg : String) : IO α :=
  throw (IO.userError (validationPrefix ++ msg))

/-- If `e` is a validation error, return its message without the marker prefix. -/
def validationMessage? (e : IO.Error) : Option String :=
  let s := toString e
  if s.startsWith validationPrefix then some (s.drop validationPrefix.length).toString else none

/-- Run `act` inside the library's transaction, committing on success and rolling back on error.

    That is a **deferred** `BEGIN`, where this used to issue `BEGIN IMMEDIATE`, and a nested call
    is a savepoint rather than an error — which is what lets the repository functions call each
    other, as `createIssue` calls `setLabels`, without either of them knowing whether it is the
    outermost.

    A deferred transaction takes its write lock at its first write rather than at `BEGIN`, so in
    general another writer can commit in between and turn the read the transaction started from
    into a stale one (SQLite answers `SQLITE_BUSY_SNAPSHOT` rather than corrupting anything). That
    cannot happen here: there is exactly one write connection, held behind a mutex in
    `Taxis.AppContext`, so no second writer exists to commit in the gap. -/
def withTransaction (db : Conn) (act : IO α) : IO α :=
  (DBMonadTransactional.withTransaction (m := Sqlite.M) (liftM act)).run db

/-- Run `act` inside a transaction, so every statement it issues sees one snapshot of the database
    instead of one a concurrent commit can move underneath it midway.

    A read sharing the writer's connection got this from the mutex for free. A read on its own
    connection has to ask: assembling an issue's detail takes nine statements, and without this a
    commit landing between two of them could return that issue's comments from before an edit
    alongside its events from after.

    The same transaction as `withTransaction`, which is what the readers want: a deferred `BEGIN`
    that only ever reads takes a shared lock and no more, so it is accepted on the read-only
    connections `connectReadOnly` opens. (`lake test` drives the write connection only, so this is
    reasoned rather than measured; an `IMMEDIATE` here would be the one that fails, a read-only
    connection being unable to take the write lock it asks for.) -/
def withReadTransaction (db : Conn) (act : IO α) : IO α :=
  withTransaction db act

end Taxis.Db

namespace Taxis.Db

/-- Run a typed database action against a connection. `Sqlite.M` is a reader over exactly this
    connection type, so this is `.run db` and nothing else; it exists so that the repository
    functions, which take a `Conn` and return `IO`, read uniformly. -/
def run (db : Conn) (act : Sqlite.M α) : IO α :=
  act.run db

/-- The current time in seconds since the Unix epoch — what the database used to supply through
    `unixepoch()`. The query language has no expression for a call the database evaluates, so the
    timestamps the repository writes (`updated_at`, `last_run`, a session's expiry) are taken from
    this clock instead; the two agree to the second, and nothing compares them more finely. -/
def nowSeconds : IO Int := do
  return (← Std.Time.Timestamp.now).toSecondsSinceUnixEpoch.toInt

end Taxis.Db
