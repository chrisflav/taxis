import Taxis.Plugins.Registry
import Taxis.Sigv4
import Std.Time

/-!
# S3 file-store backend

File-store backend `s3`: any S3-compatible object store — a self-hosted Garage or SeaweedFS, an
actual AWS bucket, Ceph RGW — reached through SigV4 presigned URLs (`Taxis.Sigv4`), so the
tracker never proxies file bytes: downloads and uploads go straight between the browser and the
bucket, authorised by a signature minted here from credentials that never leave the server.

Store configuration (one entry of `ISSUES_FILESTORES`):
* `endpoint` — base URL of the S3 API, e.g. `https://garage.example.com` (required).
* `region` — signing region (required; Garage calls this its `s3_region`, e.g. `"garage"`).
* `bucket` — bucket name (required).
* `accessKey`, `secretKey` — credentials (required).
* `pathStyle` — address objects as `endpoint/bucket/key` rather than `bucket.endpoint/key`.
  Defaults to `true`, which is what self-hosted stores usually want.
* `prefix` — optional key prefix confining everything this tracker touches, e.g. `"taxis/"`.
* `urlTtlSeconds` — how long minted download links stay valid (default 3600). Signing times are
  rounded for cacheability, so a link may outlive this by up to one rounding window — an hour at
  most, never more than the TTL itself (see `S3Config.downloadUrl`).
-/

open Lean

namespace Taxis.Plugins

/-- The parsed configuration of one `s3` store. -/
structure S3Config where
  scheme : String
  host : String
  region : String
  bucket : String
  accessKey : String
  secretKey : String
  pathStyle : Bool
  keyPrefix : String
  urlTtlSeconds : Nat
deriving Inhabited

/-- `YYYYMMDDTHHMMSSZ` and `YYYYMMDD` for an epoch second. The calendar arithmetic is
    `Std.Time`'s; only the digit assembly is ours. Pure so the test suite can pin known instants. -/
def amzTimestamp (epochSeconds : Int) : String × String :=
  let pad2 (n : Int) : String := if n < 10 then s!"0{n}" else toString n
  let days := epochSeconds.fdiv 86400
  let secs := epochSeconds - days * 86400
  let d := Std.Time.PlainDate.ofEpochDay (Std.Time.Day.Offset.ofInt days)
  let date := s!"{d.year.toInt}{pad2 d.month.val}{pad2 d.day.val}"
  (s!"{date}T{pad2 (secs.fdiv 3600)}{pad2 ((secs.fdiv 60) % 60)}{pad2 (secs % 60)}Z", date)

/-- Split an endpoint URL into scheme and host (with any port kept). -/
def parseEndpoint (url : String) : Except String (String × String) := do
  let (scheme, rest) :=
    if url.startsWith "https://" then ("https", (url.drop 8).toString)
    else if url.startsWith "http://" then ("http", (url.drop 7).toString)
    else ("", url)
  if scheme.isEmpty then throw s!"endpoint must start with http:// or https:// (got '{url}')"
  let host := (rest.splitOn "/").headD ""
  if host.isEmpty then throw s!"endpoint has no host: '{url}'"
  return (scheme, host)

/-- The host requests are addressed to and the URI path of `key`, per addressing style. -/
def S3Config.hostAndPath (c : S3Config) (key : String) : String × String :=
  if c.pathStyle then (c.host, s!"/{c.bucket}/{key}")
  else (s!"{c.bucket}.{c.host}", s!"/{key}")

