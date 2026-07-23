import SQLite
import Taxis.Domain

/-!
# Database connection

A thin wrapper over a `leansqlite` connection. On open we enable foreign-key enforcement and
WAL journalling, and set a busy timeout so concurrent writers retry rather than fail.
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

/-- Run `act` inside a deferred (read) transaction, so every statement it issues sees one snapshot
    of the database instead of one a concurrent commit can move underneath it midway.

    A read sharing the writer's connection got this from the mutex for free. A read on its own
    connection has to ask: assembling an issue's detail takes nine statements, and without this a
    commit landing between two of them could return that issue's comments from before an edit
    alongside its events from after. -/
def withReadTransaction (db : Conn) (act : IO α) : IO α := do
  db.exec "BEGIN DEFERRED"
  try
    let r ← act
    db.exec "COMMIT"
    pure r
  catch e =>
    try db.exec "ROLLBACK" catch _ => pure ()
    throw e

/-- Run `act` inside a transaction, committing on success and rolling back on error. -/
def withTransaction (db : Conn) (act : IO α) : IO α := do
  db.exec "BEGIN IMMEDIATE"
  try
    let r ← act
    db.exec "COMMIT"
    pure r
  catch e =>
    try db.exec "ROLLBACK" catch _ => pure ()
    throw e

end Taxis.Db
