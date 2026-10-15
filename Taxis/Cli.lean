import Taxis.Client
import Taxis.Cli.Args
import Taxis.Cli.Config
import Taxis.Cli.Work
import Std.Time

/-!
# The `taxis` command-line client

`taxis <noun> <verb> [args] [options]` against a running taxis server's REST API — the operations
an agent needs to find, take, work on, hand back and review issues, as ordinary shell commands
rather than MCP tools. See the README's "Command-line client" section for the full reference;
every command also answers `--help`.

Output is human-readable by default and the server's JSON with `--json`. A failed request prints
the HTTP status and the server's message and exits 1; a usage mistake exits 2.
-/

open Lean
open Taxis.Cli.Work

namespace Taxis.Cli

/-! ## Plumbing -/

/-- Why a command stopped: a usage mistake (exit 2, with the command's synopsis) or a failure
    (exit 1). -/
inductive Failure where
  | usage (msg : String)
  | error (msg : String)

abbrev CliM := ExceptT Failure IO

def usageError (msg : String) : CliM α := throw (.usage msg)
def failWith (msg : String) : CliM α := throw (.error msg)

/-- Run a client call, turning its error into a failure. -/
def call (x : IO (Except String α)) : CliM α := do
  match ← x with
  | .ok a => pure a
  | .error e => failWith e

structure Ctx where
  settings : Settings
  json : Bool := false

def Ctx.cfg (c : Ctx) : Client.Config := c.settings.client

def out (s : String) : CliM Unit := IO.println s

def outJson (j : Json) : CliM Unit := IO.println j.pretty

/-- Parse an issue (or other) id, tolerating a leading `#`. -/
def parseId (what s : String) : CliM Int64 :=
  let s' := if s.startsWith "#" then (s.drop 1).toString else s
  match s'.toInt? with
  | some n => pure (Int64.ofInt n)
  | none => usageError s!"{what} must be a number, got '{s}'"

def issueIdArg (s : String) : CliM IssueId := return ⟨← parseId "issue id" s⟩

/-- An optional `--NAME ID` option. -/
def optIssueId (p : Parsed) (name : String) : CliM (Option IssueId) :=
  (p.get? name).mapM fun s => do return ⟨← parseId s!"--{name}" s⟩

def natArg (what s : String) : CliM Nat :=
  match s.toNat? with
  | some n => pure n
  | none => usageError s!"{what} must be a non-negative number, got '{s}'"

/-- The single positional argument a command requires. -/
def onePositional (p : Parsed) (name : String) : CliM String :=
  match p.positional.toList with
  | [x] => pure x
  | [] => usageError s!"missing {name}"
  | _ => usageError s!"expected one {name}, got {p.positional.size} arguments"

/-- Text from `--NAME TEXT`, or `--NAME-file PATH` (`-` reads standard input). -/
def textOption (p : Parsed) (name : String) : CliM (Option String) := do
  match p.get? name, p.get? s!"{name}-file" with
  | some _, some _ => usageError s!"give --{name} or --{name}-file, not both"
  | some t, none => pure (some t)
  | none, some "-" => pure (some (← (← IO.getStdin).readToEnd))
  | none, some f =>
    match ← (IO.FS.readFile f).toBaseIO with
    | .ok s => pure (some s)
    | .error e => failWith s!"cannot read {f}: {e}"
  | none, none => pure none

def nowIso : IO String := do
  let s := (← Std.Time.Timestamp.now).toSecondsSinceUnixEpoch.toInt
  pure (Client.epochToIso8601Pure ⟨Int64.ofInt s⟩)

def fmtTime (t : Timestamp) : String := Client.epochToIso8601Pure t

def indent (s : String) (by_ : String := "    ") : String :=
  "\n".intercalate ((s.splitOn "\n").map (by_ ++ ·))

/-! ## Fetching -/

def fetchLabels (ctx : Ctx) : CliM (Array Label) := call (Client.listLabels ctx.cfg)
def fetchActors (ctx : Ctx) : CliM (Array Actor) := call (Client.listActors ctx.cfg)
def fetchDetail (ctx : Ctx) (id : IssueId) : CliM IssueDetail := call (Client.getIssueDetail ctx.cfg id)

def labelIdNamed (labels : Array Label) (name : String) : Option LabelId :=
  (labels.find? (·.name == name)).map (·.id)

def statusIn (labels : Array Label) (i : Issue) : Status :=
  statusOf i.state i.labels (labelIdNamed labels claimedLabel)

def labelNames (labels : Array Label) (ids : Array LabelId) : Array String :=
  ids.filterMap fun id => (labels.find? (·.id == id)).map (·.name)

/-- `#12  [open]  Title  {bug, ready}` -/
def issueLine (labels : Array Label) (i : Issue) : String :=
  let names := labelNames labels i.labels |>.filter (· != claimedLabel)
  let ls := if names.isEmpty then "" else s!"  \{{", ".intercalate names.toList}}"
  s!"#{i.id}  [{statusIn labels i}]  {i.title}{ls}"

def printIssues (ctx : Ctx) (labels : Array Label) (issues : Array Issue) (empty : String) :
    CliM Unit := do
  if ctx.json then outJson (toJson issues)
  else if issues.isEmpty then out empty
  else for i in issues do out (issueLine labels i)

/-- The nearest issue at or above `id` that is a project, with its default target. Walks at most
    `fuel` parents. -/
partial def projectOf (ctx : Ctx) (labels : Array Label) (detail : IssueDetail) :
    CliM (Option Issue) := do
  let some pl := labelIdNamed labels projectLabel | return none
  let rec walk (i : Issue) (fuel : Nat) : CliM (Option Issue) := do
    if i.labels.contains pl then return some i
    match fuel, i.parent with
    | 0, _ | _, none => return none
    | n + 1, some p =>
      match ← (Client.getIssue ctx.cfg p) with
      | .ok parent => walk parent n
      | .error _ => return none
  walk detail.issue 64

/-- An issue's own target, else its project's default. -/
def effectiveTarget (issue : Issue) (project : Option Issue) : Option RepoTarget :=
  targetOf issue.description <|> project.bind (targetOf ·.description)

/-! ## Commands -/

/-- One `taxis` command. -/
structure Command where
  path : List String
  /-- Positional synopsis, e.g. `ID`. -/
  args : String := ""
  summary : String
  details : String := ""
  opts : Array Opt := #[]
  /-- Endpoints this command calls, for its help. -/
  endpoints : List String := []
  run : Ctx → Parsed → CliM Unit

def globalOpts : Array Opt := #[
  { name := "json", help := "print the server's JSON instead of text" },
  { name := "url", metavar := some "URL", help := "server base URL (overrides TAXIS_URL and the config file)" },
  { name := "token", metavar := some "TOKEN", help := "API token (overrides TAXIS_TOKEN and the config file)" },
  { name := "config", metavar := some "FILE", help := "config file (default ~/.config/taxis/config.toml)" },
  { name := "help", short := some 'h', help := "show help for this command" }]

