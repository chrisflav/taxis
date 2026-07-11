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
