import Taxis.Plugins.Registry
import Taxis.Http.Client

/-!
# JSON endpoint check plugin

Built-in check kind `json-endpoint`: fetch a `.json` document from a configurable URL, navigate to
a value by a dot-path, and evaluate a configurable comparison against it. The outcome and the
actual value are reported in the check detail, which the frontend renders.

Config fields:
* `url` — the URL to `GET` (required); the response must be JSON.
* `path` — a dot-path into the response, e.g. `data.status` or `items.0.name` (empty ⇒ the root).
* `op` — one of `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `contains`, `exists`, `truthy`.
* `value` — the value to compare against (ignored by `exists`/`truthy`).
* `authValue` — an optional authentication credential sent as a request header, so the check can
  reach a protected endpoint (e.g. `Bearer <token>`).
* `authHeader` — the header name to send `authValue` under (defaults to `Authorization`).
-/

open Lean

namespace Taxis.Plugins

/-- Follow one path segment: an object key, or an array index when the current node is an array. -/
private def navigate (j : Json) (seg : String) : Option Json :=
  match j with
  | .obj _ => (j.getObjVal? seg).toOption
  | .arr a => seg.toNat?.bind (fun i => a[i]?)
  | _ => none

/-- Navigate a dot-path (e.g. `data.items.0.name`) into a JSON value. Empty path ⇒ the root. -/
private def getPath (j : Json) (path : String) : Option Json := Id.run do
  let path := path.trimAscii.toString
  if path.isEmpty then return some j
  let mut cur := j
  for seg in path.splitOn "." do
    match navigate cur seg with
    | some v => cur := v
    | none => return none
  return some cur

/-- Render a JSON scalar as a plain string: the raw contents of a string, else the compact form
    (`42`, `true`, `null`, …). -/
private def asStr (j : Json) : String :=
  (j.getStr?).toOption.getD j.compress

/-- Whether `needle` occurs in `hay` as a substring. -/
private def substr (hay needle : String) : Bool :=
  needle.isEmpty || (hay.splitOn needle).length > 1

/-- The set of operators whose result is a boolean pass/fail. `path` has already been resolved to
    `actual`; `expected` is the configured comparison value. -/
private def applyOp (op actual expected : String) : Except String Bool :=
  let cmp? : Option Ordering := do pure (compare (← actual.toInt?) (← expected.toInt?))
  match op with
  | "eq" => .ok (actual == expected)
  | "ne" => .ok (actual != expected)
  | "contains" => .ok (substr actual expected)
  | "exists" => .ok true
  | "truthy" => .ok (actual != "" && actual != "false" && actual != "0" && actual != "null")
  | "lt" | "le" | "gt" | "ge" =>
    match cmp? with
    | none => .error s!"'{op}' needs integer operands (got '{actual}' and '{expected}')"
    | some o => .ok (match op with
      | "lt" => o == .lt
      | "le" => o != .gt
      | "gt" => o == .gt
      | _    => o != .lt)
  | other => .error s!"unknown operator '{other}'"

private def validate (config : Json) : Except String Unit := do
  let _ ← config.getObjValAs? String "url"
  pure ()

/-- Evaluate the `json-endpoint` check. -/
def jsonEndpointEvaluate (config : Json) (_issue : Issue) (_artifacts : Array Artifact) :
    IO (CheckStatus × Option String) := do
  let get (f : String) := (config.getObjValAs? String f).toOption
  let some url := get "url" | return (.error, some "config missing 'url'")
  let path := (get "path").getD ""
  let op := ((get "op").getD "exists").trimAscii.toString
  let expected := (get "value").getD ""
  -- Optional authentication: send `authValue` under `authHeader` (default `Authorization`), so the
  -- check can reach a protected endpoint.
  let baseHeaders := #[("Accept", "application/json"), ("User-Agent", "issues-tracker")]
  let headers := match (get "authValue").map (·.trimAscii.toString) with
    | some v => if v.isEmpty then baseHeaders else
        let name := match (get "authHeader").map (·.trimAscii.toString) with
          | some h => if h.isEmpty then "Authorization" else h
          | none => "Authorization"
        baseHeaders.push (name, v)
    | none => baseHeaders
  match ← Http.requestJson "GET" url headers with
  | .error e => return (.error, some s!"fetch failed: {e}")
  | .ok j =>
    match getPath j path with
    | none =>
      let loc := if path.isEmpty then "root" else s!"path '{path}'"
      if op == "exists" then return (.failing, some s!"{loc} not present")
      else return (.error, some s!"{loc} not present in response")
    | some v =>
      let actual := asStr v
      match applyOp op actual expected with
      | .error e => return (.error, some e)
      | .ok true =>
        let cond := if op == "exists" || op == "truthy" then op else s!"{op} {expected}"
        return (.passing, some s!"{path} = {actual}  ({cond}) ✓")
      | .ok false =>
        let cond := if op == "exists" || op == "truthy" then op else s!"{op} {expected}"
        return (.failing, some s!"{path} = {actual}  (expected {cond})")

/-- Check: assert a condition on a value fetched from a JSON URL. -/
def jsonEndpointHandler : CheckHandler where
  kind := "json-endpoint"
  fields := #[
    { name := "url", label := "JSON URL", required := true,
      placeholder := some "https://example.com/status.json" },
    { name := "path", label := "Path", placeholder := some "data.status",
      help := some "Dot-path into the JSON, e.g. items.0.name (blank = whole document)" },
    { name := "op", label := "Operator", placeholder := some "eq",
      help := some "eq, ne, lt, le, gt, ge, contains, exists, truthy" },
    { name := "value", label := "Expected value", placeholder := some "ok",
      help := some "Compared against the value at the path (ignored by exists/truthy)" },
    { name := "authValue", label := "Auth credential", placeholder := some "Bearer <token>",
      help := some "Optional; sent as a request header so the check can reach a protected endpoint" },
    { name := "authHeader", label := "Auth header name", placeholder := some "Authorization",
      help := some "Header the credential is sent under (defaults to Authorization)" }]
  validateConfig := validate
  evaluate := jsonEndpointEvaluate

initialize registerCheckHandler jsonEndpointHandler

end Taxis.Plugins
