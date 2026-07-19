import Taxis
open Std.Async Taxis Taxis.Server

def main (args : List String) : IO Unit := do
  let verbose := args.contains "--verbose" || args.contains "-v"
  let config := { ← Config.fromEnv with verbose }
  let ctx ← AppContext.create config
  IO.println s!"[taxis] listening on http://{config.host}:{config.port} (db: {config.dbPath})"
  IO.println s!"[taxis] google oauth: {if config.googleClientId.isSome then "configured" else "NOT configured (set ISSUES_GOOGLE_CLIENT_ID/SECRET)"}"
  IO.println s!"[taxis] github oauth: {if config.githubClientId.isSome then "configured" else "NOT configured (set ISSUES_GITHUB_CLIENT_ID/SECRET)"}"
  IO.println s!"[taxis] base url: {config.publicBaseUrl}  (google redirect: {config.publicBaseUrl}/auth/google/callback, github redirect: {config.publicBaseUrl}/auth/github/callback)"
  if config.centralPassword.isSome then
    IO.println "[taxis] password login: enabled (ISSUES_CENTRAL_PASSWORD)"
  if config.verbose then
    IO.println "[taxis] verbose request logging enabled"
  (← IO.getStdout).flush
  Async.block do
    let server ← serve ctx
    server.waitShutdown
