import Taxis.Domain

/-!
# Work conventions

The `taxis` CLI's issue commands speak the conventions an orchestrator (Orchestra) layers on top
of taxis so that agents can pick up, hand back and review work. None of them is a server-side
concept; they are agreements about how ordinary taxis data is read:

* **Projects** are issues carrying the `t-project` label. The issues *of* a project are its
  descendants through `parent`.
* **Status** is `open | claimed | completed | abandoned`: the issue's `state` (`completed` →
  completed, `closed` → abandoned), and for an open issue whether it carries the `o-claimed` label.
* **A claim** is a `session` artifact on the issue (`task_id`, `agent`, `claimed_at`, optional
  `series`) together with the `o-claimed` label. At most one is meant to exist.
* **Target** (the repository and branch work on the issue is opened against) has no native field:
  it lives in a JSON block fenced as ` ```orchestra-meta ` at the end of the description, which
  is stripped before the description is shown. A project's block holds the default target its
  issues inherit.
* **Attached pull requests** are `github-pr` artifacts; an open issue with one is *in review*.
* **Context notes** are `context` artifacts (`title`, `text`).

Everything here is pure, so the arithmetic that decides what a command writes is testable without
a server.
-/

open Lean

namespace Taxis.Cli.Work

/-- The label that marks an issue claimed. -/
def claimedLabel : String := "o-claimed"
/-- The label that marks an issue a project. -/
def projectLabel : String := "t-project"
/-- Labels maintained by the claim and project machinery, which `issue edit` refuses to set by
    hand: a claim label with no claim behind it hides an issue from every dispatcher. -/
def reservedLabels : List String := [claimedLabel, projectLabel]

/-! ## Targets and the metadata block -/

/-- A repository (`owner/name`) and the branch to open pull requests against. -/
structure RepoTarget where
  repo : String
  branch : String
deriving Repr, Inhabited, BEq

def RepoTarget.render (t : RepoTarget) : String := s!"{t.repo}@{t.branch}"

instance : ToJson RepoTarget where
  toJson t := Json.mkObj [("repo", Json.str t.repo), ("branch", Json.str t.branch)]

instance : FromJson RepoTarget where
  fromJson? j := do
    let repo ← j.getObjValAs? String "repo"
    let branch ← j.getObjValAs? String "branch"
    return { repo, branch }

/-- Validate an `owner/name` repository string. -/
def parseRepo (s : String) : Except String String :=
  match s.trimAscii.toString.splitOn "/" with
  | [owner, name] =>
    if owner.isEmpty || name.isEmpty then .error s!"invalid repository '{s}', expected owner/name"
    else .ok s!"{owner}/{name}"
  | _ => .error s!"invalid repository '{s}', expected owner/name"

private def metaFence := "\n```orchestra-meta\n"
private def metaFenceEnd := "\n```"

/-- Append `fields` (if any) to `human` as a trailing fenced metadata block. -/
def encodeMeta (human : String) (fields : List (String × Json)) : String :=
  if fields.isEmpty then human
  else human ++ metaFence ++ (Json.mkObj fields).compress ++ metaFenceEnd

/-- Split a description into its human text and its metadata object (`{}` when there is none or
    it does not parse). Splits on the *last* fence, as the writer always appends there. -/
def decodeMeta (raw : String) : String × Json :=
  match raw.splitOn metaFence with
  | [] | [_] => (raw, Json.mkObj [])
  | parts =>
    let human := metaFence.intercalate parts.dropLast
    match (parts.getLastD "").splitOn metaFenceEnd with
    | metaStr :: _ =>
      match Json.parse metaStr with
      | .ok j => (human, j)
      | .error _ => (raw, Json.mkObj [])
    | [] => (raw, Json.mkObj [])

/-- The fields of a metadata object, in order. -/
private def metaFields (j : Json) : List (String × Json) :=
  match j with
  | .obj kvs => kvs.toList
  | _ => []

/-- A description's human-readable part. -/
def humanText (raw : String) : String := (decodeMeta raw).1

/-- The target recorded in a description's metadata block. -/
def targetOf (raw : String) : Option RepoTarget :=
  ((decodeMeta raw).2.getObjValAs? RepoTarget "target").toOption

/-- `raw` with its human text replaced by `human`, keeping the metadata block. -/
def replaceHuman (raw human : String) : String :=
  encodeMeta human (metaFields (decodeMeta raw).2)

/-- `raw` with its target set (`some (some t)`), cleared (`some none`) or left alone (`none`),
    keeping every other metadata field — a project's `reviewer`, say. -/
