import Std.Http
import Taxis.Json
import Taxis.Compress

/-!
# API responses and errors

Small helpers to turn domain data / errors into JSON HTTP responses, plus the `ApiM` monad
handlers run in. Every response carries permissive CORS headers so the separately-served
frontend (or a dev server) can call the API.
-/

open Std.Http Std.Async Lean

namespace Taxis.Server

/-- A successful API result: an HTTP status, JSON body, and extra response headers
    (used for redirects and `Set-Cookie`). -/
structure ApiResponse where
  status : Status := .ok
  body : Json := Json.mkObj []
  headers : Array (String × String) := #[]
deriving Inhabited

/-- A client- or server-side error, mapped to an HTTP status. -/
inductive ApiError where
  | badRequest (msg : String)
  | unauthorized (msg : String)
  | forbidden (msg : String)
  | notFound (msg : String)
  | unprocessable (msg : String)
  | server (msg : String)

def ApiError.status : ApiError → Status
  | .badRequest _ => .badRequest
  | .unauthorized _ => .unauthorized
  | .forbidden _ => .forbidden
  | .notFound _ => .notFound
  | .unprocessable _ => .unprocessableEntity
  | .server _ => .internalServerError

def ApiError.message : ApiError → String
  | .badRequest m | .unauthorized m | .forbidden m | .notFound m | .unprocessable m | .server m => m

def ApiError.toResponse (e : ApiError) : ApiResponse :=
  { status := e.status, body := Json.mkObj [("error", e.message)] }

/-- The monad API handlers run in: `IO` with a typed error channel. -/
abbrev ApiM := ExceptT ApiError IO

/-- Raise a typed API error. -/
def fail (e : ApiError) : ApiM α := throwThe ApiError e

/-- Lift an `IO` action into `ApiM` (explicit lift avoids `ExceptT`-over-`IO` unification). -/
def liftIO (act : IO α) : ApiM α := ExceptT.lift act

/-- Succeed with `200 OK`. -/
def ok (j : Json) : ApiM ApiResponse := pure { status := .ok, body := j }

/-- Succeed with `201 Created`. -/
def created (j : Json) : ApiM ApiResponse := pure { status := .created, body := j }

/-- Issue a `302` redirect to `location`, optionally attaching a `Set-Cookie`. -/
def redirect (location : String) (setCookie : Option String := none) : ApiM ApiResponse :=
  let headers := #[("Location", location)] ++ (setCookie.map (fun c => #[("Set-Cookie", c)]) |>.getD #[])
  pure { status := .found, body := Json.mkObj [], headers }

/-- Decode a request body as raw JSON, for handlers that read a couple of optional fields out of it
    rather than a fixed input structure. -/
def parseJsonBody (body : String) : ApiM Json := do
  match Json.parse body with
  | .error e => fail (.badRequest s!"invalid JSON: {e}")
  | .ok j => pure j

/-- Decode a request body as JSON of type `α`. -/
def parseBody (α) [FromJson α] (body : String) : ApiM α := do
  match Json.parse body with
  | .error e => fail (.badRequest s!"invalid JSON: {e}")
  | .ok j => match fromJson? j with
    | .error e => fail (.badRequest s!"invalid request body: {e}")
    | .ok v => pure v

/-- The permissive CORS headers every API response carries. -/
private def withCors (b : Response.Builder) : Response.Builder :=
  b |>.header! "Access-Control-Allow-Origin" "*"
    |>.header! "Access-Control-Allow-Headers" "Content-Type, Authorization"
    |>.header! "Access-Control-Allow-Methods" "GET, POST, PATCH, DELETE, OPTIONS"

/-- Build the wire response from an already-serialised body, adding CORS headers and any
    response-specific headers. Taking the payload as an argument lets a caller that already
    needed it (to derive an `ETag`) avoid serialising the JSON twice.

    Compressed when the client accepts gzip and the body is big enough to be worth it — see
    `gzipIfWorthwhile`, which decides both. `Vary: Accept-Encoding` goes on the response either
    way, so a shared cache never hands a gzipped body to a client that did not ask for one. -/
def buildResponseWith (r : ApiResponse) (payload : String) (acceptsGzip : Bool := false) :
    Async (Response Body.Full) :=
  let base := withCors (Response.withStatus r.status) |>.header! "Vary" "Accept-Encoding"
  let builder := r.headers.foldl (fun b (k, v) => b.header! k v) base
  match gzipIfWorthwhile payload acceptsGzip with
  | some compressed =>
    (builder.header! "Content-Type" "application/json"
      |>.header! "Content-Encoding" "gzip").fromBytes compressed
  | none => builder.json payload

/-- Build the wire response, adding CORS headers and any response-specific headers. -/
def buildResponse (r : ApiResponse) : Async (Response Body.Full) :=
  buildResponseWith r r.body.compress

/-- A strong `ETag` over a response body. A hash of the exact bytes is all a revalidation token
    needs to be, and it stays stable across restarts because it depends on nothing else. -/
def etagOf (payload : String) : String :=
  "\"" ++ toString payload.hash ++ "\""

/-- A bodyless `304 Not Modified`, echoing the validator the client already holds. -/
def notModifiedResponse (tag : String) : Async (Response Body.Full) :=
  (withCors (Response.withStatus .notModified)
    |>.header! "ETag" tag
    |>.header! "Cache-Control" "no-cache").fromBytes ByteArray.empty

end Taxis.Server
