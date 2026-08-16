import Taxis.Toml
import Std.Data.HashMap

/-!
# Runtime configuration

Settings come from three places, each falling back to the next and finally to the field defaults:

1. environment variables (`ISSUES_PORT`, …),
2. a `.env` file in the working directory,
3. a TOML configuration file — `config.toml` in the working directory, or whatever `--config`
   names.

Environment variables stay on top because that is what a container passes, and because a
deployment that already sets them keeps working untouched. The TOML file is where a setting that
has structure belongs: file stores are an array of tables there (`[[filestores]]`) instead of a
JSON document squeezed into `ISSUES_FILESTORES`.

Anything the file gets wrong stops startup — a mistyped port that silently stayed 8080, or a
credential that silently stayed unset, costs far more to work out later than a refusal to boot.
Keys the server does not know are reported rather than fatal, since an unknown key is as often a
setting from a newer version as it is a typo.
-/

open Lean

namespace Taxis

/-- Runtime configuration. -/
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
  /-- Central login password; when set, password login is enabled. -/
  centralPassword : Option String := none
  /-- Enables `POST /api/auth/dev-login`. Development only. -/
  devLogin : Bool := false
  /-- Private mode: the whole instance needs a session, reads included. Off, only writes do.

      Named `privateMode` rather than `private` because the latter is a Lean keyword; the setting
      is spelled `auth.private`. -/
  privateMode : Bool := false
  /-- Groups whose members may read a private instance, by name. Empty means every authenticated
      actor may read. Resolved to ids at startup (`AppContext.create`), which also creates a group
      that does not exist yet — see `AppContext.readGroupIds`. Has no effect unless `privateMode`
      is set. -/
  readGroups : List String := []
  /-- File stores for `file` artifacts, as a JSON array — either the `ISSUES_FILESTORES` document
      or the `[[filestores]]` tables. It carries store credentials, so `main` consumes it
      (`Plugins.configureFileStores`) and blanks it before the config enters the request-serving
      context, and `Config.load` keeps it out of `currentConfig` entirely — do not read it after
      startup. -/
  fileStores : Option Json := none
  /-- Log every incoming request to stderr (enabled with `--verbose`). -/
  verbose : Bool := false
deriving Inhabited

/-- The configuration this process started with.

    Handlers read their configuration off `AppContext`, which is threaded through them. The GitHub
    plugins are not: `githubHeaders` and `fetchGithubIssues` are plain `IO`, reached from the check
    engine and the importer with no context in hand, so they read the token from here. They used
    to read `ISSUES_GITHUB_TOKEN` from the environment themselves, which stopped being the whole
    story once a token could also come from the configuration file. -/
initialize configRef : IO.Ref Config ← IO.mkRef {}

/-- The configuration this process started with. See `configRef`. -/
def currentConfig : IO Config := configRef.get

/-- Publish the configuration for the code that cannot be handed one. `Config.load` does this, and
    `main` does it again after the settings it owns (`--verbose`, blanking the file stores). -/
def setCurrentConfig (c : Config) : IO Unit := configRef.set c

/-! ### `.env` -/

private def stripQuotes (s : String) : String :=
  match s.toList with
  | q :: _ =>
    if (q == '"' || q == '\'') && s.length ≥ 2 && s.toList.getLast? == some q then
      String.ofList ((s.toList.drop 1).dropLast)
    else s
  | [] => s

/-- Drop a trailing ` # comment` from a `.env` value. Only a `#` that follows whitespace starts one,
    so a `#` inside a value (`hunter#2`) survives, and one inside quotes is left alone entirely.

    This used to be tolerated by accident rather than handled: a value that came out as
    `9391 # the port` failed to parse and silently fell back to its default. Now that a setting
    which does not parse stops startup, the comment has to actually come off. -/