/-! ### issue list -/

def issueListOpts : Array Opt := #[
  { name := "project", metavar := some "ID", help := "only issues below this project (any depth)" },
  { name := "parent", metavar := some "ID", help := "only direct children of this issue" },
  { name := "status", metavar := some "STATUS", help := "open | claimed | completed | abandoned" },
  { name := "state", metavar := some "STATE", help := "taxis state: open | closed | completed" },
  { name := "label", metavar := some "NAME", help := "only issues carrying this label", repeatable := true },
  { name := "assignee", metavar := some "WHO", help := "only issues assigned to this actor (email or name)" },
  { name := "search", short := some 'q', metavar := some "TEXT", help := "full-text search in title and description" },
  { name := "target-repo", metavar := some "OWNER/NAME", help := "only issues whose effective target is this repository (needs --project)" },
  { name := "in-review", help := "only open, unclaimed issues with an attached pull request" },
  { name := "limit", metavar := some "N", help := "at most N issues" }]

def issueList (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "issue list takes no positional arguments"
  let labels ← fetchLabels ctx
  let status ← match p.get? "status" with
    | none => pure none
    | some s => match Status.ofString? s with
      | some st => pure (some st)
      | none => usageError s!"--status must be open, claimed, completed or abandoned, got '{s}'"
  let state ← match p.get? "state" with
    | none => pure none
    | some s => match IssueState.ofString? s with
      | some st => pure (some st)
      | none => usageError s!"--state must be open, closed or completed, got '{s}'"
  let wantLabels ← (p.getAll "label").mapM fun n =>
    match findLabel labels n with
    | .ok l => pure l.id
    | .error e => usageError e
  let assignee ← match p.get? "assignee" with
    | none => pure none
    | some w => match findActor (← fetchActors ctx) w with
      | .ok a => pure (some a.id)
      | .error e => usageError e
  let parent ← optIssueId p "parent"
  let project ← optIssueId p "project"
  let limit ← (p.get? "limit").mapM (natArg "--limit")
  let targetRepo ← (p.get? "target-repo").mapM fun r =>
    match parseRepo r with | .ok r => pure r | .error e => usageError e
  if targetRepo.isSome && project.isNone then usageError "--target-repo needs --project"
  -- Server-side filters where the server has them: one label, state, search, parent, assignee.
  let serverState := (status.map (·.state)) <|> state
  -- Membership of a project is a walk up the parent chain, which needs every issue on the way —
  -- including ancestors the other filters would drop — so the walk runs over the unfiltered list.
  let filtered ← call (Client.listIssues ctx.cfg (state := serverState) (label := wantLabels[0]?)
    (q := p.get? "search") (parent := parent) (assignee := assignee))
  let mut issues : Array Issue := filtered
  if let some pid := project then
    let below := descendantsOf (← call (Client.listIssues ctx.cfg)) pid
    issues := issues.filter fun i => below.any (·.id == i.id)
  issues := issues.filter fun i => wantLabels.all (i.labels.contains ·)
  if let some st := status then issues := issues.filter (statusIn labels · == st)
  if let some repo := targetRepo then
    let some pid := project | pure ()
    let projectIssue ← call (Client.getIssue ctx.cfg pid)
    issues := issues.filter fun i =>
      (effectiveTarget i (some projectIssue)).any (·.repo == repo)
  if p.has "in-review" then
    let mut reviewable := #[]
    -- Open and unclaimed, as orchestra's reviewer sweep reads it: a claimed issue is still being
    -- worked on, whatever is attached to it.
    for i in issues.filter (statusIn labels · == .open) do
      let d ← fetchDetail ctx i.id
      if !(pullRequestsOf d.attachedArtifacts).isEmpty then reviewable := reviewable.push i
    issues := reviewable
  if let some n := limit then issues := issues.extract 0 n
  printIssues ctx labels issues "No matching issues."

/-! ### issue show -/

def renderDetail (ctx : Ctx) (labels : Array Label) (d : IssueDetail) : CliM String := do
  let i := d.issue
  let project ← projectOf ctx labels d
  let children ← call (Client.listIssues ctx.cfg (parent := some i.id))
  let claims := claimsOf d.attachedArtifacts
  let prs := pullRequestsOf d.attachedArtifacts
  let notes := contextNotesOf d.attachedArtifacts
  let others := d.attachedArtifacts.filter fun a =>
    !["session", "github-pr", "context"].contains a.kind
  let target := effectiveTarget i project
  let orDash (xs : Array String) := if xs.isEmpty then "-" else ", ".intercalate xs.toList
  let mut lines : Array String := #[
    s!"#{i.id}  {i.title}",
    s!"status:       {statusIn labels i}  (state {i.state})",
    s!"project:      {(project.map fun pr => s!"#{pr.id} {pr.title}").getD "-"}",
    s!"parent:       {(i.parent.map (s!"#{·}")).getD "-"}",
    s!"target:       {(target.map (·.render)).getD "-"}{if (targetOf i.description).isNone && target.isSome then " (project default)" else ""}",
    s!"labels:       {orDash (d.issueLabels.map (·.name))}",
    s!"assignees:    {orDash (d.assignedActors.map fun a => s!"{a.displayName} <{a.email}>")}",
    s!"dependencies: {orDash (i.dependencies.map (s!"#{·}"))}",
    s!"created:      {fmtTime i.createdAt}{(i.creatorName.map (s!" by {·}")).getD ""}",
    s!"updated:      {fmtTime i.updatedAt}"]
  if i.locked then lines := lines.push "locked:       yes"
  match claims.toList with
  | [] => lines := lines.push "claim:        none"
  | c :: _ => lines := lines.push s!"claim:        task {c.taskId} ({c.agent}, since {c.claimedAt})"
  if !i.goal.isEmpty then lines := lines.push s!"goal:         {i.goal}"
  if !prs.isEmpty then
    lines := lines.push "pull requests:"
    lines := lines ++ prs.map (s!"  {·.render}")
  if !children.isEmpty then
    lines := lines.push "children:"
    lines := lines ++ children.map (s!"  {issueLine labels ·}")
  if !others.isEmpty then
    lines := lines.push "artifacts:"
    lines := lines ++ others.map fun a =>
      s!"  [{a.id}] {a.kind}: {a.display.label}{(a.display.url.map (s!" <{·}>")).getD ""}"
  if !notes.isEmpty then
    lines := lines.push "context notes (read with `taxis context list`):"
    lines := lines ++ notes.map fun n => s!"  [{n.id}] {n.title}"
  lines := lines.push "description:"
  let human := humanText i.description
  lines := lines.push (if human.trimAscii.isEmpty then "    (none)" else indent human)
  if !d.comments.isEmpty then
    lines := lines.push "comments:"
    lines := lines ++ d.comments.map renderComment
  return "\n".intercalate lines.toList
