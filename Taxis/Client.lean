import Taxis.Http.Client
import Taxis.Domain

/-!
# API client

A thin, typed HTTP client for taxis's own REST API, for external programs that manage their work
through a running taxis instance instead of embedding the tracker (e.g. an agent that replaces a
hand-rolled issue store with a taxis backend). Built on `Taxis.Http.requestJson` and the same
domain types (`Taxis.Issue`, `Taxis.Label`, ...) the server itself serialises, so there is exactly
one JSON codec per entity, shared by both sides of the wire — a caller has no domain types of its
own to keep in sync with a schema change here.

Every wrapper function returns `IO (Except String α)`, surfacing HTTP/parse errors instead of
throwing, consistent with `Taxis.Http.requestJson`.
-/

open Lean (Json ToJson FromJson toJson)
open Taxis.Http (requestJson)

namespace Taxis.Client

/-- Base URL + bearer token for a taxis instance. -/
structure Config where
  url : String
  token : Option String := none
deriving Repr, Inhabited

instance : FromJson Config where
  fromJson? j := do
    let url ← j.getObjValAs? String "url"
    let token := j.getObjValAs? String "token" |>.toOption
    return { url, token }

/-! ## Transport -/

private def apiHeaders (cfg : Config) : Array (String × String) :=
  let base := #[("Content-Type", "application/json")]
  match cfg.token with
  | some t => base.push ("Authorization", s!"Bearer {t}")
  | none => base

private def apiUrl (cfg : Config) (path : String) : String := s!"{cfg.url}/api{path}"

private def hexDigit (n : Nat) : Char :=
  if n < 10 then Char.ofNat (n + '0'.toNat) else Char.ofNat (n - 10 + 'A'.toNat)

private def byteToPercent (b : UInt8) : String :=
  String.ofList ['%', hexDigit (b.toNat / 16), hexDigit (b.toNat % 16)]

/-- Minimal percent-encoding for query parameter values (issue titles/search terms may contain
    spaces, `&`, `#`, etc.). Leaves alphanumerics and a handful of safe punctuation characters
    untouched. -/
private def urlEncode (s : String) : String :=
  String.join (s.toList.map fun c =>
    if c.isAlphanum || c == '-' || c == '_' || c == '.' || c == '~' then String.singleton c
    else String.join (c.toString.toUTF8.toList.map byteToPercent))

private def buildQuery (params : Array (String × String)) : String :=
  if params.isEmpty then ""
  else "?" ++ "&".intercalate (params.map (fun (k, v) => s!"{k}={urlEncode v}")).toList

private def get (cfg : Config) (path : String) (params : Array (String × String) := #[]) :
    IO (Except String Json) :=
  requestJson "GET" (apiUrl cfg path ++ buildQuery params) (apiHeaders cfg)

private def send (cfg : Config) (method : String) (path : String) (body : Json) :
    IO (Except String Json) :=
  requestJson method (apiUrl cfg path) (apiHeaders cfg) (some body.compress)

private def sendNoBody (cfg : Config) (method : String) (path : String) :
    IO (Except String Json) :=
  requestJson method (apiUrl cfg path) (apiHeaders cfg)

private def decode [FromJson α] (j : Json) : Except String α := FromJson.fromJson? j

/-! ## Issues -/

/-- `GET /issues`, optionally filtered. -/
def listIssues (cfg : Config) (state : Option IssueState := none) (label : Option LabelId := none)
    (q : Option String := none) (limit : Option Nat := none) (offset : Option Nat := none) :
    IO (Except String (Array Issue)) := do
  let mut params : Array (String × String) := #[]
  if let some s := state then params := params.push ("state", s.toString)
  if let some l := label then params := params.push ("label", toString l.val)
  if let some q := q then params := params.push ("q", q)
  if let some n := limit then params := params.push ("limit", toString n)
  if let some n := offset then params := params.push ("offset", toString n)
  match ← get cfg "/issues" params with
  | .error e => return .error e
  | .ok j => return decode j

/-- `POST /issues`. -/
def createIssue (cfg : Config) (input : IssueInput) : IO (Except String Issue) := do
  match ← send cfg "POST" "/issues" (toJson input) with
  | .error e => return .error e
  | .ok j => return decode j

/-- `GET /issues/:id`: the issue plus its assigned actors, labels, attached artifacts/checks,
    comments, activity events, and review requests. -/
def getIssueDetail (cfg : Config) (id : IssueId) : IO (Except String IssueDetail) := do
  match ← get cfg s!"/issues/{id.val}" with
  | .error e => return .error e
  | .ok j => return decode j

/-- `GET /issues/:id`, the base `Issue` only (drops the detail fields `getIssueDetail` also
    fetches). Prefer `getIssueDetail` if you need more than the bare issue — it's the same one
    HTTP call either way. -/
def getIssue (cfg : Config) (id : IssueId) : IO (Except String Issue) := do
  match ← getIssueDetail cfg id with
  | .error e => return .error e
  | .ok d => return .ok d.issue

/-- Request body for `PATCH /issues/:id`, built by hand so that only the keys actually set are
    included — an absent field is left unchanged server-side (`jsonFieldOpt?`/`jsonFieldTri?`'s
    contract in `Taxis.Json`). `IssueUpdate`'s derived `ToJson` always emits every field (`null`
    for `none`), which would clear `parent`/`deadline` instead of leaving them untouched, so it is
    not used here. -/
