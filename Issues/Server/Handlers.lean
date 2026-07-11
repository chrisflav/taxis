import Issues.Basic
import Issues.Server.Router
import Issues.Server.Auth
import Issues.Server.OpenApi
import Issues.Db
import Issues.Plugins
import Issues.Crypto
import Issues.Checks.Engine
import Issues.Import

/-!
# Resource handlers and the routing table

One handler per REST operation plus `dispatch`, which maps `(method, path)` to a handler.
Handlers run in `ApiM` (`IO` + typed error channel); database access goes through
`AppContext.withDb`, which serialises access under the connection mutex.
-/

open Std.Http Lean

namespace Issues.Server

/-! ## Actors -/

def listActorsH (ctx : AppContext) : ApiM ApiResponse := do
  ok (toJson (← ctx.dbM Db.listActors))

def createActorH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let input ← parseBody ActorInput req.body
  created (toJson (← ctx.dbM (Db.createActor · input)))

def getActorH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  match ← ctx.dbM (Db.getActor · ⟨id⟩) with
  | some a => ok (toJson a)
  | none => fail (.notFound s!"actor {id} not found")

def updateActorH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  let upd ← parseBody ActorUpdate req.body
  match ← ctx.dbM (Db.updateActor · ⟨id⟩ upd) with
  | some a => ok (toJson a)
  | none => fail (.notFound s!"actor {id} not found")

def deleteActorH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  if ← ctx.dbM (Db.deleteActor · ⟨id⟩) then
    ok (Json.mkObj [("deleted", true)])
  else fail (.notFound s!"actor {id} not found")

/-! ## Groups -/

def listGroupsH (ctx : AppContext) : ApiM ApiResponse := do
  ok (toJson (← ctx.dbM Db.listGroups))

def createGroupH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let input ← parseBody GroupInput req.body
  created (toJson (← ctx.dbM (Db.createGroup · input)))

def getGroupH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  match ← ctx.dbM (Db.getGroup · ⟨id⟩) with
  | some g => ok (toJson g)
  | none => fail (.notFound s!"group {id} not found")

def updateGroupH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  let upd ← parseBody GroupUpdate req.body
  match ← ctx.dbM (Db.updateGroup · ⟨id⟩ upd) with
  | some g => ok (toJson g)
  | none => fail (.notFound s!"group {id} not found")

def deleteGroupH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  if ← ctx.dbM (Db.deleteGroup · ⟨id⟩) then
    ok (Json.mkObj [("deleted", true)])
  else fail (.notFound s!"group {id} not found")

/-! ## Labels -/

def listLabelsH (ctx : AppContext) : ApiM ApiResponse := do
  ok (toJson (← ctx.dbM Db.listLabels))

def createLabelH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let input ← parseBody LabelInput req.body
  created (toJson (← ctx.dbM (Db.createLabel · input)))

def getLabelH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  match ← ctx.dbM (Db.getLabel · ⟨id⟩) with
  | some l => ok (toJson l)
  | none => fail (.notFound s!"label {id} not found")

def updateLabelH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  let upd ← parseBody LabelUpdate req.body
  match ← ctx.dbM (Db.updateLabel · ⟨id⟩ upd) with
  | some l => ok (toJson l)
  | none => fail (.notFound s!"label {id} not found")

def deleteLabelH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  if ← ctx.dbM (Db.deleteLabel · ⟨id⟩) then
    ok (Json.mkObj [("deleted", true)])
  else fail (.notFound s!"label {id} not found")

/-! ## Issues -/

/-- Visibility filter: an issue is visible if it is public (no visibility groups) or the actor
    shares one of its groups. No inheritance from parents in this version. -/
def visibleTo (actor : Option Actor) (issue : Issue) : Bool :=
  issue.visibility.isEmpty ||
    (match actor with
     | none => false
     | some a => issue.visibility.any (fun g => a.groups.contains g))

def listIssuesH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let state := (req.query "state").bind IssueState.ofString?
  let labelId := (req.query "label").bind (·.toInt?) |>.map (fun n => (⟨Int64.ofInt n⟩ : LabelId))
  let q := req.query "q"
  let assignee := (req.query "assignee").bind (·.toInt?) |>.map (fun n => (⟨Int64.ofInt n⟩ : ActorId))
  let limit := (req.query "limit").bind (·.toNat?)
  let offset := (req.query "offset").bind (·.toNat?) |>.getD 0
  let issues ← ctx.dbM (fun db => Db.listIssues db state labelId q assignee limit offset)
  ok (toJson (issues.filter (visibleTo req.actor)))

