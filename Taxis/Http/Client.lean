import Taxis.Json

/-!
# HTTP client

A small outbound HTTP client used by check and import plugins and by the `taxis` command-line
client, implemented by shelling out to `curl`. This keeps the tracker dependency-free on the client
side (the in-core `Std.Http` is a server) while remaining perfectly adequate for the low-volume API
calls plugins make.

Everything about the request — method, URL, headers and body — is handed to `curl` as a config
file on its standard input (`curl -K -`), not as arguments. Arguments are readable by every user
on the machine through `/proc/<pid>/cmdline`, and two of the things a request carries are a bearer
token and a body of arbitrary size, neither of which belongs there (the second also runs into the
kernel's argument-length limit).

Because the transport is `curl`, the standard proxy environment applies unchanged: `HTTPS_PROXY`,
`HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY` (and their lower-case spellings). A custom CA bundle is
taken from `CURL_CA_BUNDLE` or, failing that, `SSL_CERT_FILE` and passed explicitly, so it applies
whichever TLS backend this `curl` was built against — which is what a TLS-intercepting proxy in
front of the server needs.
-/

open Lean

namespace Taxis.Http

/-- An HTTP response: numeric status and raw body. -/
structure Response where
  status : Nat
  body : String
deriving Repr

/-- Quote a string for a curl config file: double quotes, with backslash escapes for the
    characters curl's config parser interprets (`\\`, `\"`, and the control characters `\n`, `\r`,
    `\t`, `\v`). Everything else, including multi-byte UTF-8, passes through untouched. -/
def curlQuote (s : String) : String := Id.run do
  let mut out := "\""
  for c in s.toList do
    out := match c with
      | '\\' => out ++ "\\\\"
      | '"' => out ++ "\\\""
      | '\n' => out ++ "\\n"
      | '\r' => out ++ "\\r"
      | '\t' => out ++ "\\t"
      | '\x0b' => out ++ "\\v"
      | c => out.push c
  return out.push '"'

/-- The curl config (`curl -K -`) for one request. Pure, so what goes on the wire is testable
    without a network: one `option = "value"` per line.

    `data-raw` rather than `data-binary`: it is the one data option that never reads a value
    starting with `@` as a file name to upload. -/
def curlConfig (method : String) (url : String) (headers : Array (String × String) := #[])
    (body : Option String := none) (caBundle : Option String := none) : String :=
  let lines : Array String := #[
    "silent", "show-error", "location",
    s!"request = {curlQuote method}",
    s!"write-out = {curlQuote "\n%{http_code}"}"]
  let lines := lines ++ headers.map fun (k, v) => s!"header = {curlQuote s!"{k}: {v}"}"
  let lines := match body with
    | some b => lines.push s!"data-raw = {curlQuote b}"
    | none => lines
  let lines := match caBundle with
    | some ca => lines.push s!"cacert = {curlQuote ca}"
    | none => lines
  let lines := lines.push s!"url = {curlQuote url}"
  "\n".intercalate lines.toList ++ "\n"

/-- The CA bundle named by the environment: `CURL_CA_BUNDLE`, else `SSL_CERT_FILE`. Empty values
    count as unset. -/
def caBundleFromEnv : IO (Option String) := do
  let nonEmpty (v : Option String) := v.filter (!·.isEmpty)
  return nonEmpty (← IO.getEnv "CURL_CA_BUNDLE") <|> nonEmpty (← IO.getEnv "SSL_CERT_FILE")

/-- Write `s` to a child's stdin and close it, which is what tells `curl -K -` the config has
    ended. A function of its own so the handle is released (and the pipe closed) when it returns. -/
private def feed (h : IO.FS.Handle) (s : String) : IO Unit := do
  h.putStr s
  h.flush

/-- Perform an HTTP request via `curl`. Headers are `(name, value)` pairs. -/
def request (method : String) (url : String)
    (headers : Array (String × String) := #[]) (body : Option String := none) :
    IO (Except String Response) := do
  let config := curlConfig method url headers body (← caBundleFromEnv)
  let child ← try
      IO.Process.spawn { cmd := "curl", args := #["-K", "-"],
                         stdin := .piped, stdout := .piped, stderr := .piped }
    catch e => return .error s!"could not run curl: {e}"
  let (stdin, child) ← child.takeStdin
  feed stdin config
  let stderrTask ← IO.asTask child.stderr.readToEnd Task.Priority.dedicated
  let stdout ← child.stdout.readToEnd
  let stderr ← match ← IO.wait stderrTask with
    | .ok s => pure s
    | .error _ => pure ""
  let exitCode ← child.wait
  if exitCode != 0 then
    return .error s!"curl exited {exitCode}: {stderr.trimAscii}"
  -- The body is followed by a final line containing the HTTP status code.
  let parts := stdout.splitOn "\n"
  match parts.getLast? with
  | none => return .error "malformed curl output"
  | some statusStr =>
    let bodyStr := "\n".intercalate parts.dropLast
    match statusStr.trimAscii.toString.toNat? with
    | some status => return .ok { status, body := bodyStr }
    | none => return .error s!"could not parse status: {statusStr}"

/-- The message to show for a failed response: the server's own `{"error": "..."}` when the body
    is one (every taxis error is), and otherwise the body as it came. -/
def errorMessage (body : String) : String :=
  match Json.parse body with
  | .ok j => match j.getObjValAs? String "error" with
    | .ok msg => msg
    | .error _ => body.trimAscii.toString
  | .error _ => body.trimAscii.toString

/-- Perform a request and parse the body as JSON, requiring a 2xx status. A non-2xx answer is
    reported as `HTTP <status>: <message>`. -/
def requestJson (method : String) (url : String)
    (headers : Array (String × String) := #[]) (body : Option String := none) :
    IO (Except String Json) := do
  match ← request method url headers body with
  | .error e => return .error e
  | .ok resp =>
    if resp.status < 200 || resp.status >= 300 then
      return .error s!"HTTP {resp.status}: {errorMessage resp.body}"
    match Json.parse resp.body with
    | .error e => return .error s!"invalid JSON response: {e}"
    | .ok j => return .ok j

end Taxis.Http