def replaceTarget (raw : String) : Option (Option RepoTarget) → String
  | none => raw
  | some t? =>
    let (human, m) := decodeMeta raw
    let rest := (metaFields m).filter (·.1 != "target")
    let fields := match t? with
      | some t => rest ++ [("target", toJson t)]
      | none => rest
    encodeMeta human fields

/-! ## Status -/

inductive Status where
  | open
  | claimed
  | completed
  | abandoned
deriving Repr, Inhabited, BEq, DecidableEq

def Status.toString : Status → String
  | .open => "open"
  | .claimed => "claimed"
  | .completed => "completed"
  | .abandoned => "abandoned"

instance : ToString Status := ⟨Status.toString⟩

/-- `closed` is accepted for `abandoned`, being what taxis itself calls it. -/
def Status.ofString? : String → Option Status
  | "open" => some .open
  | "claimed" => some .claimed
  | "completed" => some .completed
  | "abandoned" | "closed" => some .abandoned
  | _ => none

/-- The status a taxis issue's `state` and labels represent. -/
def statusOf (state : IssueState) (labels : Array LabelId) (claimedId : Option LabelId) : Status :=
  match state with
  | .completed => .completed
  | .closed => .abandoned
  | .open =>
    match claimedId with
    | some c => if labels.contains c then .claimed else .open
    | none => .open

/-- The taxis `state` a status is written as. -/
def Status.state : Status → IssueState
  | .completed => .completed
  | .abandoned => .closed
  | _ => .open

/-! ## Labels and actors by name -/

/-- Resolve a label by name, case-insensitively. Unknown and ambiguous names are refused with the
    vocabulary, so a typo does not become a silent no-op. -/
def findLabel (known : Array Label) (name : String) : Except String Label :=
  let key := name.trimAscii.toString.toLower
  match (known.filter (·.name.toLower == key)).toList with
  | [l] => .ok l
  | [] =>
    let vocab := if known.isEmpty then "the tracker defines no labels"
      else s!"known labels: {", ".intercalate (known.map (·.name)).toList}"
    .error s!"no such label: {name} ({vocab})"
  | several =>
    .error s!"{name} matches several labels differing only in case: \
      {", ".intercalate (several.map (·.name))}"

/-- Resolve one actor by email or display name, case-insensitively; email wins. -/
def findActor (known : Array Actor) (name : String) : Except String Actor :=
  let key := name.trimAscii.toString.toLower
  let byEmail := known.filter (·.email.toLower == key)
  let found := if byEmail.isEmpty then known.filter (·.displayName.toLower == key) else byEmail
  match found.toList with
  | [a] => .ok a
  | [] =>
    let vocab := if known.isEmpty then "the tracker has no actors"
      else s!"known actors: {", ".intercalate (known.map (·.email)).toList}"
    .error s!"no such actor: {name} ({vocab})"
  | several =>
    .error s!"{name} names several actors ({", ".intercalate (several.map (·.email))}); \
      say which by email"

private def pushNew [BEq α] (xs : Array α) (x : α) : Array α :=
  if xs.contains x then xs else xs.push x

/-- Refuse the reserved labels unless `allowReserved`. -/
private def checkReserved (names : List String) (allowReserved : Bool) : Except String Unit := do
  unless allowReserved do
    let bad := names.filter fun n => reservedLabels.contains n.trimAscii.toString.toLower
    unless bad.isEmpty do
      .error s!"{", ".intercalate bad}: maintained by `taxis issue claim`/`release` and \
        `taxis project create`; not set by hand"

/-- The label set to write for adding `add` and removing `remove` from `current`. -/
def planLabels (known : Array Label) (current : Array LabelId) (add remove : List String)
    (allowReserved : Bool := false) : Except String (Array LabelId) := do
  checkReserved (add ++ remove) allowReserved
  let toAdd ← add.mapM (findLabel known)
  let toRemove ← remove.mapM (findLabel known)
  let kept := current.filter fun l => !toRemove.any (·.id == l)
  return toAdd.foldl (fun acc l => pushNew acc l.id) kept

/-- The assignee set to write for adding `add` and removing `remove` from `current`. -/
def planAssignees (known : Array Actor) (current : Array ActorId) (add remove : List String) :
    Except String (Array ActorId) := do
  let toAdd ← add.mapM (findActor known)
  let toRemove ← remove.mapM (findActor known)
  let kept := current.filter fun a => !toRemove.any (·.id == a)
  return toAdd.foldl (fun acc a => pushNew acc a.id) kept

/-! ## Creating and editing issues -/