/-- A non-admin actor may only restrict visibility to groups they belong to. -/
private def ensureVisibilityAllowed (actor : Actor) (vis : Array GroupId) : ApiM Unit := do
  unless actor.admin do
    for g in vis do
      unless actor.groups.contains g do
        fail (.forbidden "you can only restrict visibility to groups you belong to")

def createIssueH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let input ← parseBody IssueInput req.body
  if let some actor := req.actor then ensureVisibilityAllowed actor input.visibility
  created (toJson (← ctx.dbM (Db.createIssue · input)))

/-- Enrich an artifact with its plugin-defined display (label + optional link). -/
def toArtifactView (a : Artifact) : IO ArtifactView := do
  let display ← match ← Plugins.artifactHandler? a.kind with
    | some h => pure (h.render a.payload)
    | none => pure { label := a.payload.compress }
  pure { id := a.id, kind := a.kind, payload := a.payload, display }

/-- Assemble the expanded detail view of an issue. -/
private def loadDetail (db : Db.Conn) (id : IssueId) : IO (Option IssueDetail) := do
  match ← Db.getIssue db id with
  | none => pure none
  | some issue =>
    let assignedActors ← issue.assignees.filterMapM (Db.getActor db ·)
    let issueLabels ← issue.labels.filterMapM (Db.getLabel db ·)
    let attachedArtifacts ← (← Db.issueArtifacts db id).mapM toArtifactView
    let attachedChecks ← Db.issueChecks db id
    let comments ← Db.issueComments db id
    let events ← Db.issueEvents db id
    pure (some { issue, assignedActors, issueLabels, attachedArtifacts, attachedChecks, comments, events })

def getIssueH (ctx : AppContext) (id : Int64) (actor : Option Actor) : ApiM ApiResponse := do
  match ← ctx.dbM (loadDetail · ⟨id⟩) with
  | some d =>
    -- Hide non-visible issues as if they did not exist.
    if visibleTo actor d.issue then ok (toJson d)
    else fail (.notFound s!"issue {id} not found")
  | none => fail (.notFound s!"issue {id} not found")

def updateIssueH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  let upd ← parseBody IssueUpdate req.body
  match req.actor, upd.visibility with
  | some actor, some vis => ensureVisibilityAllowed actor vis
  | _, _ => pure ()
  match ← ctx.dbM (Db.updateIssue · ⟨id⟩ upd (req.actor.map (·.id))) with
  | some i => ok (toJson i)
  | none => fail (.notFound s!"issue {id} not found")

def deleteIssueH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  if ← ctx.dbM (Db.deleteIssue · ⟨id⟩) then
    ok (Json.mkObj [("deleted", true)])
  else fail (.notFound s!"issue {id} not found")

/-- The recorded history (audit trail) of an issue, oldest first. Only returned for a visible
    issue, so hidden issues do not leak their activity. -/
def listEventsH (ctx : AppContext) (id : Int64) (actor : Option Actor) : ApiM ApiResponse := do
  match ← ctx.dbM (fun db => do pure (← Db.getIssue db ⟨id⟩, ← Db.issueEvents db ⟨id⟩)) with
  | (some issue, events) =>
    if visibleTo actor issue then ok (toJson events)
    else fail (.notFound s!"issue {id} not found")
  | (none, _) => fail (.notFound s!"issue {id} not found")

/-! ## Artifacts -/

def createArtifactH (ctx : AppContext) (issueId : Int64) (req : Req) : ApiM ApiResponse := do
  let input ← parseBody ArtifactInput req.body
  let label ← match ← liftIO (Plugins.artifactHandler? input.kind) with
    | none => fail (.unprocessable s!"unknown artifact kind '{input.kind}'")
    | some h => match h.validate input.payload with
      | .error e => fail (.unprocessable s!"invalid {input.kind} payload: {e}")
      | .ok _ => pure (h.render input.payload).label
  let actorId := req.actor.map (·.id)
  match ← ctx.dbM (fun db => do
      match ← Db.getIssue db ⟨issueId⟩ with
      | none => pure none
      | some _ =>
        let a ← Db.createArtifact db ⟨issueId⟩ input
        Db.recordEvent db ⟨issueId⟩ actorId "artifact_added"
          (Json.mkObj [("kind", input.kind), ("label", label)])
        pure (some a)) with
  | some a => created (toJson (← liftIO (toArtifactView a)))
  | none => fail (.notFound s!"issue {issueId} not found")

