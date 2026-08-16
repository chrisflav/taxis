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
  /-- The groups named by `config.readGroups`, resolved to ids once at startup. Empty unless
      private mode is on with at least one group named, which is what makes the check on the
      request path a comparison against an array the context already holds rather than a lookup
      by name per request. -/
  readGroupIds : Array GroupId := #[]

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
  -- Before the connection goes behind the mutex, while it is still the only one there is. Only
  -- under private mode: naming a read group on an open instance should not conjure it into the
  -- admin screens, where it would look like a group that gates something.
  let readGroupIds ←
    if config.privateMode then
      config.readGroups.toArray.mapM fun name => do pure (← Db.getOrCreateGroupByName conn name).id
    else pure #[]
  let db ← Std.Mutex.new conn
  -- After `migrate`: the file has to exist, with its schema, before anything opens it read-only.
  let readers ← (Array.range readerCount).mapM fun _ => do
    let reader ← Db.connectReadOnly config.dbPath
    Std.Mutex.new reader
  let readCursor ← IO.mkRef 0
  pure { db, readers, readCursor, config, readGroupIds }

end AppContext

/-- Whether `actor` may read an instance whose read access is restricted to `readGroups`.

    Separated from the configuration it is read out of below so the rule itself is a function of
    its two inputs: an empty `readGroups` admits any authenticated actor, which is what
    `auth.private` on its own means.

    Administrators are admitted whatever the groups say. It is not a privilege they did not have —
    an admin can add themselves to any group through the actor screens — and without it a mistyped
    `auth.readGroups` locks every last person out of the instance, with the one account that could
    repair it locked out too. -/
def mayReadGroups (readGroups : Array GroupId) (actor : Option Actor) : Bool :=
  match actor with
  | none => false
  | some a => a.admin || readGroups.isEmpty || readGroups.any (a.groups.contains ·)

/-- Whether `actor` may read this instance at all. Always true while private mode is off: an open
    instance restricts individual issues (`issue_visibility`), never the instance. -/
def AppContext.mayRead (ctx : AppContext) (actor : Option Actor) : Bool :=
  !ctx.config.privateMode || mayReadGroups ctx.readGroupIds actor

end Taxis
