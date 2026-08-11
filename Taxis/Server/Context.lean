import Taxis.Db
import Taxis.Config
import Std.Sync.Mutex

/-!
# Application context

Shared server state: the database connection (guarded by a mutex so the async server's
concurrent connection handlers serialise their SQLite access) and the runtime configuration
(`Taxis.Config`, read at startup).
-/

namespace Taxis

/-- Shared, thread-safe application context. -/
structure AppContext where
  /-- The write connection. Everything that changes the database goes through this one, under the
      mutex, so writes remain serialised against each other. -/
  db : Std.Mutex Db.Conn
  /-- Connections that reads use instead of the write connection.

      One connection behind one mutex made every request in the server queue behind every other,
      including reads that have nothing to do with one another: opening a single page issues around
      half a dozen, and each waited out all of the ones before it. WAL journalling lets readers run
      concurrently with each other and with a writer, but only on separate connections — so here
      they are. Opened read-only, so a statement that turns out to write is refused here rather
      than quietly racing the writer. -/
  readers : Array (Std.Mutex Db.Conn)
  /-- Rotates through `readers`. A lost update under contention costs an uneven spread across the
      connections and nothing else, so it does not need to be atomic. -/
  readCursor : IO.Ref Nat
  config : Config

namespace AppContext

/-- How many read connections to open. A browser opens at most six connections to one origin and a
    page load uses most of them, so this is enough to overlap a page's worth of reads without
    holding open handles that nothing is waiting on. -/
def readerCount : Nat := 4

/-- Run a database action while holding the write connection's mutex. -/
def withDb (ctx : AppContext) (act : Db.Conn → IO α) : IO α :=
  ctx.db.atomically do
    let conn ← get
    act conn

/-- Run a **read-only** database action on one of the reader connections, so it does not queue
    behind unrelated reads. Falls back to the write connection if none were opened.

    Only for actions that issue no statement which modifies data: the connections are opened
    read-only, so one that does will fail rather than corrupt anything. -/
def withRead (ctx : AppContext) (act : Db.Conn → IO α) : IO α := do
  let n ← ctx.readCursor.modifyGet (fun n => (n, n + 1))
  match ctx.readers[n % max ctx.readers.size 1]? with
  | some reader => reader.atomically do
      let conn ← get
      Db.withReadTransaction conn (act conn)
  | none => ctx.withDb act

/-- Build a context: open and migrate the database, then wrap it in a mutex. -/
def create (config : Config) : IO AppContext := do
  let conn ← Db.connect config.dbPath
  Db.migrate conn
  let db ← Std.Mutex.new conn
  -- After `migrate`: the file has to exist, with its schema, before anything opens it read-only.
  let readers ← (Array.range readerCount).mapM fun _ => do
    let reader ← Db.connectReadOnly config.dbPath
    Std.Mutex.new reader
  let readCursor ← IO.mkRef 0
  pure { db, readers, readCursor, config }

end AppContext

end Taxis