def deleteArtifactH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  let actorId := req.actor.map (·.id)
  match ← ctx.dbM (fun db => do
      match ← Db.getArtifact db ⟨id⟩, ← Db.artifactIssue db ⟨id⟩ with
      | some art, some issueId =>
        let removed ← Db.deleteArtifact db ⟨id⟩
        if removed then
          Db.recordEvent db issueId actorId "artifact_removed" (Json.mkObj [("kind", art.kind)])
        pure (some removed)
      | _, _ => pure none) with
  | some true => ok (Json.mkObj [("deleted", true)])
  | _ => fail (.notFound s!"artifact {id} not found")

/-! ## Checks -/

def listChecksH (ctx : AppContext) (issueId : Int64) : ApiM ApiResponse := do
  ok (toJson (← ctx.dbM (Db.issueChecks · ⟨issueId⟩)))

def createCheckH (ctx : AppContext) (issueId : Int64) (req : Req) : ApiM ApiResponse := do
  let input ← parseBody CheckInput req.body
  match ← liftIO (Plugins.checkHandler? input.kind) with
  | none => fail (.unprocessable s!"unknown check kind '{input.kind}'")
  | some h => match h.validateConfig input.config with
    | .error e => fail (.unprocessable s!"invalid {input.kind} config: {e}")
    | .ok _ => pure ()
  let actorId := req.actor.map (·.id)
  match ← ctx.dbM (fun db => do
      match ← Db.getIssue db ⟨issueId⟩ with
      | none => pure none
      | some _ =>
        let c ← Db.createCheck db ⟨issueId⟩ input
        Db.recordEvent db ⟨issueId⟩ actorId "check_added" (Json.mkObj [("kind", input.kind)])
        pure (some c)) with
  | some c => created (toJson c)
  | none => fail (.notFound s!"issue {issueId} not found")

def deleteCheckH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  let actorId := req.actor.map (·.id)
  match ← ctx.dbM (fun db => do
      match ← Db.getCheck db ⟨id⟩, ← Db.checkIssue db ⟨id⟩ with
      | some chk, some issueId =>
        let removed ← Db.deleteCheck db ⟨id⟩
        if removed then
          Db.recordEvent db issueId actorId "check_removed" (Json.mkObj [("kind", chk.kind)])
        pure (some removed)
      | _, _ => pure none) with
  | some true => ok (Json.mkObj [("deleted", true)])
  | _ => fail (.notFound s!"check {id} not found")

/-- Evaluate a check now and return its updated state. -/
def runCheckH (ctx : AppContext) (id : Int64) : ApiM ApiResponse := do
  match ← ctx.dbM (Checks.runCheck · ⟨id⟩) with
  | some c => ok (toJson c)
  | none => fail (.notFound s!"check {id} not found")

/-! ## Graph -/

def graphH (ctx : AppContext) (actor : Option Actor) : ApiM ApiResponse := do
  let (issues, edges) ← ctx.dbM (fun db => do
    let issues ← Db.listIssues db none none none none
    let edges ← Db.allDependencyEdges db
    pure (issues, edges))
  let visible := issues.filter (visibleTo actor)
  let visibleIds : Std.HashSet Int64 := visible.foldl (fun s i => s.insert i.id.val) {}
  let nodes := visible.map fun i =>
    Json.mkObj [("id", toJson i.id), ("title", i.title), ("state", toJson i.state), ("labels", toJson i.labels)]
  -- Edges are dependency edges: `issue` depends on `dependsOn`.
  let edgeJson := (edges.filter fun (iss, dep) =>
      visibleIds.contains iss.val && visibleIds.contains dep.val).map fun (iss, dep) =>
    Json.mkObj [("issue", toJson iss), ("dependsOn", toJson dep)]
  ok (Json.mkObj [("nodes", Json.arr nodes), ("edges", Json.arr edgeJson)])

/-! ## Import -/

private structure GithubImportReq where
  owner : String
  repo : String
  state : String := "open"

