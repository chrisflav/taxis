import Taxis.Server.Context
import Taxis.Server.Response

/-!
# Request routing

A parsed request (`Req`) plus `dispatch`, which matches on method and decoded path segments.
Concrete resource handlers are added in later phases; this module owns the routing table.
-/

open Std.Http Lean

namespace Taxis.Server

/-- A parsed request handed to route handlers. -/
structure Req where
  method : Method
  /-- Decoded, non-empty path segments, e.g. `["issues", "3"]`. -/
  segments : List String
  /-- Query-parameter lookup. -/
  query : String → Option String
  /-- Raw request body. -/
  body : String
  /-- Case-insensitive request-header lookup. -/
  header : String → Option String := fun _ => none
  /-- The authenticated actor, if the request carried a valid session. -/
  actor : Option Actor := none

/-- Name of the session cookie. -/
def sessionCookieName : String := "issues_session"

namespace Req

/-- Parse a path segment as an entity id. -/
def parseId (s : String) : ApiM Int64 :=
  match s.toInt? with
  | some n => pure (Int64.ofInt n)
  | none => throw (.badRequest s!"invalid id: {s}")

/-- Look up a cookie value from the `Cookie` header. -/
def cookie (req : Req) (name : String) : Option String := do
  let raw ← req.header "cookie"
  for pair in raw.splitOn ";" do
    let pair := pair.trimAscii.toString
    match pair.splitOn "=" with
    | [k, v] => if k.trimAscii.toString == name then return v.trimAscii.toString
    | _ => pure ()
  none

/-- The session token carried by the request, if any. -/
def sessionToken (req : Req) : Option String :=
  req.cookie sessionCookieName

end Req

end Taxis.Server

/-- Run a database action, lifted into `ApiM`. Explicit lift avoids the `ExceptT`-over-`IO`
    unification that would otherwise hide the coercion. -/
def Taxis.AppContext.dbM (ctx : Taxis.AppContext) (act : Taxis.Db.Conn → IO α) :
    Taxis.Server.ApiM α :=
  ExceptT.lift (ctx.withDb act)

/-- Run a **read-only** database action, lifted into `ApiM`. See `AppContext.withRead`: this runs
    on a connection opened read-only, so it must not be given anything that writes. -/
def Taxis.AppContext.readM (ctx : Taxis.AppContext) (act : Taxis.Db.Conn → IO α) :
    Taxis.Server.ApiM α :=
  ExceptT.lift (ctx.withRead act)
