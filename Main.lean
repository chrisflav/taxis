import Taxis
open Std.Async Taxis Taxis.Server

def main : IO Unit := do
  let config ← Config.fromEnv
  let ctx ← AppContext.create config
  IO.println s!"[taxis] listening on http://localhost:{config.port} (db: {config.dbPath})"
  IO.println s!"[taxis] google oauth: {if config.googleClientId.isSome then "configured" else "NOT configured (set ISSUES_GOOGLE_CLIENT_ID/SECRET)"}"
  IO.println s!"[taxis] base url: {config.publicBaseUrl}  (google redirect: {config.publicBaseUrl}/auth/google/callback)"
  (← IO.getStdout).flush
  Async.block do
    let server ← serve ctx
    server.waitShutdown