private instance : FromJson GithubImportReq where
  fromJson? j := do pure {
    owner := ← jsonField? j "owner"
    repo := ← jsonField? j "repo"
    state := ← jsonFieldD? j "state" "open" }

private structure GdocImportReq where
  text : Option String := none
  docId : Option String := none
  accessToken : Option String := none

private instance : FromJson GdocImportReq where
  fromJson? j := do pure {
    text := ← jsonFieldOpt? j "text"
    docId := ← jsonFieldOpt? j "docId"
    accessToken := ← jsonFieldOpt? j "accessToken" }

def importGithubH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let r ← parseBody GithubImportReq req.body
  match ← liftIO (Import.fetchGithubIssues r.owner r.repo r.state) with
  | .error e => fail (.unprocessable s!"github import failed: {e}")
  | .ok items =>
    let ids ← ctx.dbM (fun db => do
      let mut ids := #[]
      for it in items do
        let labelIds ← it.labelNames.mapM (Db.getOrCreateLabelByName db ·)
        let issue ← Db.createIssue db { it.input with labels := labelIds }
        let _ ← Db.createArtifact db issue.id
          { kind := "github-issue", payload := Json.mkObj [("url", it.url), ("number", it.number)] }
        ids := ids.push issue.id
      pure ids)
    created (Json.mkObj [("imported", ids.size), ("issueIds", toJson ids)])

def importGdocH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let r ← parseBody GdocImportReq req.body
  let text ← match r.text with
    | some t => pure t
    | none => match r.docId with
      | none => fail (.badRequest "provide 'text' or 'docId'")
      | some id =>
        let token ← match r.accessToken with
          | some t => pure t
          | none => match ← liftIO (IO.getEnv "GOOGLE_ACCESS_TOKEN") with
            | some t => pure t
            | none => fail (.badRequest "docId import requires 'accessToken' or GOOGLE_ACCESS_TOKEN")
        match ← liftIO (Import.fetchGoogleDocText id token) with
        | .error e => fail (.unprocessable s!"google doc fetch failed: {e}")
        | .ok t => pure t
  let inputs := Import.linesToIssues text
  let ids ← ctx.dbM (fun db => inputs.mapM (fun i => do pure (← Db.createIssue db i).id))
  created (Json.mkObj [("imported", ids.size), ("issueIds", toJson ids)])

/-! ## Comments -/

def listCommentsH (ctx : AppContext) (issueId : Int64) : ApiM ApiResponse := do
  ok (toJson (← ctx.dbM (Db.issueComments · ⟨issueId⟩)))

def createCommentH (ctx : AppContext) (issueId : Int64) (req : Req) : ApiM ApiResponse := do
  let input ← parseBody CommentInput req.body
  if input.body.trimAscii.isEmpty then fail (.badRequest "comment body must not be empty")
  let authorId := req.actor.map (·.id)
  match ← ctx.dbM (fun db => do
      match ← Db.getIssue db ⟨issueId⟩ with
      | none => pure none
      | some _ => some <$> Db.createComment db ⟨issueId⟩ authorId input) with
  | some c => created (toJson c)
  | none => fail (.notFound s!"issue {issueId} not found")

/-- Whether `actor` may edit or delete comment `c` (its author, or an admin). -/
private def mayModifyComment (actor : Option Actor) (c : Comment) : Bool :=
  let isAuthor := actor.isSome && (actor.map (·.id.val)) == (c.authorId.map (·.val))
  let isAdmin := actor.map (·.admin) |>.getD false
  isAuthor || isAdmin

def updateCommentH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  match ← ctx.dbM (Db.getComment · ⟨id⟩) with
  | none => fail (.notFound s!"comment {id} not found")
  | some c =>
    unless mayModifyComment req.actor c do
      fail (.forbidden "only the comment's author or an admin may edit it")
    let input ← parseBody CommentInput req.body
    if input.body.trimAscii.isEmpty then fail (.badRequest "comment body must not be empty")
    let actorId := req.actor.map (·.id)
    match ← ctx.dbM (fun db => do
        let updated ← Db.updateComment db ⟨id⟩ input.body
        if updated.isSome && input.body != c.body then
          Db.recordEvent db c.issueId actorId "comment_edited"
            (Json.mkObj [("commentId", toJson c.id), ("from", c.body), ("to", input.body)])
        pure updated) with
    | some updated => ok (toJson updated)
    | none => fail (.notFound s!"comment {id} not found")