/-- What `taxis issue create` was asked for. -/
structure CreateRequest where
  title : String
  description : String := ""
  goal : String := ""
  /-- The issue's parent: `--parent`, else `--project`. -/
  parent : Option IssueId := none
  target : Option RepoTarget := none
  dependencies : Array IssueId := #[]
  labels : List String := []
  assignees : List String := []
deriving Inhabited

/-- The `POST /issues` body for a create request. -/
def planCreate (known : Array Label) (actors : Array Actor) (r : CreateRequest) :
    Except String IssueInput := do
  if r.title.trimAscii.isEmpty then .error "an issue needs a title"
  let labels ← planLabels known #[] r.labels []
  let assignees ← planAssignees actors #[] r.assignees []
  let description := replaceTarget r.description (r.target.map some)
  return { title := r.title, description, goal := r.goal, parent := r.parent,
           dependencies := r.dependencies, labels, assignees }

/-- What `taxis issue edit` was asked for. Every field is optional; absent means unchanged. -/
structure EditRequest where
  title : Option String := none
  description : Option String := none
  goal : Option String := none
  status : Option Status := none
  state : Option IssueState := none
  /-- `some none` clears the target. -/
  target : Option (Option RepoTarget) := none
  dependencies : Option (Array IssueId) := none
  /-- `some none` detaches the issue from its parent. -/
  parent : Option (Option IssueId) := none
  addLabels : List String := []
  removeLabels : List String := []
  addAssignees : List String := []
  removeAssignees : List String := []
deriving Inhabited

/-- The `PATCH /issues/:id` update for an edit request against the issue as it is now. Only the
    fields the request names are set — the labels and assignees are computed from the current sets,
    so adding one label leaves the others (the claim label included) alone. -/
def planEdit (current : Issue) (known : Array Label) (actors : Array Actor) (r : EditRequest) :
    Except String IssueUpdate := do
  if r.status.isSome && r.state.isSome then .error "give --status or --state, not both"
  let claimedId := (known.find? (·.name == claimedLabel)).map (·.id)
  -- Description and target share the one stored field, so either rewrites it.
  let description : Option String :=
    match r.description, r.target with
    | none, none => none
    | d?, t? => some (replaceTarget (match d? with
        | some d => replaceHuman current.description d
        | none => current.description) t?)
  let labelDelta := !(r.addLabels.isEmpty && r.removeLabels.isEmpty)
  let mut labels := current.labels
  if labelDelta then
    labels ← planLabels known labels r.addLabels r.removeLabels
  -- A status other than `claimed` drops the claim label; `claimed` needs it to exist.
  let mut statusTouchesLabels := false
  if let some st := r.status then
    match st, claimedId with
    | .claimed, none => .error s!"cannot mark the issue claimed: the tracker has no \
        '{claimedLabel}' label (an administrator must create it)"
    | .claimed, some c => labels := pushNew labels c; statusTouchesLabels := true
    | _, some c =>
      if labels.contains c then labels := labels.filter (· != c); statusTouchesLabels := true
    | _, none => pure ()
  let assignees ←
    if r.addAssignees.isEmpty && r.removeAssignees.isEmpty then pure none
    else some <$> planAssignees actors current.assignees r.addAssignees r.removeAssignees
  return {
    title := r.title
    description
    goal := r.goal
    state := (r.status.map (·.state)) <|> r.state
    labels := if labelDelta || statusTouchesLabels then some labels else none
    dependencies := r.dependencies
    parent := r.parent
    assignees }

/-- Whether an update would change nothing at all. -/
def _root_.Taxis.IssueUpdate.isEmpty (u : IssueUpdate) : Bool :=
  u.title.isNone && u.description.isNone && u.goal.isNone && u.state.isNone && u.locked.isNone &&
  u.labels.isNone && u.parent.isNone && u.dependencies.isNone && u.assignees.isNone &&
  u.visibility.isNone && u.deadline.isNone

/-! ## Artifacts -/

/-- Payload of a `session` (claim) artifact. -/
def sessionPayload (taskId agent claimedAt : String) (series : Option String := none) : Json :=
  Json.mkObj <|
    [("task_id", Json.str taskId), ("agent", Json.str agent), ("claimed_at", Json.str claimedAt)] ++
    (series.map fun s => [("series", Json.str s)]).getD []

/-- Payload of a `github-pr` artifact. `url` is what the server's handler requires; the other
    fields are what orchestra reads back. -/
def prPayload (repo : String) (number : Nat) (branch : String) (taskId : Option String := none) :
    Json :=
  Json.mkObj <|
    [("url", Json.str s!"https://github.com/{repo}/pull/{number}"), ("repo", Json.str repo),
     ("number", Json.num number), ("branch", Json.str branch)] ++
    (taskId.map fun t => [("task_id", Json.str t)]).getD []

