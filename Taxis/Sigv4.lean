import Taxis.Crypto

/-!
# AWS Signature Version 4 presigned URLs

Query-string presigning (`X-Amz-*` parameters) for the S3 API, used by the `FileStore` S3 backend
to hand clients time-limited GET/PUT URLs without proxying any bytes. Only what presigning needs
is implemented: the canonical request, the string to sign, and the derived signing key, per
"Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".

Everything here is pure — the caller supplies the timestamp — so the test suite can check the
exact signatures of the worked example in the S3 documentation.
-/

namespace Taxis.Sigv4

/-- Percent-encode per AWS's URI-encoding rules: unreserved characters (`A–Z a–z 0–9 - . _ ~`)
    stay, everything else becomes `%XX` per UTF-8 byte. `keepSlash` is used for object paths,
    where `/` separates segments and must survive. -/
def uriEncode (s : String) (keepSlash : Bool := false) : String := Id.run do
  let hex := "0123456789ABCDEF".toList.toArray
  let mut out := ""
  for b in s.toUTF8 do
    let c := Char.ofNat b.toNat
    if c.isAlphanum || c == '-' || c == '.' || c == '_' || c == '~' || (keepSlash && c == '/') then
      out := out.push c
    else
      out := out ++ "%" |>.push hex[b.toNat >>> 4]! |>.push hex[b.toNat &&& 0xf]!
  return out

/-- A presigning request: everything the signature is computed over. `headers` are the headers the
    client will send and the signature covers (at minimum `host`); names must be lowercase. -/
structure Request where
  method : String
  host : String
  /-- URI path, starting with `/`, *not* yet percent-encoded. -/
  path : String
  accessKey : String
  secretKey : String
  region : String
  /-- `YYYYMMDDTHHMMSSZ`. -/
  amzDate : String
  /-- `YYYYMMDD` — the date portion of `amzDate`. -/
  dateStamp : String
  expiresSeconds : Nat
  headers : Array (String × String) := #[]

/-- The scope a signature is valid in: date, region, service, terminator. -/
def Request.credentialScope (r : Request) : String :=
  s!"{r.dateStamp}/{r.region}/s3/aws4_request"

/-- Signed headers, sorted and joined with `;` as both the query parameter and the canonical
    request want them. -/
def Request.signedHeaders (r : Request) : String :=
  ";".intercalate ((r.headers.map (·.1) |>.qsort (· < ·)).toList)

/-- The `X-Amz-*` query parameters other than the signature itself, in canonical (sorted) order.
    They are part of the canonical request, and — unchanged — of the final URL. -/
def Request.canonicalQuery (r : Request) : String :=
  let params := #[
    ("X-Amz-Algorithm", "AWS4-HMAC-SHA256"),
    ("X-Amz-Credential", s!"{r.accessKey}/{r.credentialScope}"),
    ("X-Amz-Date", r.amzDate),
    ("X-Amz-Expires", toString r.expiresSeconds),
    ("X-Amz-SignedHeaders", r.signedHeaders)]
  let encoded := params.map fun (k, v) => s!"{uriEncode k}={uriEncode v}"
  "&".intercalate (encoded.qsort (· < ·)).toList

/-- A header value as the canonical request wants it (the spec's `Trimall`): outer whitespace
    stripped, runs of inner whitespace collapsed to one space. The store's verifier applies the
    same rule to what actually arrives, so signing anything else guarantees a mismatch. -/
def trimall (v : String) : String := Id.run do
  let mut out := ""
  let mut pendingSpace := false
  for c in v.toList do
    if c == ' ' || c == '\t' || c == '\n' || c == '\r' then
      pendingSpace := !out.isEmpty
    else
      if pendingSpace then out := out.push ' '
      out := out.push c
      pendingSpace := false
  return out

/-- The canonical request. The payload hash is `UNSIGNED-PAYLOAD`, as presigned S3 URLs use: the
    body cannot be known at signing time. -/
def Request.canonicalRequest (r : Request) : String :=
  let sorted := r.headers.qsort (·.1 < ·.1)
  let canonicalHeaders := String.join (sorted.map (fun (k, v) => s!"{k}:{trimall v}\n")).toList
  "\n".intercalate [r.method, uriEncode r.path (keepSlash := true), r.canonicalQuery,
    canonicalHeaders, r.signedHeaders, "UNSIGNED-PAYLOAD"]

/-- The signature: HMAC chain through date → region → service → `aws4_request`, then over the
    string to sign. -/
def Request.signature (r : Request) : String :=
  let stringToSign := "\n".intercalate ["AWS4-HMAC-SHA256", r.amzDate, r.credentialScope,
    Crypto.sha256Hex r.canonicalRequest]
  let key := Crypto.hmac ("AWS4" ++ r.secretKey).toUTF8 r.dateStamp
  let key := Crypto.hmac key r.region
  let key := Crypto.hmac key "s3"
  let key := Crypto.hmac key "aws4_request"
  Crypto.hmacHex key stringToSign

/-- The full presigned URL. -/
def Request.url (r : Request) (scheme : String := "https") : String :=
  s!"{scheme}://{r.host}{uriEncode r.path (keepSlash := true)}?{r.canonicalQuery}&X-Amz-Signature={r.signature}"

end Taxis.Sigv4