private def issueUpdateBody (u : IssueUpdate) : Json :=
  let opt (k : String) (v? : Option Json) : List (String × Json) := (v?.map fun v => [(k, v)]).getD []
  let tri (k : String) (v?? : Option (Option Json)) : List (String × Json) :=
    match v?? with
    | none => []
    | some none => [(k, .null)]
    | some (some v) => [(k, v)]
  Json.mkObj <|
    opt "title" (u.title.map Json.str) ++
    opt "description" (u.description.map Json.str) ++
    opt "goal" (u.goal.map Json.str) ++
    opt "state" (u.state.map toJson) ++
    opt "locked" (u.locked.map Json.bool) ++
    opt "labels" (u.labels.map toJson) ++
    tri "parent" (u.parent.map (·.map toJson)) ++
    opt "dependencies" (u.dependencies.map toJson) ++
    opt "assignees" (u.assignees.map toJson) ++
    opt "visibility" (u.visibility.map toJson) ++
    tri "deadline" (u.deadline.map (·.map toJson))

/-- `PATCH /issues/:id`. -/
def updateIssue (cfg : Config) (id : IssueId) (upd : IssueUpdate) : IO (Except String Issue) := do
  match ← send cfg "PATCH" s!"/issues/{id.val}" (issueUpdateBody upd) with
  | .error e => return .error e
  | .ok j => return decode j

/-- `DELETE /issues/:id`. -/
def deleteIssue (cfg : Config) (id : IssueId) : IO (Except String Unit) := do
  match ← sendNoBody cfg "DELETE" s!"/issues/{id.val}" with
  | .error e => return .error e
  | .ok _ => return .ok ()

/-! ## Artifacts -/

/-- `POST /issues/:id/artifacts`. -/
def createArtifact (cfg : Config) (id : IssueId) (kind : String) (payload : Json) :
    IO (Except String ArtifactView) := do
  let body := Json.mkObj [("kind", Json.str kind), ("payload", payload)]
  match ← send cfg "POST" s!"/issues/{id.val}/artifacts" body with
  | .error e => return .error e
  | .ok j => return decode j

/-- `DELETE /artifacts/:id`. -/
def deleteArtifact (cfg : Config) (id : ArtifactId) : IO (Except String Unit) := do
  match ← sendNoBody cfg "DELETE" s!"/artifacts/{id.val}" with
  | .error e => return .error e
  | .ok _ => return .ok ()

/-! ## Comments -/

/-- `GET /issues/:id/comments`. -/
def listComments (cfg : Config) (id : IssueId) : IO (Except String (Array Comment)) := do
  match ← get cfg s!"/issues/{id.val}/comments" with
  | .error e => return .error e
  | .ok j => return decode j

/-- `POST /issues/:id/comments`.

    Setting `review` makes the comment a review carrying that verdict, the same as the web UI's
    approve / request-changes. The field is omitted entirely when `none`, so a plain comment
    posts exactly the body it did before. An approving review may have an empty body — the server
    takes the approval as the message — but any other comment must say something. -/
def createComment (cfg : Config) (id : IssueId) (body : String)
    (review : Option ReviewState := none) : IO (Except String Comment) := do
  let fields := [("body", Json.str body)]
    ++ (review.map fun r => [("review", toJson r)] : Option _).getD []
  match ← send cfg "POST" s!"/issues/{id.val}/comments" (Json.mkObj fields) with
  | .error e => return .error e
  | .ok j => return decode j

/-! ## Labels -/

/-- `GET /labels`. -/
def listLabels (cfg : Config) : IO (Except String (Array Label)) := do
  match ← get cfg "/labels" with
  | .error e => return .error e
  | .ok j => return decode j

/-- `POST /labels`. -/
def createLabel (cfg : Config) (name : String) : IO (Except String Label) := do
  match ← send cfg "POST" "/labels" (Json.mkObj [("name", Json.str name)]) with
  | .error e => return .error e
  | .ok j => return decode j

/-- Look up a label by name, creating it if it doesn't exist yet. Idempotent, safe to call on
    every use — handy for status labels a caller manages by convention. -/
def ensureLabel (cfg : Config) (name : String) : IO (Except String LabelId) := do
  match ← listLabels cfg with
  | .error e => return .error e
  | .ok labels =>
    match labels.find? (·.name == name) with
    | some l => return .ok l.id
    | none =>
      match ← createLabel cfg name with
      | .error e => return .error e
      | .ok l => return .ok l.id

/-! ## Actors -/

/-- `GET /actors`. -/
def listActors (cfg : Config) : IO (Except String (Array Actor)) := do
  match ← get cfg "/actors" with
  | .error e => return .error e
  | .ok j => return decode j

/-- `GET /me`. -/
def getMe (cfg : Config) : IO (Except String Actor) := do
  match ← get cfg "/me" with
  | .error e => return .error e
  | .ok j => return decode j

/-! ## Display helpers -/

/-- Format a `Timestamp` as an ISO-8601 UTC string, for CLI display. -/
def epochToIso8601 (t : Timestamp) : IO String := do
  let child ← IO.Process.spawn {
    cmd := "date"
    args := #["-u", "-d", s!"@{t.epochSeconds}", "+%Y-%m-%dT%H:%M:%SZ"]
    stdout := .piped
    stderr := .null
    stdin := .null
  }
  let out ← child.stdout.readToEnd
  let _ ← child.wait
  return out.trimAscii.toString

end Taxis.Client