def deleteCommentH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  match ← ctx.dbM (Db.getComment · ⟨id⟩) with
  | none => fail (.notFound s!"comment {id} not found")
  | some c =>
    unless mayModifyComment req.actor c do
      fail (.forbidden "only the comment's author or an admin may delete it")
    let actorId := req.actor.map (·.id)
    match ← ctx.dbM (fun db => do
        let removed ← Db.deleteComment db ⟨id⟩
        if removed then
          Db.recordEvent db c.issueId actorId "comment_deleted"
            (Json.mkObj [("commentId", toJson c.id)])
        pure removed) with
    | true => ok (Json.mkObj [("deleted", true)])
    | false => fail (.notFound s!"comment {id} not found")

/-! ## API tokens -/

def listTokensH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  match req.actor with
  | none => fail (.unauthorized "authentication required")
  | some a => ok (toJson (← ctx.dbM (Db.listTokens · a.id)))

def createTokenH (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  match req.actor with
  | none => fail (.unauthorized "authentication required")
  | some a =>
    let input ← parseBody TokenInput req.body
    -- Generate a high-entropy secret; store only its SHA-256 hash. The plaintext is returned
    -- exactly once, here, and cannot be recovered afterwards.
    let secret := "issues_pat_" ++ (← liftIO randomToken)
    let hash := Crypto.sha256Hex secret
    let pfx := String.ofList (secret.toList.take 15)
    let tok ← ctx.dbM (Db.createToken · a.id input.name hash pfx)
    created (toJson ({ token := tok, secret } : ApiTokenCreated))

def deleteTokenH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  match req.actor with
  | none => fail (.unauthorized "authentication required")
  | some a =>
    if ← ctx.dbM (Db.deleteToken · ⟨id⟩ a.id) then
      ok (Json.mkObj [("deleted", true)])
    else fail (.notFound s!"token {id} not found")

/-- Admin-only: list the API tokens belonging to another actor. -/
def listActorTokensH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  unless (req.actor.map (·.admin) |>.getD false) do fail (.forbidden "admin privileges required")
  match ← ctx.dbM (Db.getActor · ⟨id⟩) with
  | none => fail (.notFound s!"actor {id} not found")
  | some a => ok (toJson (← ctx.dbM (Db.listTokens · a.id)))

/-- Admin-only: mint an API token on behalf of another actor (e.g. a bot). The secret is returned
    exactly once, here. -/
def createActorTokenH (ctx : AppContext) (id : Int64) (req : Req) : ApiM ApiResponse := do
  unless (req.actor.map (·.admin) |>.getD false) do fail (.forbidden "admin privileges required")
  match ← ctx.dbM (Db.getActor · ⟨id⟩) with
  | none => fail (.notFound s!"actor {id} not found")
  | some a =>
    let input ← parseBody TokenInput req.body
    let secret := "issues_pat_" ++ (← liftIO randomToken)
    let hash := Crypto.sha256Hex secret
    let pfx := String.ofList (secret.toList.take 15)
    let tok ← ctx.dbM (Db.createToken · a.id input.name hash pfx)
    created (toJson ({ token := tok, secret } : ApiTokenCreated))

/-! ## Plugins -/

def pluginsH : ApiM ApiResponse := do
  let arts ← liftIO Plugins.allArtifactHandlers
  let checks ← liftIO Plugins.allCheckHandlers
  let artJson := arts.map fun h => Json.mkObj [("kind", h.kind), ("fields", toJson h.fields)]
  let checkJson := checks.map fun h => Json.mkObj [("kind", h.kind), ("fields", toJson h.fields)]
  ok (Json.mkObj [("artifactKinds", Json.arr artJson), ("checkKinds", Json.arr checkJson)])

/-! ## Routing table -/

/-- Whether the request is to an authentication route (never gated). -/
private def isAuthRoute : List String → Bool
  | "auth" :: _ => true
  | _ => false

/-- Whether the route manages admin-only resources (actors, groups, labels, import). -/
private def isAdminResource : List String → Bool
  | "actors" :: _ | "groups" :: _ | "labels" :: _ | "import" :: _ => true
  | _ => false

/-- Route a request to a handler based on method and decoded path segments. -/
def dispatch (ctx : AppContext) (req : Req) : ApiM ApiResponse := do
  let mutating := req.method == .post || req.method == .patch || req.method == .delete
  -- Anyone may read; making changes requires an authenticated actor. Unauthenticated users are
  -- therefore read-only.
  if req.actor.isNone && !isAuthRoute req.segments && mutating then
    fail (.unauthorized "authentication required")
  -- Managing actors/groups/labels and running imports requires admin privileges.
  if mutating && isAdminResource req.segments && !(req.actor.map (·.admin) |>.getD false) then
    fail (.forbidden "admin privileges required")
  match req.method, req.segments with
  | .get, ["health"] => ok (Json.mkObj [("status", "ok"), ("version", Issues.version)])
  | .get, ["openapi.json"] => ok OpenApi.spec
  | .get, ["plugins"] => pluginsH
  | .get, ["graph"] => graphH ctx req.actor

  | .get, ["me"] => meH req
  | .get, ["auth", "google", "login"] => googleLoginH ctx
  | .get, ["auth", "google", "callback"] => googleCallbackH ctx req
  | .post, ["auth", "logout"] => logoutH ctx req
  | .post, ["auth", "dev-login"] => devLoginH ctx req

  | .get, ["actors"] => listActorsH ctx
  | .post, ["actors"] => createActorH ctx req
  | .get, ["actors", id] => getActorH ctx (← Req.parseId id)
  | .patch, ["actors", id] => updateActorH ctx (← Req.parseId id) req
  | .delete, ["actors", id] => deleteActorH ctx (← Req.parseId id)

  | .get, ["groups"] => listGroupsH ctx
  | .post, ["groups"] => createGroupH ctx req
  | .get, ["groups", id] => getGroupH ctx (← Req.parseId id)
  | .patch, ["groups", id] => updateGroupH ctx (← Req.parseId id) req
  | .delete, ["groups", id] => deleteGroupH ctx (← Req.parseId id)

  | .get, ["labels"] => listLabelsH ctx
  | .post, ["labels"] => createLabelH ctx req
  | .get, ["labels", id] => getLabelH ctx (← Req.parseId id)
  | .patch, ["labels", id] => updateLabelH ctx (← Req.parseId id) req
  | .delete, ["labels", id] => deleteLabelH ctx (← Req.parseId id)

  | .get, ["issues"] => listIssuesH ctx req
  | .post, ["issues"] => createIssueH ctx req
  | .get, ["issues", id] => getIssueH ctx (← Req.parseId id) req.actor
  | .patch, ["issues", id] => updateIssueH ctx (← Req.parseId id) req
  | .delete, ["issues", id] => deleteIssueH ctx (← Req.parseId id)
  | .get, ["issues", id, "events"] => listEventsH ctx (← Req.parseId id) req.actor

  | .post, ["issues", id, "artifacts"] => createArtifactH ctx (← Req.parseId id) req
  | .delete, ["artifacts", id] => deleteArtifactH ctx (← Req.parseId id) req

  | .get, ["issues", id, "checks"] => listChecksH ctx (← Req.parseId id)
  | .post, ["issues", id, "checks"] => createCheckH ctx (← Req.parseId id) req
  | .post, ["checks", id, "run"] => runCheckH ctx (← Req.parseId id)
  | .delete, ["checks", id] => deleteCheckH ctx (← Req.parseId id) req

  | .get, ["issues", id, "comments"] => listCommentsH ctx (← Req.parseId id)
  | .post, ["issues", id, "comments"] => createCommentH ctx (← Req.parseId id) req
  | .patch, ["comments", id] => updateCommentH ctx (← Req.parseId id) req
  | .delete, ["comments", id] => deleteCommentH ctx (← Req.parseId id) req

  | .get, ["me", "tokens"] => listTokensH ctx req
  | .post, ["me", "tokens"] => createTokenH ctx req
  | .delete, ["me", "tokens", id] => deleteTokenH ctx (← Req.parseId id) req

  | .get, ["actors", id, "tokens"] => listActorTokensH ctx (← Req.parseId id) req
  | .post, ["actors", id, "tokens"] => createActorTokenH ctx (← Req.parseId id) req

  | .post, ["import", "github"] => importGithubH ctx req
  | .post, ["import", "gdoc"] => importGdocH ctx req

  | _, _ => fail (.notFound s!"no route for {req.method} /{"/".intercalate req.segments}")

end Issues.Server
