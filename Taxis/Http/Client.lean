import Taxis.Json

/-!
# HTTP client

A small outbound HTTP client used by check and import plugins, implemented by shelling out to
`curl`. This keeps the tracker dependency-free on the client side (the in-core `Std.Http` is a
server) while remaining perfectly adequate for the low-volume API calls plugins make.
-/

open Lean

namespace Taxis.Http

/-- An HTTP response: numeric status and raw body. -/
structure Response where
  status : Nat
  body : String
deriving Repr

/-- Perform an HTTP request via `curl`. Headers are `(name, value)` pairs. -/
def request (method : String) (url : String)
    (headers : Array (String × String) := #[]) (body : Option String := none) :
    IO (Except String Response) := do
  let mut args := #["-s", "-S", "-L", "-X", method, "-w", "\n%{http_code}"]
  for (k, v) in headers do
    args := args ++ #["-H", s!"{k}: {v}"]
  match body with
  | some b => args := args ++ #["--data-binary", b]
  | none => pure ()
  args := args.push url
  let out ← IO.Process.output { cmd := "curl", args }
  if out.exitCode != 0 then
    return .error s!"curl exited {out.exitCode}: {out.stderr}"
  -- The body is followed by a final line containing the HTTP status code.
  let parts := out.stdout.splitOn "\n"
  match parts.getLast? with
  | none => return .error "malformed curl output"
  | some statusStr =>
    let bodyStr := "\n".intercalate parts.dropLast
    match statusStr.trimAscii.toString.toNat? with
    | some status => return .ok { status, body := bodyStr }
    | none => return .error s!"could not parse status: {statusStr}"

/-- Perform a request and parse the body as JSON, requiring a 2xx status. -/
def requestJson (method : String) (url : String)
    (headers : Array (String × String) := #[]) (body : Option String := none) :
    IO (Except String Json) := do
  match ← request method url headers body with
  | .error e => return .error e
  | .ok resp =>
    if resp.status < 200 || resp.status >= 300 then
      return .error s!"HTTP {resp.status}: {resp.body}"
    match Json.parse resp.body with
    | .error e => return .error s!"invalid JSON response: {e}"
    | .ok j => return .ok j

end Taxis.Http