private def stripComment (v : String) : String := Id.run do
  let quote := match v.toList with
    | q :: _ => if q == '"' || q == '\'' then some q else none
    | [] => none
  let mut out := ""
  let mut inQuote := quote.isSome
  let mut prev : Option Char := none
  for c in v.toList do
    if inQuote then
      out := out.push c
      -- The opening quote is `prev = none`, so it cannot close the string it opens.
      if some c == quote && prev.isSome then inQuote := false
    else if c == '#' && (prev == some ' ' || prev == some '\t') then
      break
    else
      out := out.push c
    prev := some c
  return out.trimAscii.toString

/-- Parse the contents of a `.env` file into key/value pairs. Supports `#` comments (whole-line and
    trailing), an optional `export ` prefix, and single/double-quoted values. -/
private def parseDotenv (content : String) : Std.HashMap String String := Id.run do
  let mut m : Std.HashMap String String := {}
  for rawLine in content.splitOn "\n" do
    let line := rawLine.trimAscii.toString
    if line.isEmpty || line.startsWith "#" then continue
    let line := if line.startsWith "export " then (line.drop 7).toString else line
    match line.splitOn "=" with
    | key :: rest@(_ :: _) =>
      let value := stripComment ("=".intercalate rest).trimAscii.toString
      m := m.insert key.trimAscii.toString (stripQuotes value)
    | _ => pure ()
  return m

/-- Load a `.env` file from the working directory if present, so configuration can be placed
    there instead of exported into the shell. Real environment variables take precedence. -/
def loadDotenv (path : System.FilePath := ".env") : IO (Std.HashMap String String) := do
  if ← path.pathExists then return parseDotenv (← IO.FS.readFile path) else return {}

/-! ### Reading a setting -/

/-- The value at a dotted path of the configuration file. -/
private def tomlAt? (j : Json) : List String → Option Json
  | [] => some j
  | k :: ks => (j.getObjVal? k).toOption.bind (tomlAt? · ks)

private def dotted (path : List String) : String := ".".intercalate path

/-- The places a setting is looked for, in precedence order. -/
private structure Sources where
  dotenv : Std.HashMap String String
  toml : Json
  /-- What to call the configuration file in error messages. -/
  tomlName : String

