import Taxis
open Std.Async Taxis Taxis.Server

/-- The path given by `--config <path>`, or an error if the flag is there without one. -/
private def configArg (args : List String) : Except String (Option System.FilePath) :=
  match args.dropWhile (· != "--config") with
  | [] => .ok none
  | [_] => .error "--config needs a path"
  | _ :: path :: _ => .ok (some path)

def main (args : List String) : IO Unit := do
  let configPath ← match configArg args with
    | .error e => do IO.eprintln s!"[taxis] {e}"; IO.Process.exit 1
    | .ok (some p) => pure (some p)
    | .ok none => pure ((← IO.getEnv "ISSUES_CONFIG").map System.FilePath.mk)
  -- A configuration mistake is an operator's typo, not a crash: report it as one line and stop.
  let loaded ← try Config.load configPath catch e => do
    IO.eprintln s!"[taxis] configuration error: {e}"
    IO.Process.exit 1
  let source := loaded.path.map (·.toString) |>.getD "the configuration file"
  -- Not fatal: an unknown key is as often a setting from a newer version as it is a typo. It is
  -- still the only warning anyone gets before wondering why a setting had no effect.
  for key in loaded.unknown do
    IO.eprintln s!"[taxis] {source}: '{key}' is not a setting"
  let config := { loaded.config with
    verbose := loaded.config.verbose || args.contains "--verbose" || args.contains "-v" }
  -- Consumed here, then dropped: the file-store configuration carries store credentials, and
  -- after the stores are built (closures in the plugin registry) nothing else needs it — so the
  -- context that serves requests never holds a second plaintext copy.
  if let some storesConfig := config.fileStores then
    for err in ← Taxis.Plugins.configureFileStores storesConfig do
      IO.eprintln s!"[taxis] file store error: {err}"
    let stores ← Taxis.Plugins.allFileStores
    IO.println s!"[taxis] file stores: {if stores.isEmpty then "none configured" else ", ".intercalate (stores.toList.map (fun s => s!"{s.name} ({s.kind})"))}"
  let config := { config with fileStores := none }
  -- Republished after the settings `main` owns, so that the code reading `currentConfig` sees the
  -- same configuration the request handlers do.
  setCurrentConfig config
  let ctx ← AppContext.create config
  IO.println s!"[taxis] listening on http://{config.host}:{config.port} (db: {config.dbPath})"
  IO.println s!"[taxis] configuration: {loaded.path.map (·.toString) |>.getD "environment only (no configuration file)"}"
  IO.println s!"[taxis] google oauth: {if config.googleClientId.isSome then "configured" else "NOT configured (set auth.google.clientId/clientSecret)"}"
  IO.println s!"[taxis] github oauth: {if config.githubClientId.isSome then "configured" else "NOT configured (set auth.github.clientId/clientSecret)"}"
  IO.println s!"[taxis] base url: {config.publicBaseUrl}  (google redirect: {config.publicBaseUrl}/auth/google/callback, github redirect: {config.publicBaseUrl}/auth/github/callback)"
  if config.centralPassword.isSome then
    IO.println "[taxis] password login: enabled"
  if config.devLogin then
    IO.println "[taxis] development login: ENABLED — do not run this in production"
  if config.verbose then
    IO.println "[taxis] verbose request logging enabled"
  (← IO.getStdout).flush
  Async.block do
    let server ← serve ctx
    server.waitShutdown