where
  renderComment (c : Comment) : String :=
    let verdict := match c.review with
      | some .approve => " [review: approve]"
      | some .requestChanges => " [review: request changes]"
      | none => ""
    s!"  {c.authorName.getD "(unknown)"} at {fmtTime c.createdAt}{verdict} (comment {c.id})\n{indent c.body}"

def issueShow (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let d ← fetchDetail ctx id
  if ctx.json then outJson (toJson d)
  else out (← renderDetail ctx (← fetchLabels ctx) d)

/-! ### issue create / edit -/

def targetOpts : Array Opt := #[
  { name := "target-repo", metavar := some "OWNER/NAME", help := "repository work on the issue targets (with --target-branch)" },
  { name := "target-branch", metavar := some "BRANCH", help := "branch pull requests are opened against (with --target-repo)" }]

def targetOption (p : Parsed) : CliM (Option RepoTarget) := do
  match p.get? "target-repo", p.get? "target-branch" with
  | none, none => pure none
  | some r, some b =>
    match parseRepo r with
    | .ok r => pure (some { repo := r, branch := b })
    | .error e => usageError e
  | _, _ => usageError "--target-repo and --target-branch go together"

/-- Issue ids from a repeatable option; each value may also be a comma-separated list. -/
def idsOption (p : Parsed) (name : String) : CliM (Array IssueId) := do
  let parts := ((p.getAll name).toList.flatMap (·.splitOn ",")).map (·.trimAscii.toString)
    |>.filter (!·.isEmpty)
  parts.toArray.mapM fun s => do return ⟨← parseId s!"--{name}" s⟩

def issueCreateOpts : Array Opt := #[
  { name := "title", short := some 't', metavar := some "TEXT", help := "issue title (required)" },
  { name := "description", short := some 'd', metavar := some "TEXT", help := "description (markdown)" },
  { name := "description-file", metavar := some "FILE", help := "read the description from FILE (- for stdin)" },
  { name := "goal", metavar := some "TEXT", help := "the condition that makes the issue done" },
  { name := "project", metavar := some "ID", help := "create the issue directly under this project" },
  { name := "parent", metavar := some "ID", help := "create it as a sub-issue of this issue (overrides --project)" },
  { name := "depends-on", metavar := some "ID", help := "an issue that must be completed first", repeatable := true },
  { name := "label", metavar := some "NAME", help := "label to put on it", repeatable := true },
  { name := "assignee", metavar := some "WHO", help := "actor to assign (email or display name)", repeatable := true }]
  ++ targetOpts

def issueCreate (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "issue create takes no positional arguments (use --title)"
  let some title := p.get? "title" | usageError "missing --title"
  let parent ← match p.get? "parent", p.get? "project" with
    | some s, _ => some <$> issueIdArg s
    | none, some s => some <$> issueIdArg s
    | none, none => pure none
  let req : CreateRequest := {
    title, description := (← textOption p "description").getD "", goal := (p.get? "goal").getD ""
    parent, target := ← targetOption p, dependencies := ← idsOption p "depends-on"
    labels := (p.getAll "label").toList, assignees := (p.getAll "assignee").toList }
  let labels ← if req.labels.isEmpty then pure #[] else fetchLabels ctx
  let actors ← if req.assignees.isEmpty then pure #[] else fetchActors ctx
  let input ← match planCreate labels actors req with
    | .ok i => pure i
    | .error e => usageError e
  let issue ← call (Client.createIssue ctx.cfg input)
  if ctx.json then outJson (toJson issue)
  else out s!"created issue #{issue.id}: {issue.title}"

def issueEditOpts : Array Opt := #[
  { name := "title", short := some 't', metavar := some "TEXT", help := "new title" },
  { name := "description", short := some 'd', metavar := some "TEXT", help := "new description (the target metadata is kept)" },
  { name := "description-file", metavar := some "FILE", help := "read the new description from FILE (- for stdin)" },
  { name := "goal", metavar := some "TEXT", help := "new goal" },
  { name := "status", metavar := some "STATUS", help := "open | claimed | completed | abandoned" },
  { name := "state", metavar := some "STATE", help := "taxis state: open | closed | completed" },
  { name := "clear-target", help := "remove the issue's own target (it then inherits the project's)" },
  { name := "depends-on", metavar := some "ID", help := "replace the dependency list with these issues", repeatable := true },
  { name := "no-dependencies", help := "clear the dependency list" },
  { name := "parent", metavar := some "ID|none", help := "move the issue under another parent, or detach it" },
  { name := "add-label", metavar := some "NAME", help := "label to add", repeatable := true },
  { name := "remove-label", metavar := some "NAME", help := "label to remove", repeatable := true },
  { name := "add-assignee", metavar := some "WHO", help := "actor to assign (email or display name)", repeatable := true },
  { name := "remove-assignee", metavar := some "WHO", help := "actor to unassign", repeatable := true }]
  ++ targetOpts

