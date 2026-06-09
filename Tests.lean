import Issues

/-!
# Test suite

A self-contained test executable exercising JSON round-trips, the database layer (against a
temporary SQLite file), the plugin registry, and the visibility filter. Exits non-zero if any
check fails, so it works as `lake test` and in CI.
-/

open Lean Issues Issues.Db Issues.Server

private def roundtrips [ToJson α] [FromJson α] [BEq α] (x : α) : Bool :=
  match (fromJson? (toJson x) : Except String α) with
  | .ok y => x == y
  | .error _ => false

def main : IO Unit := do
  let failures ← IO.mkRef 0
  let check (name : String) (cond : Bool) : IO Unit := do
    if cond then IO.println s!"  ok  {name}"
    else IO.println s!"  FAIL {name}"; failures.modify (· + 1)

  IO.println "JSON round-trips"
  check "actor" (roundtrips ({ id := ⟨1⟩, email := "a@x", displayName := "A", groups := #[⟨2⟩] } : Actor))
  check "group" (roundtrips ({ id := ⟨1⟩, name := "g", description := some "d" } : Group))
  check "issue-state open" (roundtrips IssueState.open)
  check "issue-state completed" (roundtrips IssueState.completed)
  check "check-status" (roundtrips CheckStatus.passing)
  check "id-as-number" ((toJson (ActorId.mk 7)).compress == "7")
  check "state-as-string" ((toJson IssueState.closed).compress == "\"closed\"")

  IO.println "Database layer"
  let path : System.FilePath := "/tmp/issues-selftest.sqlite"
  for suffix in ["", "-wal", "-shm"] do
    try IO.FS.removeFile (path.toString ++ suffix) catch _ => pure ()
  let db ← connect path
  migrate db

  let g ← createGroup db { name := "core" }
  check "group created" (g.name == "core")
  let a ← createActor db { email := "a@x.io", displayName := "Alice", groups := #[g.id] }
  check "actor has group" (a.groups == #[g.id])
  check "actor lookup by email" ((← getActorByEmail db "a@x.io").isSome)
  check "actor not admin by default" (a.admin == false)
  setActorAdmin db a.id true
  check "actor admin set" (((← getActor db a.id).map (·.admin)) == some true)

  let bug ← createLabel db { name := "bug", description := some "a defect", color := some "#e11d48" }
  check "label created" (bug.name == "bug")
  check "label color stored" (bug.color == "#e11d48")
  check "label default color" ((← createLabel db { name := "chore" }).color == "#6b7280")
  let parent ← createIssue db { title := "Parent" }
  let child ← createIssue db { title := "Child", parents := #[parent.id], assignees := #[a.id], labels := #[bug.id] }
  check "child has parent" (child.parents == #[parent.id])
  check "child has assignee" (child.assignees == #[a.id])
  check "child has label" (child.labels == #[bug.id])
  check "label lookup by name" ((← getOrCreateLabelByName db "bug") == bug.id)

  -- locking
  let _ ← updateIssue db child.id { locked := some true }
  check "issue locked" (((← getIssue db child.id).map (·.locked)) == some true)
  let lockTitle ←
    try let _ ← updateIssue db child.id { title := some "renamed" }; pure false
    catch e => pure ((validationMessage? e).isSome)
  check "locked title change rejected" lockTitle
  let lockAssignee ←
    try let _ ← updateIssue db child.id { assignees := some #[] }; pure true
    catch _ => pure false
  check "locked allows assignee change" lockAssignee
  let _ ← updateIssue db child.id { locked := some false }

  -- cycle detection
  let cyclic ←
    try let _ ← updateIssue db parent.id { parents := some #[child.id] }; pure false
    catch _ => pure true
  check "cycle rejected" cyclic

  -- search + filter
  let found ← listIssues db none none (some "Child") none
  check "search finds child" (found.any (·.title == "Child"))
  let openOnly ← listIssues db (some .open) none none none
  check "state filter" (openOnly.size == 2)

  -- artifacts + checks
  let art ← createArtifact db child.id { kind := "github-branch", payload := Json.mkObj [("owner", "o"), ("repo", "r"), ("branch", "main")] }
  check "artifact attached" (art.kind == "github-branch")
  let chk ← createCheck db child.id { kind := "github-ci" }
  check "check pending" (chk.status == .pending)
  recordCheckResult db chk.id .passing (some "ok")
  check "check result recorded" (((← getCheck db chk.id).map (·.status)) == some .passing)

  -- delete cascade
  check "delete issue" (← deleteIssue db child.id)
  check "artifacts gone after cascade" ((← issueArtifacts db child.id).isEmpty)

  IO.println "Plugin registry"
  check "github-branch registered" ((← Plugins.artifactHandler? "github-branch").isSome)
  check "github-ci registered" ((← Plugins.checkHandler? "github-ci").isSome)
  check "unknown kind absent" ((← Plugins.artifactHandler? "nope").isNone)
  match ← Plugins.artifactHandler? "github-branch" with
  | some h =>
    check "valid payload accepted" (h.validate (Json.mkObj [("owner", "o"), ("repo", "r"), ("branch", "b")]) |>.toOption |>.isSome)
    check "invalid payload rejected" (h.validate (Json.mkObj [("owner", "o")]) |>.toOption |>.isNone)
  | none => check "handler present" false

  IO.println "Visibility"
  let pub : Issue := { id := ⟨1⟩, title := "p", visibility := #[], createdAt := ⟨0⟩, updatedAt := ⟨0⟩ }
  let priv : Issue := { pub with visibility := #[⟨5⟩] }
  let member : Actor := { id := ⟨1⟩, email := "", displayName := "", groups := #[⟨5⟩] }
  let outsider : Actor := { member with groups := #[⟨9⟩] }
  check "public visible to anon" (visibleTo none pub)
  check "private hidden from anon" (!visibleTo none priv)
  check "private visible to member" (visibleTo (some member) priv)
  check "private hidden from outsider" (!visibleTo (some outsider) priv)

  let n ← failures.get
  IO.println ""
  if n > 0 then
    IO.eprintln s!"{n} test(s) failed"
    IO.Process.exit 1
  else
    IO.println "all tests passed"