/-- Payload of a `context` artifact. -/
def contextPayload (title text : String) : Json :=
  Json.mkObj [("title", Json.str title), ("text", Json.str text)]

/-- A claim, as read back from a `session` artifact. -/
structure Claim where
  artifact : ArtifactId
  taskId : String
  agent : String
  claimedAt : String
  series : Option String := none
deriving Repr, Inhabited

def claimsOf (arts : Array ArtifactView) : Array Claim :=
  arts.filterMap fun a =>
    if a.kind != "session" then none
    else match a.payload.getObjValAs? String "task_id" with
      | .ok taskId => some {
          artifact := a.id, taskId
          agent := (a.payload.getObjValAs? String "agent").toOption.getD "?"
          claimedAt := (a.payload.getObjValAs? String "claimed_at").toOption.getD "?"
          series := (a.payload.getObjValAs? String "series").toOption }
      | .error _ => none

/-- An attached pull request, as read back from a `github-pr` artifact. -/
structure PullRequest where
  artifact : ArtifactId
  url : String
  repo : Option String := none
  number : Option Nat := none
  branch : Option String := none
deriving Repr, Inhabited

def pullRequestsOf (arts : Array ArtifactView) : Array PullRequest :=
  arts.filterMap fun a =>
    if a.kind != "github-pr" then none
    else
      let str? (f : String) := (a.payload.getObjValAs? String f).toOption
      some { artifact := a.id, url := (str? "url").getD a.display.label, repo := str? "repo",
             number := (a.payload.getObjValAs? Nat "number").toOption, branch := str? "branch" }

def PullRequest.render (p : PullRequest) : String :=
  match p.repo, p.number with
  | some r, some n => s!"{r}#{n}{(p.branch.map (s!" (branch {·})")).getD ""}"
  | _, _ => p.url

/-- A context note, as read back from a `context` artifact. -/
structure ContextNote where
  id : ArtifactId
  title : String
  text : String
deriving Repr, Inhabited

def contextNotesOf (arts : Array ArtifactView) : Array ContextNote :=
  arts.filterMap fun a =>
    if a.kind != "context" then none
    else match a.payload.getObjValAs? String "title", a.payload.getObjValAs? String "text" with
      | .ok title, .ok text => some { id := a.id, title, text }
      | _, _ => none

/-! ## Trees -/

/-- Every issue of `all` strictly below `root` through `parent`. Bounded by `all.size` steps up
    each chain, so a parent cycle cannot hang it. -/
def descendantsOf (all : Array Issue) (root : IssueId) : Array Issue :=
  let byId : Std.HashMap IssueId Issue := Std.HashMap.ofList (all.toList.map fun i => (i.id, i))
  let rec below (i : Issue) : Nat → Bool
    | 0 => false
    | fuel + 1 =>
      match i.parent with
      | none => false
      | some p => p == root || match byId.get? p with
        | some parent => below parent fuel
        | none => false
  all.filter (below · all.size)

/-! ## Split -/

/-- One child of `taxis issue split`. -/
structure ChildSpec where
  title : String
  description : String := ""
  target : Option RepoTarget := none
deriving Repr, Inhabited, BEq

/-- Children from a JSON array of `{title, description?, target_repo?, target_branch?}` — the
    shape `split_issue` took, so a spec written for it still works. -/
def childrenFromJson (j : Json) : Except String (Array ChildSpec) := do
  let arr ← j.getArr?
  arr.mapM fun item => do
    let title ← item.getObjValAs? String "title"
    let description := (item.getObjValAs? String "description").toOption.getD ""
    let repo? := (item.getObjValAs? String "target_repo").toOption
    let branch? := (item.getObjValAs? String "target_branch").toOption
    let target ← match repo?, branch? with
      | none, none => pure none
      | some r, some b => do let r ← parseRepo r; pure (some { repo := r, branch := b })
      | _, _ => .error s!"child '{title}': target_repo and target_branch go together"
    return { title, description, target }

/-- Children from repeated `--child TITLE` options, each optionally followed by
    `--child-description TEXT` that belongs to the `--child` before it. `opts` is every option
    occurrence in order. -/
def childrenFromOptions (opts : Array (String × String)) : Except String (Array ChildSpec) := do
  let mut out : Array ChildSpec := #[]
  for (name, value) in opts do
    if name == "child" then
      out := out.push { title := value }
    else if name == "child-description" then
      match out.back? with
      | none => .error "--child-description must follow the --child it describes"
      | some c => out := out.pop.push { c with description := value }
  return out

end Taxis.Cli.Work
