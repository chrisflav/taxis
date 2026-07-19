import Taxis.Server.Handlers

/-!
# HTTP server

Wires the router into `Std.Http`'s async HTTP/1.1 server. The handler reads the body, runs the
API in `IO`, maps database validation failures (raised as tagged `IO.Error`s) to `422`, and any
other exception to `500`, so a handler bug never takes the connection down silently.
-/

open Std.Http Std.Http.Server Std.Async Std.Net Lean

namespace Taxis.Server

/-- The `Std.Http` handler value: just the shared application context. -/
structure AppHandler where
  ctx : AppContext

/-- Run the API pipeline in `IO`, converting both error channels to an `ApiResponse`.
    Resolves the authenticated actor from the session cookie before dispatching. -/
def runApi (ctx : AppContext) (req : Req) : IO ApiResponse := do
  try
    let req ← resolveActor ctx req
    match ← (dispatch ctx req).run with
    | .ok r => pure r
    | .error e => pure e.toResponse
  catch ioErr =>
    match Db.validationMessage? ioErr with
    | some m => pure (ApiError.unprocessable m).toResponse
    | none => pure (ApiError.server (toString ioErr)).toResponse

/-- Build a `Req` from an incoming HTTP request, the API path segments (with the `api`
    prefix already stripped), and the already-read body. -/
def toReq (r : Request Body.Stream) (segments : List String) (body : String) : Req :=
  { method := r.line.method
    segments := segments
    query := fun k => r.line.uri.query.get k
    body := body
    header := fun name => (Header.Name.ofString? name).bind (r.line.headers.get? ·) |>.map toString }

/-- Guess a `Content-Type` from a file name. -/
def contentTypeOf (name : String) : String :=
  if name.endsWith ".html" then "text/html; charset=utf-8"
  else if name.endsWith ".js" || name.endsWith ".mjs" then "text/javascript; charset=utf-8"
  else if name.endsWith ".css" then "text/css; charset=utf-8"
  else if name.endsWith ".json" then "application/json"
  else if name.endsWith ".svg" then "image/svg+xml"
  else if name.endsWith ".png" then "image/png"
  else if name.endsWith ".ico" then "image/x-icon"
  else if name.endsWith ".woff2" then "font/woff2"
  else "application/octet-stream"

/-- Serve a static file from the configured frontend directory, falling back to `index.html`
    for client-side routes (SPA). Rejects path-traversal attempts. -/
def serveStatic (ctx : AppContext) (segs : List String) : Async (Response Body.Full) := do
  if segs.any (fun s => s == "..") then
    return ← Response.notFound.text "not found"
  let rel := if segs.isEmpty then "index.html" else "/".intercalate segs
  let serveFile (p : System.FilePath) (ct : String) : Async (Response Body.Full) := do
    let content ← (IO.FS.readBinFile p : IO ByteArray)
    (Response.ok |>.header! "Content-Type" ct).fromBytes content
  let path := ctx.config.frontendDir / rel
  if (← (path.pathExists : IO Bool)) && !(← (path.isDir : IO Bool)) then
    serveFile path (contentTypeOf rel)
  else
    let index := ctx.config.frontendDir / "index.html"
    if ← (index.pathExists : IO Bool) then
      serveFile index "text/html; charset=utf-8"
    else
      Response.notFound.text s!"frontend not built (expected assets in {ctx.config.frontendDir})"

instance : Handler AppHandler where
  ResponseBody := Body.Full
  onRequest h req := do
    if h.ctx.config.verbose then
      let path := "/" ++ "/".intercalate (req.line.uri.path.toDecodedSegments.filter (· ≠ "")).toList
      IO.eprintln s!"[taxis] {req.line.method} {path}"
    if req.line.method == .options then
      return ← buildResponse { status := .noContent, body := Json.mkObj [] }
    let segs := (req.line.uri.path.toDecodedSegments.filter (· ≠ "")).toList
    -- Dispatch to the API for `/api/*`, and also for the browser-facing OAuth routes at the top
    -- level (`/auth/...`, which Google/GitHub redirect to per the registered redirect URI) and
    -- the MCP endpoint (`/mcp`, kept top-level so it's a short, memorable URL for MCP clients).
    let apiSegs? : Option (List String) := match segs with
      | "api" :: rest => some rest
      | "auth" :: _ => some segs
      | "mcp" :: _ => some segs
      | _ => none
    match apiSegs? with
    | some apiSegs =>
      let body ← req.body.readAll (maximumSize := some (8 * 1024 * 1024 : UInt64))
      let apiResp ← (runApi h.ctx (toReq req apiSegs body) : IO ApiResponse)
      buildResponse apiResp
    | none =>
      match segs with
      | ["docs"] => Response.ok.html OpenApi.docsHtml
      | _ => serveStatic h.ctx segs
  onFailure _ err := do
    IO.eprintln s!"[issues] connection error: {err}"

/-- Background loop that re-evaluates every check on a fixed interval. -/
partial def sweeperLoop (ctx : AppContext) : Async Unit := do
  let ms : Std.Time.Millisecond.Offset := ⟨Int.ofNat (ctx.config.checkIntervalSeconds * 1000)⟩
  Std.Async.sleep ms
  let n ← (ctx.withDb Checks.sweep : IO Nat)
  IO.eprintln s!"[issues] check sweep evaluated {n} check(s)"
  sweeperLoop ctx

/-- Start the HTTP server bound to the configured port on localhost, plus the check sweeper
    if `checkIntervalSeconds > 0`. -/
def serve (ctx : AppContext) : Async Server := do
  let ipv4 := IPv4Addr.ofString ctx.config.host |>.getD (IPv4Addr.ofParts 127 0 0 1)
  let addr : SocketAddress := .v4 { addr := ipv4, port := ctx.config.port }
  -- Raise the per-request header limits well above the library defaults (maxHeaders := 50).
  -- Behind an HTTP/2-terminating reverse proxy, the browser's single `Cookie` header can be
  -- split into one `Cookie:` line per cookie when downgraded to HTTP/1.1 for the backend
  -- (RFC 9113 §8.2.3), so a client holding many cookies can send well over 50 header fields
  -- and trip `tooManyHeaders`.
  let httpConfig : Std.Http.Config := { maxHeaders := 256, maxHeaderBytes := 256 * 1024 }
  let server ← Std.Http.Server.serve addr (AppHandler.mk ctx) httpConfig
  if ctx.config.checkIntervalSeconds > 0 then
    background (sweeperLoop ctx)
  return server

end Taxis.Server