/-- A blank value counts as unset, so `ISSUES_GOOGLE_CLIENT_ID=` disables Google OAuth rather than
    configuring it with an empty id. This also matters under Docker Compose, which always sets the
    variable in the container (to `""` when the host hasn't defined it). -/
private def nonEmpty (v : String) : Option String := if v.trimAscii.isEmpty then none else some v

private def Sources.envValue (s : Sources) (key : String) : IO (Option String) := do
  match (← IO.getEnv key).bind nonEmpty with
  | some v => return some v
  | none => return s.dotenv[key]?.bind nonEmpty

/-- `got` is a description rather than the value itself, because the value is not always worth
    printing back: a TOML float renders through `Json.compress` as the integer it is not, so
    `port = 8080.0` would be refused with the baffling "must be a whole number, but is 8080". -/
private def Sources.bad (s : Sources) (path : List String) (want got : String) : IO α :=
  throw <| IO.userError s!"{s.tomlName}: '{dotted path}' must be {want}, but is {got}"

private def Sources.str (s : Sources) (env : String) (path : List String) : IO (Option String) := do
  if let some v ← s.envValue env then return some v
  match tomlAt? s.toml path with
  | none => return none
  | some (.str v) => return nonEmpty v
  | some v => s.bad path "a string" v.compress

private def Sources.nat (s : Sources) (env : String) (path : List String) : IO (Option Nat) := do
  if let some v ← s.envValue env then
    -- Trimmed, like every other reader: a `.env` line is whatever was left of `KEY=` after its
    -- comment was stripped, and refusing to start over a stray space would be absurd.
    match v.trimAscii.toString.toNat? with
    | some n => return some n
    | none => throw <| IO.userError s!"{env}: must be a whole number, but is '{v}'"
  match tomlAt? s.toml path with
  | none => return none
  | some v => match v.getNat? with
    | .ok n => return some n
    | .error _ =>
      s.bad path "a whole number" <| match v with
        | .num ⟨_, exponent⟩ => if exponent > 0 then "a decimal" else v.compress
        | _ => v.compress

private def Sources.bool (s : Sources) (env : String) (path : List String) : IO (Option Bool) := do
  if let some v ← s.envValue env then
    -- An environment variable is only ever a string, and the documented spelling of "on" is
    -- `ISSUES_DEV_LOGIN=1` — anything set at all means on, bar the handful of ways people write
    -- off, which would otherwise read as a very confusing yes.
    return some !(["0", "false", "no", "off"].contains v.trimAscii.toString.toLower)
  match tomlAt? s.toml path with
  | none => return none
  | some (.bool b) => return some b
  | some v => s.bad path "true or false" v.compress

private def Sources.strings (s : Sources) (env : String) (path : List String) :
    IO (Option (List String)) := do
  -- Blanks are dropped and entries trimmed, whichever notation they arrive in. `[""]` is what a
  -- template with an unfilled variable leaves behind, and an empty admin email is not inert: it
  -- would match an actor created with an empty email and make it an administrator.
  let clean (vs : List String) : List String :=
    vs.map (·.trimAscii.toString) |>.filter (!·.isEmpty)
  let split (v : String) : List String := clean (v.splitOn ",")
  if let some v ← s.envValue env then return some (split v)
  match tomlAt? s.toml path with
  | none => return none
  | some (.arr xs) => return some (clean (← xs.toList.mapM fun
      | .str v => pure v
      | v => s.bad path "an array of strings" v.compress))
  -- A comma-separated string is what the environment variable holds; accepting it here too means
  -- one less thing to rewrite when a `.env` moves into the configuration file.
  | some (.str v) => return some (split v)
  | some v => s.bad path "an array of strings" v.compress

/-- The file stores: a JSON array from the environment, an array of `[[filestores]]` tables from
    the configuration file. Either way what comes out is a JSON array, which is what the file-store
    backends take. -/
private def Sources.fileStores (s : Sources) : IO (Option Json) := do
  match ← s.envValue "ISSUES_FILESTORES" with
  | some raw =>
    match Json.parse raw with
    | .ok (.arr xs) => return some (.arr xs)
    | .ok v => throw <| IO.userError s!"ISSUES_FILESTORES: must be a JSON array, but is {v.compress}"
    | .error e => throw <| IO.userError s!"ISSUES_FILESTORES: is not valid JSON: {e}"
  | none =>
    match tomlAt? s.toml ["filestores"] with
    | none => return none
    | some (.arr xs) => return some (.arr xs)
    | some v => s.bad ["filestores"] "a list of [[filestores]] tables" v.compress

/-! ### Loading -/

/-- Every setting the configuration file understands, as a dotted path. -/
private def knownKeys : List (List String) :=
  [["port"], ["host"], ["db"], ["frontendDir"], ["baseUrl"], ["verbose"],
   ["checkInterval"], ["repoDepsTtl"], ["filestores"],
   ["auth", "password"], ["auth", "adminEmails"], ["auth", "devLogin"],
   ["auth", "private"], ["auth", "readGroups"],
   ["auth", "google", "clientId"], ["auth", "google", "clientSecret"],
   ["auth", "github", "clientId"], ["auth", "github", "clientSecret"],
   ["github", "token"]]

/-- Keys of the configuration file that are not settings. A mistyped key is otherwise
    indistinguishable from one that was never written, and only shows up much later as a feature
    that is mysteriously not configured. -/
private partial def unknownKeys (j : Json) (path : List String := []) : Array String :=
  match j with
  | .obj fields => fields.foldl (init := #[]) fun acc k v =>
      let p := path ++ [k]
      if knownKeys.contains p then acc
      else match v with
        | .obj _ => acc ++ unknownKeys v p
        | _ => acc.push (dotted p)
  | _ => #[]

/-- The outcome of reading the configuration: what to run with, where it was read from, and what
    startup should complain about. -/
structure Config.Loaded where
  config : Config
  /-- The configuration file that was read, if there was one. -/
  path : Option System.FilePath
  /-- Settings the file mentions that the server does not understand. -/
  unknown : Array String

/-- Read the configuration. `configPath` is a file the operator named (`--config`, `ISSUES_CONFIG`)
    and so has to exist; without one, `config.toml` is read if it happens to be there. -/
def Config.load (configPath : Option System.FilePath := none)
    (dotenvPath : System.FilePath := ".env") : IO Config.Loaded := do
  let dotenv ← loadDotenv dotenvPath
  let tomlPath := configPath.getD "config.toml"
  let read ← tomlPath.pathExists
  let toml ←
    if read then
      match ← Toml.load tomlPath with
      | .ok j => pure j
      | .error e => throw <| IO.userError e
    else if configPath.isSome then
      throw <| IO.userError s!"{tomlPath}: no such configuration file"
    else pure (Json.mkObj [])
  let s : Sources := { dotenv, toml, tomlName := tomlPath.toString }
  let port ← match ← s.nat "ISSUES_PORT" ["port"] with
    | none => pure (8080 : UInt16)
    | some n =>
      if n == 0 || n > 65535 then
        throw <| IO.userError s!"port must be between 1 and 65535, but is {n}"
      else pure n.toUInt16
  let config : Config := {
    port
    host := (← s.str "ISSUES_HOST" ["host"]).getD "127.0.0.1"
    dbPath := (← s.str "ISSUES_DB" ["db"]).getD "issues.sqlite"
    frontendDir := (← s.str "ISSUES_FRONTEND_DIR" ["frontendDir"]).getD "frontend/dist"
    publicBaseUrl := (← s.str "ISSUES_BASE_URL" ["baseUrl"]).getD s!"http://localhost:{port}"
    googleClientId := ← s.str "ISSUES_GOOGLE_CLIENT_ID" ["auth", "google", "clientId"]
    googleClientSecret := ← s.str "ISSUES_GOOGLE_CLIENT_SECRET" ["auth", "google", "clientSecret"]
    githubClientId := ← s.str "ISSUES_GITHUB_CLIENT_ID" ["auth", "github", "clientId"]
    githubClientSecret := ← s.str "ISSUES_GITHUB_CLIENT_SECRET" ["auth", "github", "clientSecret"]
    githubToken := ← s.str "ISSUES_GITHUB_TOKEN" ["github", "token"]
    checkIntervalSeconds := (← s.nat "ISSUES_CHECK_INTERVAL" ["checkInterval"]).getD 0
    repoDepsTtlSeconds := (← s.nat "ISSUES_REPO_DEPS_TTL" ["repoDepsTtl"]).getD 3600
    adminEmails := (← s.strings "ISSUES_ADMIN_EMAILS" ["auth", "adminEmails"]).getD []
    centralPassword := ← s.str "ISSUES_CENTRAL_PASSWORD" ["auth", "password"]
    devLogin := (← s.bool "ISSUES_DEV_LOGIN" ["auth", "devLogin"]).getD false
    privateMode := (← s.bool "ISSUES_PRIVATE" ["auth", "private"]).getD false
    readGroups := (← s.strings "ISSUES_READ_GROUPS" ["auth", "readGroups"]).getD []
    fileStores := ← s.fileStores
    verbose := (← s.bool "ISSUES_VERBOSE" ["verbose"]).getD false }
  -- A private instance nobody can sign in to is not a locked tracker, it is a broken one: every
  -- route answers 401 and no route can ever change that. Refused here rather than discovered from
  -- the outside, in keeping with the rest of this file — a setting that cannot work stops startup.
  if config.privateMode && config.googleClientId.isNone && config.githubClientId.isNone
      && config.centralPassword.isNone && !config.devLogin then
    throw <| IO.userError
      "auth.private is set but no sign-in method is configured — set auth.password, \
       auth.google.clientId/clientSecret, or auth.github.clientId/clientSecret, or nobody \
       (including you) will be able to reach this instance"
  -- Published without the file stores, so the guarantee their field documents — that no second
  -- plaintext copy of the credentials outlives startup — holds for every caller rather than
  -- depending on `main` remembering to republish a blanked config.
  setCurrentConfig { config with fileStores := none }
  return { config, path := if read then some tomlPath else none, unknown := unknownKeys toml }

end Taxis