/-- A presigned request for `key`, valid `expires` seconds from `amzDate`/`dateStamp`. -/
def S3Config.presign (c : S3Config) (method key : String) (expires : Nat)
    (amzDate dateStamp : String) (headers : Array (String × String) := #[]) : String :=
  let (host, path) := c.hostAndPath key
  let req : Sigv4.Request := {
    method, host, path
    accessKey := c.accessKey, secretKey := c.secretKey, region := c.region
    amzDate, dateStamp, expiresSeconds := expires
    headers := #[("host", host)] ++ headers }
  req.url c.scheme

def S3Config.parse (j : Json) : Except String S3Config := do
  let str (f : String) : Except String String :=
    match j.getObjValAs? String f with
    | .ok v => if v.isEmpty then throw s!"'{f}' must not be empty" else pure v
    | .error _ => throw s!"missing required field '{f}'"
  -- An optional field that is *present* must still parse: `"pathStyle": "false"` silently
  -- becoming the default `true` is a misconfiguration that would only surface as failing
  -- requests, with nothing at startup pointing at the config.
  let opt (α) [FromJson α] (f : String) (dflt : α) : Except String α :=
    match j.getObjVal? f with
    | .error _ => pure dflt
    | .ok v => match fromJson? v with
      | .ok x => pure x
      | .error _ => throw s!"'{f}' has the wrong type: {v.compress}"
  let (scheme, host) ← parseEndpoint (← str "endpoint")
  return {
    scheme, host
    region := ← str "region"
    bucket := ← str "bucket"
    accessKey := ← str "accessKey"
    secretKey := ← str "secretKey"
    pathStyle := ← opt Bool "pathStyle" true
    keyPrefix := ← opt String "prefix" ""
    urlTtlSeconds := ← opt Nat "urlTtlSeconds" 3600 }

/-- AWS rejects a presigned URL whose `X-Amz-Expires` exceeds a week; self-hosted stores accept
    more, but signing something AWS refuses would make every link dead on a real bucket. -/
def maxExpirySeconds : Nat := 604800

/-- Download links are signed at the start of a rounding window rather than at the moment of the
    request, and live one window past the configured TTL to compensate — so a link is valid for
    between `urlTtlSeconds` and `urlTtlSeconds` plus the window. The window is an hour, shrunk to
    the TTL itself for short TTLs so a tight limit stays tight. Rounding keeps the minted URL —
    which is embedded in issue-detail responses — byte-stable within the window, so those
    responses still revalidate to a `304` (see the ETag handling in `Serve`); a per-request
    timestamp would make every response unique and defeat that cache entirely. -/
def S3Config.downloadUrl (c : S3Config) (key : String) : IO String := do
  let window : Int := min 3600 (max 60 c.urlTtlSeconds)
  let now := (← Std.Time.Timestamp.now).toSecondsSinceUnixEpoch.toInt
  let (amzDate, dateStamp) := amzTimestamp (now - now % window)
  let expires := min (c.urlTtlSeconds + window.toNat) maxExpirySeconds
  return c.presign "GET" (c.keyPrefix ++ key) expires amzDate dateStamp

/-- Upload links are short-lived and single-purpose: 15 minutes, bound to the exact
    `Content-Type` the client declared, signed at the moment of the request. -/
def S3Config.uploadUrl (c : S3Config) (key contentType : String) :
    IO (String × Array (String × String)) := do
  let now := (← Std.Time.Timestamp.now).toSecondsSinceUnixEpoch.toInt
  let (amzDate, dateStamp) := amzTimestamp now
  let url := c.presign "PUT" (c.keyPrefix ++ key) 900 amzDate dateStamp
    (headers := #[("content-type", contentType)])
  return (url, #[("Content-Type", contentType)])

def s3Backend : FileStoreBackend where
  kind := "s3"
  make name j := do
    let c ← S3Config.parse j
    -- Callers degrade on `.error` (a "link unavailable" label, a clean API error); an exception
    -- escaping instead would turn one bad artifact into a failed issue view for every reader.
    return {
      name, kind := "s3"
      downloadUrl := fun key => do
        try pure (.ok (← c.downloadUrl key)) catch e => pure (.error (toString e))
      uploadUrl := fun key contentType => do
        try pure (.ok (← c.uploadUrl key contentType)) catch e => pure (.error (toString e)) }

initialize registerFileStoreBackend s3Backend

end Taxis.Plugins