def issueEdit (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let status ← (p.get? "status").mapM fun s => match Status.ofString? s with
    | some st => pure st
    | none => usageError s!"--status must be open, claimed, completed or abandoned, got '{s}'"
  let state ← (p.get? "state").mapM fun s => match IssueState.ofString? s with
    | some st => pure st
    | none => usageError s!"--state must be open, closed or completed, got '{s}'"
  let target ← do
    let t ← targetOption p
    if p.has "clear-target" then
      if t.isSome then usageError "--clear-target conflicts with --target-repo/--target-branch"
      pure (some none)
    else pure (t.map some)
  let deps ← do
    if p.has "no-dependencies" then
      if p.has "depends-on" then usageError "--no-dependencies conflicts with --depends-on"
      pure (some #[])
    else if p.has "depends-on" then some <$> idsOption p "depends-on"
    else pure none
  let parent ← (p.get? "parent").mapM fun s =>
    if s == "none" then pure none else some <$> issueIdArg s
  let req : EditRequest := {
    title := p.get? "title", description := ← textOption p "description", goal := p.get? "goal"
    status, state, target, dependencies := deps, parent
    addLabels := (p.getAll "add-label").toList, removeLabels := (p.getAll "remove-label").toList
    addAssignees := (p.getAll "add-assignee").toList
    removeAssignees := (p.getAll "remove-assignee").toList }
  let current ← call (Client.getIssue ctx.cfg id)
  let labels ← fetchLabels ctx
  let actors ← if req.addAssignees.isEmpty && req.removeAssignees.isEmpty then pure #[]
    else fetchActors ctx
  let upd ← match planEdit current labels actors req with
    | .ok u => pure u
    | .error e => usageError e
  if upd.isEmpty then usageError "nothing to change: name at least one field to edit"
  let issue ← call (Client.updateIssue ctx.cfg id upd)
  if ctx.json then outJson (toJson issue)
  else out s!"updated issue #{issue.id}: {issueLine labels issue}"

/-! ### comments -/

def issueCommentOpts : Array Opt := #[
  { name := "body", short := some 'b', metavar := some "TEXT", help := "comment text (markdown); or give it as the second argument" },
  { name := "body-file", metavar := some "FILE", help := "read the comment from FILE (- for stdin)" },
  { name := "approve", help := "post it as an approving review" },
  { name := "request-changes", help := "post it as a review requesting changes" }]

def issueComment (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let (idStr, inline?) ← match p.positional.toList with
    | [i] => pure (i, none)
    | [i, b] => pure (i, some b)
    | [] => usageError "missing issue id"
    | _ => usageError "too many arguments (quote the comment text)"
  let id ← issueIdArg idStr
  let fromOpt ← textOption p "body"
  let body ← match inline?, fromOpt with
    | some _, some _ => usageError "give the comment as an argument or with --body, not both"
    | some b, none | none, some b => pure b
    | none, none => if p.has "approve" then pure "" else usageError "missing comment text"
  let review ← match p.has "approve", p.has "request-changes" with
    | true, true => usageError "--approve and --request-changes are exclusive"
    | true, false => pure (some ReviewState.approve)
    | false, true => pure (some ReviewState.requestChanges)
    | false, false => pure none
  let c ← call (Client.createComment ctx.cfg id body review)
  if ctx.json then outJson (toJson c)
  else out s!"commented on issue #{id} (comment {c.id})"

def issueComments (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let cs ← call (Client.listComments ctx.cfg id)
  if ctx.json then outJson (toJson cs)
  else if cs.isEmpty then out s!"No comments on issue #{id}."
  else for c in cs do out (renderDetail.renderComment c)

/-! ### claims -/

def taskOpts : Array Opt := #[
  { name := "task", metavar := some "ID", help := "task id recorded on the claim (default $TAXIS_TASK_ID, else 'taxis-cli')" }]

def taskIdOf (p : Parsed) : CliM String := do
  match p.get? "task" with
  | some t => pure t
  | none => pure (((← IO.getEnv "TAXIS_TASK_ID").filter (!·.isEmpty)).getD "taxis-cli")

/-- Refuse when the issue is claimed by a task other than this one. -/
def checkHolder (claims : Array Claim) (task : String) (id : IssueId) (what : String) :
    CliM Unit := do
  if let some c := claims.find? (·.taskId != task) then
    failWith s!"cannot {what} #{id}: it is claimed by task {c.taskId}, not {task} (pass --task {c.taskId} if that is you)"

/-- Delete every claim artifact, and set the labels and (optionally) state the release implies. -/
def dropClaim (ctx : Ctx) (labels : Array Label) (d : IssueDetail)
    (newState : Option IssueState) : CliM Bool := do
  let claims := claimsOf d.attachedArtifacts
  for c in claims do
    let _ ← call (Client.deleteArtifact ctx.cfg c.artifact)
  let claimedId := labelIdNamed labels claimedLabel
  let hasLabel := claimedId.any d.issue.labels.contains
  let upd : IssueUpdate := {
    labels := if hasLabel then some (d.issue.labels.filter (some · != claimedId)) else none
    state := newState.filter (· != d.issue.state) }
  unless upd.isEmpty do
    let _ ← call (Client.updateIssue ctx.cfg d.issue.id upd)
  return !claims.isEmpty || hasLabel

def issueClaimOpts : Array Opt := taskOpts ++ #[
  { name := "agent", metavar := some "NAME", help := "agent backend recorded on the claim (default $TAXIS_AGENT, else 'cli')" },
  { name := "series", metavar := some "NAME", help := "series recorded on the claim" }]

def issueClaim (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let task ← taskIdOf p
  let agent ← match p.get? "agent" with
    | some a => pure a
    | none => pure (((← IO.getEnv "TAXIS_AGENT").filter (!·.isEmpty)).getD "cli")
  let labels ← fetchLabels ctx
  let some claimedId := labelIdNamed labels claimedLabel
    | failWith s!"the tracker has no '{claimedLabel}' label; an administrator must create it before issues can be claimed"
  let d ← fetchDetail ctx id
  let reply (ok : Bool) (fields : List (String × Json)) (text : String) : CliM Unit := do
    if ctx.json then outJson (Json.mkObj ([("ok", Json.bool ok), ("issue_id", toJson id)] ++ fields))
    else if ok then out text else IO.eprintln text
    unless ok do throw (.error "")
  if d.issue.state != .open then
    reply false [("error", "not_open"), ("state", toJson d.issue.state)]
      s!"cannot claim #{id}: it is {d.issue.state}, not open"
  if let some c := (claimsOf d.attachedArtifacts)[0]? then
    reply false [("error", "already_claimed"), ("held_by_task", Json.str c.taskId)]
      s!"cannot claim #{id}: already claimed by task {c.taskId} ({c.agent}, since {c.claimedAt})"
  let art ← call (Client.createArtifact ctx.cfg id "session"
    (sessionPayload task agent (← nowIso) (p.get? "series")))
  unless d.issue.labels.contains claimedId do
    match ← Client.updateIssue ctx.cfg id { labels := some (d.issue.labels.push claimedId) } with
    | .ok _ => pure ()
    | .error e =>
      -- Do not leave a half-taken claim behind.
      let _ ← Client.deleteArtifact ctx.cfg art.id
      failWith e
  let project ← projectOf ctx labels d
  let target := effectiveTarget d.issue project
  reply true [("task_id", Json.str task), ("project_id", toJson (project.map (·.id))),
      ("target", Json.str ((target.map (·.render)).getD ""))]
    s!"claimed #{id} for task {task}{(target.map (s!"; target {·.render}")).getD ""}"

def issueReleaseOpts : Array Opt := #[
  { name := "reason", short := some 'r', metavar := some "TEXT", help := "why the claim is released (echoed back)" },
  { name := "keep-state", help := "only drop the claim; do not reopen the issue" }]

def issueRelease (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let labels ← fetchLabels ctx
  let d ← fetchDetail ctx id
  let had ← dropClaim ctx labels d (if p.has "keep-state" then none else some .open)
  let reason := (p.get? "reason").map (s!" ({·})") |>.getD ""
  if ctx.json then
    outJson (Json.mkObj [("ok", true), ("issue_id", toJson id), ("released", Json.bool had)])
  else if had then out s!"released claim on #{id}{reason}"
  else out s!"#{id} was not claimed{reason}"

/-! ### review decisions -/

def issueDecideOpts : Array Opt := #[
  { name := "notes", short := some 'n', metavar := some "TEXT", help := "review notes, posted as a review comment (required)" },
  { name := "notes-file", metavar := some "FILE", help := "read the notes from FILE (- for stdin)" }]

def issueDecide (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let (idStr, decision) ← match p.positional.toList with
    | [i, d] => pure (i, d)
    | _ => usageError "expected ID and a decision (approve | complete | reject)"
  let id ← issueIdArg idStr
  let some notes ← textOption p "notes" | usageError "missing --notes"
  let labels ← fetchLabels ctx
  let d ← fetchDetail ctx id
  let (review, newState, text) ← match decision with
    | "approve" =>
      if (pullRequestsOf d.attachedArtifacts).isEmpty then
        failWith s!"cannot approve #{id}: it has no attached pull request (use `complete` to finish it without one)"
      pure (ReviewState.approve, none,
        s!"approved #{id}; the issue stays open — use `decide {id} complete` when the work is finished")
    | "complete" => pure (ReviewState.approve, some IssueState.completed, s!"completed #{id}")
    | "reject" => pure (ReviewState.requestChanges, some IssueState.open, s!"rejected #{id}; it is open again")
    | other => usageError s!"decision must be approve, complete or reject, got '{other}'"
  let c ← call (Client.createComment ctx.cfg id notes (some review))
  if let some st := newState then
    let _ ← dropClaim ctx labels d (some st)
  if ctx.json then
    outJson (Json.mkObj [("ok", true), ("issue_id", toJson id), ("decision", Json.str decision),
      ("comment_id", toJson c.id)])
  else out text

/-! ### split -/

def issueSplitOpts : Array Opt := taskOpts ++ #[
  { name := "reason", short := some 'r', metavar := some "TEXT", help := "why the issue is split (posted as a comment)" },
  { name := "child", metavar := some "TITLE", help := "a sub-issue to create", repeatable := true },
  { name := "child-description", metavar := some "TEXT", help := "description of the --child before it", repeatable := true },
  { name := "children-file", metavar := some "FILE", help := "JSON array of {title, description, target_repo?, target_branch?} (- for stdin)" }]

def issueSplit (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let fromOpts ← match childrenFromOptions p.options with
    | .ok cs => pure cs
    | .error e => usageError e
  let fromFile ← match ← textOption p "children" with
    | none => pure #[]
    | some text => match Json.parse text >>= childrenFromJson with
      | .ok cs => pure cs
      | .error e => usageError s!"--children-file: {e}"
  let children := fromOpts ++ fromFile
  if children.isEmpty then usageError "give at least one --child (or --children-file)"
  let task ← taskIdOf p
  let labels ← fetchLabels ctx
  let d ← fetchDetail ctx id
  checkHolder (claimsOf d.attachedArtifacts) task id "split"
  let inherited := targetOf d.issue.description
  let mut created : Array Issue := #[]
  for c in children do
    let input : IssueInput := {
      title := c.title, parent := some id
      description := replaceTarget c.description ((c.target <|> inherited).map some) }
    created := created.push (← call (Client.createIssue ctx.cfg input))
  if let some r := p.get? "reason" then
    let list := ", ".intercalate (created.map (s!"#{·.id}")).toList
    let _ ← call (Client.createComment ctx.cfg id s!"Split into {list}: {r}")
  -- The children are now the work; the parent keeps its state and loses its claim.
  let _ ← dropClaim ctx labels d none
  if ctx.json then
    outJson (Json.mkObj [("ok", true), ("parent_id", toJson id),
      ("created", toJson (created.map (·.id)))])
  else
    out s!"split #{id} into {created.size} sub-issue(s); its claim is released"
    for c in created do out s!"  #{c.id}  {c.title}"

/-! ### attach-pr -/

def issueAttachPrOpts : Array Opt := taskOpts ++ #[
  { name := "repo", metavar := some "OWNER/NAME", help := "repository of the pull request (required)" },
  { name := "number", metavar := some "N", help := "pull request number (required)" },
  { name := "branch", metavar := some "BRANCH", help := "head branch of the pull request (required)" }]

def issueAttachPr (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let some repo := p.get? "repo" | usageError "missing --repo"
  let repo ← match parseRepo repo with | .ok r => pure r | .error e => usageError e
  let some numS := p.get? "number" | usageError "missing --number"
  let number ← natArg "--number" (if numS.startsWith "#" then (numS.drop 1).toString else numS)
  let some branch := p.get? "branch" | usageError "missing --branch"
  let task ← taskIdOf p
  let d ← fetchDetail ctx id
  checkHolder (claimsOf d.attachedArtifacts) task id "attach a pull request to"
  let taskRec := if p.has "task" || (← IO.getEnv "TAXIS_TASK_ID").isSome then some task else none
  let art ← call (Client.createArtifact ctx.cfg id "github-pr" (prPayload repo number branch taskRec))
  if ctx.json then outJson (toJson art)
  else out s!"attached {repo}#{number} to #{id}; it is now awaiting review"

/-! ### context notes -/

def contextList (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let d ← fetchDetail ctx id
  let notes := contextNotesOf d.attachedArtifacts
  if ctx.json then
    outJson (Json.arr (d.attachedArtifacts.filter (·.kind == "context") |>.map toJson))
  else if notes.isEmpty then out s!"No context notes on issue #{id}."
  else for n in notes do out s!"[{n.id}] {n.title}\n{indent n.text}"

def contextTextOpts : Array Opt := #[
  { name := "title", short := some 't', metavar := some "TEXT", help := "the note's one-line title" },
  { name := "text", metavar := some "TEXT", help := "the note itself (markdown)" },
  { name := "text-file", metavar := some "FILE", help := "read the text from FILE (- for stdin)" }]

def contextAdd (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "issue id")
  let some title := (p.get? "title").filter (!·.trimAscii.isEmpty)
    | usageError "missing --title: it is the only part of a note shown before it is unfolded"
  let some text := (← textOption p "text").filter (!·.trimAscii.isEmpty)
    | usageError "missing --text (or --text-file)"
  let art ← call (Client.createArtifact ctx.cfg id "context" (contextPayload title text))
  if ctx.json then outJson (toJson art)
  else out s!"context note {art.id} attached to #{id}"

def contextUpdate (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let (idStr, noteStr) ← match p.positional.toList with
    | [i, n] => pure (i, n)
    | _ => usageError "expected ISSUE_ID and NOTE_ID"
  let id ← issueIdArg idStr
  let noteId : ArtifactId := ⟨← parseId "note id" noteStr⟩
  let title := p.get? "title"
  let text ← textOption p "text"
  if title.isNone && text.isNone then usageError "give --title and/or --text"
  let d ← fetchDetail ctx id
  -- Checked against the issue named: an artifact id is tracker-wide.
  let some note := (contextNotesOf d.attachedArtifacts).find? (·.id == noteId)
    | failWith s!"issue #{id} has no context note {noteId} (`taxis context list {id}` shows its notes)"
  let title := title.getD note.title
  let text := text.getD note.text
  if title.trimAscii.isEmpty || text.trimAscii.isEmpty then usageError "a note needs a title and text"
  let art ← call (Client.updateArtifact ctx.cfg noteId (contextPayload title text) (kind := some "context"))
  if ctx.json then outJson (toJson art)
  else out s!"context note {noteId} on #{id} rewritten"

/-! ### labels, actors, projects, me -/

def labelList (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "label list takes no arguments"
  let ls ← fetchLabels ctx
  if ctx.json then outJson (toJson ls)
  else if ls.isEmpty then out "The tracker defines no labels."
  else for l in ls do out s!"{l.name}{(l.description.map (s!"  — {·}")).getD ""}"

def actorList (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "actor list takes no arguments"
  let as ← fetchActors ctx
  if ctx.json then outJson (toJson as)
  else if as.isEmpty then out "The tracker knows no actors."
  else for a in as do
    out s!"{a.email}  ({a.displayName}){if a.bot then "  [bot]" else ""}{if a.admin then "  [admin]" else ""}"

def whoami (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "whoami takes no arguments"
  let a ← call (Client.getMe ctx.cfg)
  if ctx.json then outJson (toJson a)
  else out s!"{a.displayName} <{a.email}>{if a.bot then "  [bot]" else ""}{if a.admin then "  [admin]" else ""}"

def projectList (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "project list takes no arguments"
  let labels ← fetchLabels ctx
  let projects ← match labelIdNamed labels projectLabel with
    | none => pure #[]
    | some l => call (Client.listIssues ctx.cfg (label := some l))
  let projects := projects.qsort (fun a b => a.id.val > b.id.val)
  if ctx.json then outJson (toJson projects)
  else if projects.isEmpty then out "No projects."
  else for pr in projects do
    out s!"#{pr.id}  {pr.title}  default={((targetOf pr.description).map (·.render)).getD "-"}  [{pr.state}]"

def projectCreateOpts : Array Opt := #[
  { name := "title", short := some 't', metavar := some "TEXT", help := "project name (required)" },
  { name := "description", short := some 'd', metavar := some "TEXT", help := "description (markdown)" },
  { name := "description-file", metavar := some "FILE", help := "read the description from FILE (- for stdin)" },
  { name := "parent", metavar := some "ID", help := "place the project under this issue" }]
  ++ targetOpts

def projectCreate (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "project create takes no positional arguments (use --title)"
  let some title := (p.get? "title").filter (!·.trimAscii.isEmpty) | usageError "missing --title"
  let labels ← fetchLabels ctx
  let some pl := labelIdNamed labels projectLabel
    | failWith s!"the tracker has no '{projectLabel}' label; an administrator must create it first"
  let description := replaceTarget ((← textOption p "description").getD "") ((← targetOption p).map some)
  let issue ← call (Client.createIssue ctx.cfg
    { title, description, labels := #[pl], parent := ← optIssueId p "parent" })
  if ctx.json then outJson (toJson issue)
  else out s!"created project #{issue.id}: {issue.title}"

def projectShow (ctx : Ctx) (p : Parsed) : CliM Unit := do
  let id ← issueIdArg (← onePositional p "project id")
  let labels ← fetchLabels ctx
  let d ← fetchDetail ctx id
  let all ← call (Client.listIssues ctx.cfg)
  let issues := descendantsOf all id
  if ctx.json then
    outJson (Json.mkObj [("project", toJson d.issue), ("issues", toJson issues)])
    return
  let pr := d.issue
  let isProject := (labelIdNamed labels projectLabel).any pr.labels.contains
  let count (st : Status) := (issues.filter (statusIn labels · == st)).size
  let (human, m) := decodeMeta pr.description
  let mut lines : Array String := #[
    s!"#{pr.id}  {pr.title}{if isProject then "" else s!"  (not labelled {projectLabel})"}",
    s!"default target: {((targetOf pr.description).map (·.render)).getD "-"}",
    s!"issues: {issues.size} — {count .open} open, {count .claimed} claimed, {count .completed} completed, {count .abandoned} abandoned"]
  if let .ok r := m.getObjVal? "reviewer" then lines := lines.push s!"reviewer: {r.compress}"
  if !human.trimAscii.isEmpty then
    lines := lines ++ #["description:", indent human]
  let topLevel := issues.filter (·.parent == some id)
  if !topLevel.isEmpty then
    lines := lines.push "top-level issues:"
    lines := lines ++ topLevel.map (s!"  {issueLine labels ·}")
  out ("\n".intercalate lines.toList)

def configShow (ctx : Ctx) (p : Parsed) : CliM Unit := do
  unless p.positional.isEmpty do usageError "config takes no arguments"
  let s := ctx.settings
  let masked := s.token.map fun t => if t.length ≤ 8 then "(set)" else s!"{(t.take 4).toString}…"
  if ctx.json then
    outJson (Json.mkObj [("url", Json.str s.url), ("urlSource", Json.str s.urlSource),
      ("tokenSet", Json.bool s.token.isSome), ("tokenSource", Json.str s.tokenSource),
      ("configPath", toJson (s.configPath.map (·.toString)))])
  else
    out s!"url:    {s.url}  (from {s.urlSource})"
    out s!"token:  {masked.getD "none"}  (from {s.tokenSource})"
    out s!"config: {(s.configPath.map (·.toString)).getD "-"}"

/-! ## The command table -/

def commands : List Command := [
  { path := ["issue", "list"], summary := "List issues, filtered"
    details := "Without filters lists every issue the token can see. --project walks the parent tree; --status reads the claim label (open = open and unclaimed). Combine --project, --status open and --target-repo to find work to pick up; --in-review lists open issues with an attached pull request."
    opts := issueListOpts, run := issueList
    endpoints := ["GET /api/labels", "GET /api/issues?state=&label=&q=&parent=&assignee=", "GET /api/actors (--assignee)", "GET /api/issues/:id (--target-repo, --in-review)"] },
  { path := ["issue", "show"], args := "ID", summary := "Show an issue: status, claim, target, PRs, children, notes, comments"
    run := issueShow, endpoints := ["GET /api/issues/:id", "GET /api/labels", "GET /api/issues?parent=:id", "GET /api/issues/:ancestor (project lookup)"] },
  { path := ["issue", "create"], summary := "Create an issue (a sub-issue with --parent)"
    opts := issueCreateOpts, run := issueCreate
    endpoints := ["POST /api/issues", "GET /api/labels (--label)", "GET /api/actors (--assignee)"] },
  { path := ["issue", "edit"], args := "ID", summary := "Change an issue's fields, status, target, dependencies, labels or assignees"
    details := "Only the fields named change. Labels and assignees are added/removed one by one; the rest of the set is kept. o-claimed and t-project cannot be set by hand — use claim/release."
    opts := issueEditOpts, run := issueEdit
    endpoints := ["GET /api/issues/:id", "GET /api/labels", "GET /api/actors (assignees)", "PATCH /api/issues/:id"] },
  { path := ["issue", "comment"], args := "ID [TEXT]", summary := "Comment on an issue (optionally as a review)"
    opts := issueCommentOpts, run := issueComment, endpoints := ["POST /api/issues/:id/comments"] },
  { path := ["issue", "comments"], args := "ID", summary := "Read an issue's comment thread"
    run := issueComments, endpoints := ["GET /api/issues/:id/comments"] },
  { path := ["issue", "claim"], args := "ID", summary := "Claim an open issue for a task"
    details := "Records a `session` artifact and the o-claimed label. Fails (exit 1, `already_claimed` with --json) when another task holds it. Prints the effective target."
    opts := issueClaimOpts, run := issueClaim
    endpoints := ["GET /api/labels", "GET /api/issues/:id", "POST /api/issues/:id/artifacts", "PATCH /api/issues/:id"] },
  { path := ["issue", "release"], args := "ID", summary := "Release a claim, returning the issue to the open pool"
    opts := issueReleaseOpts, run := issueRelease
    endpoints := ["GET /api/labels", "GET /api/issues/:id", "DELETE /api/artifacts/:id", "PATCH /api/issues/:id"] },
  { path := ["issue", "decide"], args := "ID approve|complete|reject", summary := "Record a review decision"
    details := "approve: posts an approving review; the issue stays open (merging is the orchestrator's job). complete: approving review, issue completed, claim dropped. reject: review requesting changes, issue reopened, claim dropped."
    opts := issueDecideOpts, run := issueDecide
    endpoints := ["GET /api/labels", "GET /api/issues/:id", "POST /api/issues/:id/comments", "DELETE /api/artifacts/:id", "PATCH /api/issues/:id"] },
  { path := ["issue", "split"], args := "ID", summary := "Decompose an issue into sub-issues and release its claim"
    details := "Each child is created under ID and inherits ID's target unless its spec names one. Refused when another task holds the claim."
    opts := issueSplitOpts, run := issueSplit
    endpoints := ["GET /api/labels", "GET /api/issues/:id", "POST /api/issues", "POST /api/issues/:id/comments (--reason)", "DELETE /api/artifacts/:id", "PATCH /api/issues/:id"] },
  { path := ["issue", "attach-pr"], args := "ID", summary := "Attach a pull request to an issue (puts it in review)"
    opts := issueAttachPrOpts, run := issueAttachPr
    endpoints := ["GET /api/issues/:id", "POST /api/issues/:id/artifacts"] },
  { path := ["context", "list"], args := "ID", summary := "Read an issue's context notes in full"
    run := contextList, endpoints := ["GET /api/issues/:id"] },
  { path := ["context", "add"], args := "ID", summary := "Attach a context note to an issue"
    opts := contextTextOpts, run := contextAdd, endpoints := ["POST /api/issues/:id/artifacts"] },
  { path := ["context", "update"], args := "ID NOTE_ID", summary := "Rewrite a context note in place (unnamed fields are kept)"
    opts := contextTextOpts, run := contextUpdate
    endpoints := ["GET /api/issues/:id", "PATCH /api/artifacts/:note_id"] },
  { path := ["label", "list"], summary := "List the labels the tracker defines"
    run := labelList, endpoints := ["GET /api/labels"] },
  { path := ["project", "list"], summary := "List projects (issues labelled t-project)"
    run := projectList, endpoints := ["GET /api/labels", "GET /api/issues?label=:t-project"] },
  { path := ["project", "create"], summary := "Create a project (an issue labelled t-project) with a default target"
    details := "Its target is the default its issues inherit; change it later with `taxis issue edit ID --target-repo … --target-branch …`."
    opts := projectCreateOpts, run := projectCreate
    endpoints := ["GET /api/labels", "POST /api/issues"] },
  { path := ["project", "show"], args := "ID", summary := "Show a project: default target, issue counts, top-level issues"
    run := projectShow, endpoints := ["GET /api/labels", "GET /api/issues/:id", "GET /api/issues"] },
  { path := ["actor", "list"], summary := "List actors (people and bots) by email"
    run := actorList, endpoints := ["GET /api/actors"] },
  { path := ["whoami"], summary := "Show the actor the configured token authenticates as"
    run := whoami, endpoints := ["GET /api/me"] },
  { path := ["config"], summary := "Show the resolved server URL and where the token comes from"
    run := configShow }]

/-! ## Help -/

def Command.synopsis (c : Command) : String :=
  let args := if c.args.isEmpty then "" else " " ++ c.args
  s!"taxis {" ".intercalate c.path}{args} [options]"

def Command.help (c : Command) : String :=
  let parts : List String := [
    s!"Usage: {c.synopsis}", "", c.summary ++ "." ] ++
    (if c.details.isEmpty then [] else ["", c.details]) ++
    (if c.opts.isEmpty then [] else ["", "Options:", renderOpts c.opts]) ++
    ["", "Global options:", renderOpts globalOpts] ++
    (if c.endpoints.isEmpty then [] else ["", "Calls:"] ++ c.endpoints.map ("  " ++ ·))
  "\n".intercalate parts

def topHelp : String :=
  let width := commands.foldl (fun w c => max w (" ".intercalate c.path ++ " " ++ c.args).length) 0
  let rows := commands.map fun c =>
    let l := " ".intercalate c.path ++ (if c.args.isEmpty then "" else " " ++ c.args)
    s!"  {l}{"".pushn ' ' (width - l.length + 2)}{c.summary}"
  "\n".intercalate ([
    "taxis — command-line client for a taxis issue tracker",
    "",
    "Usage: taxis <command> [arguments] [options]",
    "       taxis serve [--config FILE] [-v]     run the taxis server",
    "",
    "Commands:"] ++ rows ++ [
    "",
    "Global options:", renderOpts globalOpts,
    "",
    "Configuration: ~/.config/taxis/config.toml (url = \"…\", token = \"…\"), or TAXIS_URL /",
    "TAXIS_TOKEN, or --url / --token. The token is sent as `Authorization: Bearer <token>`.",
    "Requests go through curl, so HTTPS_PROXY/NO_PROXY and CURL_CA_BUNDLE/SSL_CERT_FILE apply.",
    "",
    "Run `taxis <command> --help` for a command's options."])

def nounHelp (noun : String) : String :=
  let cs := commands.filter (·.path.head? == some noun)
  "\n".intercalate ([s!"Usage: taxis {noun} <command> [arguments] [options]", "", "Commands:"] ++
    cs.map (fun c => s!"  {c.synopsis}\n      {c.summary}") ++
    ["", s!"Run `taxis {noun} <command> --help` for a command's options."])

/-- The words that start a client command (anything else is the server). -/
def nouns : List String := (commands.filterMap (·.path.head?)).eraseDups ++ ["help"]

/-! ## Entry point -/

/-- What the command line asks for. -/
inductive Invocation where
  | help (text : String)
  | run (cmd : Command) (parsed : Parsed)
  | usage (msg : String) (help : String)

/-- Global options may precede the command words: split them off. -/
def splitLeading (args : List String) : Array String × List String :=
  go args #[] (args.length + 1)
where
  go (xs : List String) (acc : Array String) : Nat → Array String × List String
    | 0 => (acc, xs)
    | n + 1 =>
      match xs with
      | [] => (acc, [])
      | x :: rest =>
        if x == "--json" || x == "--help" || x == "-h" then go rest (acc.push x) n
        else if x == "--url" || x == "--token" || x == "--config" then
          match rest with
          | v :: rest' => go rest' (acc.push x |>.push v) n
          | [] => (acc.push x, [])
        else if x.startsWith "--url=" || x.startsWith "--token=" || x.startsWith "--config=" then
          go rest (acc.push x) n
        else (acc, xs)

/-- Whether `args` ask for the client rather than the server: the first word after any leading
    global options is a client command, or the arguments are just `--help`. -/
def isClientInvocation (args : List String) : Bool :=
  match splitLeading args with
  | (_, w :: _) => nouns.contains w
  | (pre, []) => pre.contains "--help" || pre.contains "-h"

/-- Split leading global options off, find the command, and parse the rest. Pure. -/
def parseInvocation (args : List String) : Invocation := Id.run do
  let (pre, words) := splitLeading args
  match words with
  | [] => return .help topHelp
  | "help" :: rest =>
    match commands.find? (·.path == rest) with
    | some c => return .help c.help
    | none =>
      if let [n] := rest then
        if commands.any (·.path.head? == some n) then return .help (nounHelp n)
      return .help topHelp
  | _ =>
    let found := commands.filter fun c => c.path == words.take c.path.length
    match found.foldl (fun best c => match best with
      | some b => if c.path.length > b.path.length then some c else some b
      | none => some c) none with
    | none =>
      match words with
      | n :: rest =>
        if commands.any (·.path.head? == some n) then
          if rest.isEmpty || rest.head? == some "--help" || rest.head? == some "-h" then
            return .help (nounHelp n)
          return .usage s!"unknown command: {n} {rest.head?.getD ""}" (nounHelp n)
        return .usage s!"unknown command: {n}" topHelp
      | [] => return .help topHelp
    | some c =>
      let rest := pre.toList ++ words.drop c.path.length
      match parseArgs (c.opts ++ globalOpts) rest with
      | .error e => return .usage e c.help
      | .ok parsed =>
        if parsed.has "help" then return .help c.help
        return .run c parsed

/-- Run the client on `args`; returns the exit code. -/
def main (args : List String) : IO UInt32 := do
  match parseInvocation args with
  | .help text => IO.println text; return 0
  | .usage msg help =>
    IO.eprintln s!"taxis: {msg}"
    IO.eprintln ""
    IO.eprintln help
    return 2
  | .run cmd parsed =>
    let settings ← match ← loadSettings (parsed.get? "config") (parsed.get? "url") (parsed.get? "token") with
      | .ok s => pure s
      | .error e => IO.eprintln s!"taxis: {e}"; return 1
    let ctx : Ctx := { settings, json := parsed.has "json" }
    match ← (cmd.run ctx parsed).run with
    | .ok () => return 0
    | .error (.usage msg) =>
      IO.eprintln s!"taxis: {msg}"
      IO.eprintln s!"Usage: {cmd.synopsis}  (see --help)"
      return 2
    | .error (.error msg) =>
      unless msg.isEmpty do IO.eprintln s!"taxis: {msg}"
      return 1

end Taxis.Cli
