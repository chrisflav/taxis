import Taxis.Db
import Std.Sync.Mutex
import Std.Data.HashMap

/-!
# Application context

Shared server state: the database connection (guarded by a mutex so the async server's
concurrent connection handlers serialise their SQLite access) and runtime configuration read
from the environment.
-/

namespace Taxis

/-- Runtime configuration, populated from environment variables at startup. -/
structure Config where
  port : UInt16 := 8080
  /-- IPv4 address the server binds to. -/
  host : String := "127.0.0.1"
  dbPath : System.FilePath := "issues.sqlite"
  frontendDir : System.FilePath := "frontend/dist"
  /-- Public base URL the server is reachable at (used to build the OAuth redirect URI). -/
  publicBaseUrl : String := "http://localhost:8080"
  googleClientId : Option String := none
  googleClientSecret : Option String := none
  /-- GitHub OAuth App credentials, for "Sign in with GitHub". Distinct from `githubToken` below,
      which is a personal-access token used for GitHub *API calls*, not login. -/
  githubClientId : Option String := none
  githubClientSecret : Option String := none
  /-- Personal-access token used for GitHub API calls by import/check plugins. -/
  githubToken : Option String := none
  /-- Interval in seconds for the background check sweeper; `0` disables it. -/
  checkIntervalSeconds : Nat := 0
  /-- How long a repository's resolved dependencies stay cached, in seconds. Building the
      repository graph reads package manifests over the network, so it is cached rather than
      recomputed per request; `0` disables caching. -/
  repoDepsTtlSeconds : Nat := 3600
  /-- Emails that are automatically granted admin on login (bootstrap). -/
  adminEmails : List String := []
  /-- Central login password; when set, password login is enabled (`ISSUES_CENTRAL_PASSWORD`). -/
  centralPassword : Option String := none
  /-- Log every incoming request to stderr (enabled with `--verbose`). -/
  verbose : Bool := false
deriving Inhabited

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

private def stripQuotes (s : String) : String :=
  match s.toList with
  | q :: _ =>
    if (q == '"' || q == '\'') && s.length ≥ 2 && s.toList.getLast? == some q then
      String.ofList ((s.toList.drop 1).dropLast)
    else s
  | [] => s

/-- Parse the contents of a `.env` file into key/value pairs. Supports `#` comments,
    an optional `export ` prefix, and single/double-quoted values. -/
private def parseDotenv (content : String) : Std.HashMap String String := Id.run do
  let mut m : Std.HashMap String String := {}
  for rawLine in content.splitOn "\n" do
    let line := rawLine.trimAscii.toString
    if line.isEmpty || line.startsWith "#" then continue
    let line := if line.startsWith "export " then (line.drop 7).toString else line
    match line.splitOn "=" with
    | key :: rest@(_ :: _) =>
      m := m.insert key.trimAscii.toString (stripQuotes ("=".intercalate rest).trimAscii.toString)
    | _ => pure ()
  return m

/-- Load a `.env` file from the working directory if present, so configuration can be placed
    there instead of exported into the shell. Real environment variables take precedence. -/
def loadDotenv (path : System.FilePath := ".env") : IO (Std.HashMap String String) := do
  if ← path.pathExists then return parseDotenv (← IO.FS.readFile path) else return {}

/-- Parse the contents of a `config.toml` file into key/value pairs. Keys are the same
    `ISSUES_...` names used as environment variables (just without needing to `export` them), e.g.
    `ISSUES_PORT = 8080`. Supports `#` comments and quoted/bare values; `[section]` headers are
    ignored (the config is flat, so sections aren't needed, but a stray one shouldn't break
    parsing). -/
private def parseToml (content : String) : Std.HashMap String String := Id.run do
  let mut m : Std.HashMap String String := {}
  for rawLine in content.splitOn "\n" do
    let line := rawLine.trimAscii.toString
    if line.isEmpty || line.startsWith "#" || line.startsWith "[" then continue
    match line.splitOn "=" with
    | key :: rest@(_ :: _) =>
      m := m.insert key.trimAscii.toString (stripQuotes ("=".intercalate rest).trimAscii.toString)
    | _ => pure ()
  return m

/-- Load `config.toml` from the working directory if present. Lowest-precedence configuration
    source: real environment variables win, then `.env`, then this file. -/
def loadConfigToml (path : System.FilePath := "config.toml") : IO (Std.HashMap String String) := do
  if ← path.pathExists then return parseToml (← IO.FS.readFile path) else return {}

/-- Read configuration from the environment, a `.env` file, and `config.toml` (in that
    precedence order), falling back to defaults. -/
def Config.fromEnv : IO Config := do
  let dotenv ← loadDotenv
  let toml ← loadConfigToml
  -- A blank value counts as unset, so `ISSUES_GOOGLE_CLIENT_ID=` disables Google OAuth rather
  -- than configuring it with an empty id. This also matters under Docker Compose, which always
  -- sets the variable in the container (to `""` when the host hasn't defined it).
  let nonEmpty (v : String) : Option String := if v.trimAscii.isEmpty then none else some v
  let getEnv (k : String) : IO (Option String) := do
    match (← IO.getEnv k).bind nonEmpty with
    | some v => pure (some v)
    | none => match dotenv[k]?.bind nonEmpty with
      | some v => pure (some v)
      | none => pure (toml[k]?.bind nonEmpty)
  let port := (← getEnv "ISSUES_PORT").bind (fun s => s.toNat?.map (·.toUInt16)) |>.getD 8080
  let host := (← getEnv "ISSUES_HOST").getD "127.0.0.1"
  let dbPath := (← getEnv "ISSUES_DB").getD "issues.sqlite"
  let frontendDir := (← getEnv "ISSUES_FRONTEND_DIR").getD "frontend/dist"
  let publicBaseUrl := (← getEnv "ISSUES_BASE_URL").getD s!"http://localhost:{port}"
  let checkIntervalSeconds := (← getEnv "ISSUES_CHECK_INTERVAL").bind (·.toNat?) |>.getD 0
  let repoDepsTtlSeconds := (← getEnv "ISSUES_REPO_DEPS_TTL").bind (·.toNat?) |>.getD 3600
  let adminEmails := ((← getEnv "ISSUES_ADMIN_EMAILS").getD "").splitOn ","
    |>.map (·.trimAscii.toString) |>.filter (!·.isEmpty)
  pure {
    port, host, dbPath := dbPath, frontendDir := frontendDir, publicBaseUrl, checkIntervalSeconds
    repoDepsTtlSeconds, adminEmails
    googleClientId := ← getEnv "ISSUES_GOOGLE_CLIENT_ID"
    googleClientSecret := ← getEnv "ISSUES_GOOGLE_CLIENT_SECRET"
    githubClientId := ← getEnv "ISSUES_GITHUB_CLIENT_ID"
    githubClientSecret := ← getEnv "ISSUES_GITHUB_CLIENT_SECRET"
    githubToken := ← getEnv "ISSUES_GITHUB_TOKEN"
    centralPassword := ← getEnv "ISSUES_CENTRAL_PASSWORD"
  }

end Taxis
