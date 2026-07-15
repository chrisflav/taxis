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
  /-- Personal-access token used for GitHub API calls by import/check plugins. -/
  githubToken : Option String := none
  /-- Interval in seconds for the background check sweeper; `0` disables it. -/
  checkIntervalSeconds : Nat := 0
  /-- Emails that are automatically granted admin on login (bootstrap). -/
  adminEmails : List String := []
  /-- Central login password; when set, password login is enabled (`ISSUES_CENTRAL_PASSWORD`). -/
  centralPassword : Option String := none
  /-- Log every incoming request to stderr (enabled with `--verbose`). -/
  verbose : Bool := false
deriving Inhabited

/-- Shared, thread-safe application context. -/
structure AppContext where
  db : Std.Mutex Db.Conn
  config : Config

namespace AppContext

/-- Run a database action while holding the connection mutex. -/
def withDb (ctx : AppContext) (act : Db.Conn → IO α) : IO α :=
  ctx.db.atomically do
    let conn ← get
    act conn

/-- Build a context: open and migrate the database, then wrap it in a mutex. -/
def create (config : Config) : IO AppContext := do
  let conn ← Db.connect config.dbPath
  Db.migrate conn
  let db ← Std.Mutex.new conn
  pure { db, config }

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

/-- Read configuration from the environment (and a `.env` file), falling back to defaults. -/
def Config.fromEnv : IO Config := do
  let dotenv ← loadDotenv
  let getEnv (k : String) : IO (Option String) := do
    match ← IO.getEnv k with
    | some v => pure (some v)
    | none => pure (dotenv[k]?)
  let port := (← getEnv "ISSUES_PORT").bind (fun s => s.toNat?.map (·.toUInt16)) |>.getD 8080
  let host := (← getEnv "ISSUES_HOST").getD "127.0.0.1"
  let dbPath := (← getEnv "ISSUES_DB").getD "issues.sqlite"
  let frontendDir := (← getEnv "ISSUES_FRONTEND_DIR").getD "frontend/dist"
  let publicBaseUrl := (← getEnv "ISSUES_BASE_URL").getD s!"http://localhost:{port}"
  let checkIntervalSeconds := (← getEnv "ISSUES_CHECK_INTERVAL").bind (·.toNat?) |>.getD 0
  let adminEmails := ((← getEnv "ISSUES_ADMIN_EMAILS").getD "").splitOn ","
    |>.map (·.trimAscii.toString) |>.filter (!·.isEmpty)
  pure {
    port, host, dbPath := dbPath, frontendDir := frontendDir, publicBaseUrl, checkIntervalSeconds, adminEmails
    googleClientId := ← getEnv "ISSUES_GOOGLE_CLIENT_ID"
    googleClientSecret := ← getEnv "ISSUES_GOOGLE_CLIENT_SECRET"
    githubToken := ← getEnv "ISSUES_GITHUB_TOKEN"
    centralPassword := ← getEnv "ISSUES_CENTRAL_PASSWORD"
  }

end Taxis
