import Taxis

/-!
# Test suite

A self-contained test executable exercising JSON round-trips, the database layer (against a
temporary SQLite file), the plugin registry, and the visibility filter. Exits non-zero if any
check fails, so it works as `lake test` and in CI.
-/

open Lean Taxis Taxis.Db Taxis.Server

private def roundtrips [ToJson α] [FromJson α] [BEq α] (x : α) : Bool :=
  match (fromJson? (toJson x) : Except String α) with
  | .ok y => x == y
  | .error _ => false

set_option maxRecDepth 4000 in
def main : IO Unit := do
  let failures ← IO.mkRef 0
  let check (name : String) (cond : Bool) : IO Unit := do
    if cond then IO.println s!"  ok  {name}"
    else IO.println s!"  FAIL {name}"; failures.modify (· + 1)

  IO.println "JSON round-trips"
  check "actor" (roundtrips ({ id := ⟨1⟩, email := "a@x", displayName := "A", groups := #[⟨2⟩] } : Actor))
  check "actor bot" (roundtrips ({ id := ⟨1⟩, email := "b@x", displayName := "Bot", bot := true } : Actor))
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
  let botActor ← createActor db { email := "bot@x.io", displayName := "CI Bot", bot := true }
  check "actor bot flag stored" (botActor.bot == true)
  check "actor bot default false" (a.bot == false)

  let bug ← createLabel db { name := "bug", description := some "a defect", color := some "#e11d48" }
  check "label created" (bug.name == "bug")
  check "label color stored" (bug.color == "#e11d48")
  check "label default color" ((← createLabel db { name := "chore" }).color == "#6b7280")
  let parent ← createIssue db { title := "Parent" }
  let dep ← createIssue db { title := "Dependency" }
  let child ← createIssue db { title := "Child", parent := some parent.id, dependencies := #[dep.id], assignees := #[a.id], labels := #[bug.id] }
  check "child has parent" (child.parent == some parent.id)
  check "child has dependency" (child.dependencies == #[dep.id])
  check "child has assignee" (child.assignees == #[a.id])
  check "child has label" (child.labels == #[bug.id])
  check "dependency edge recorded" ((← allDependencyEdges db).any (fun (i, d) => i.val == child.id.val && d.val == dep.id.val))
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

  -- parent cycle detection (child's parent is `parent`; making `parent`'s parent `child` cycles)
  let cyclic ←
    try let _ ← updateIssue db parent.id { parent := some (some child.id) }; pure false
    catch _ => pure true
  check "parent cycle rejected" cyclic

  -- clearing the parent via an explicit null
  let _ ← updateIssue db child.id { parent := some none }
  check "parent cleared" (((← getIssue db child.id).bind (·.parent)).isNone)
  let _ ← updateIssue db child.id { parent := some (some parent.id) }

  -- search + filter
  let found ← listIssues db none none (some "Child") none
  check "search finds child" (found.any (·.title == "Child"))
  let openOnly ← listIssues db (some .open) none none none
  check "state filter" (openOnly.size == 3)

  -- artifacts + checks
  let art ← createArtifact db child.id { kind := "github-branch", payload := Json.mkObj [("owner", "o"), ("repo", "r"), ("branch", "main")] }
  check "artifact attached" (art.kind == "github-branch")
  let chk ← createCheck db child.id { kind := "github-ci" }
  check "check pending" (chk.status == .pending)
  recordCheckResult db chk.id .passing (some "ok")
  check "check result recorded" (((← getCheck db chk.id).map (·.status)) == some .passing)

  -- comments
  let cmt ← createComment db child.id (some a.id) { body := "first comment" }
  check "comment created" (cmt.body == "first comment")
  check "comment author name" (cmt.authorName == some "Alice")
  let _ ← createComment db child.id none { body := "system note" }
  check "comments listed oldest-first" ((← issueComments db child.id).size == 2)
  let _ ← updateComment db cmt.id "first comment (edited)"
  check "comment edited" (((← getComment db cmt.id).map (·.body)) == some "first comment (edited)")
  check "comment deleted" (← deleteComment db cmt.id)
  check "one comment remains" ((← issueComments db child.id).size == 1)

  -- events / history
  let _ ← updateIssue db child.id { title := some "Child renamed" } (some a.id)
  let evs ← issueEvents db child.id
  check "title change recorded" (evs.any (·.kind == "title"))
  check "event attributed to actor" (evs.any (fun e => e.kind == "title" && (e.actorId.map (·.val)) == some a.id.val))
  check "event has actor name" (evs.any (fun e => e.kind == "title" && e.actorName == some "Alice"))
  let _ ← updateIssue db child.id { state := some .completed } (some a.id)
  check "state change recorded" ((← issueEvents db child.id).any (·.kind == "state"))
  let _ ← updateIssue db child.id { assignees := some #[a.id] } (some a.id)
  check "assignee change recorded" ((← issueEvents db child.id).any (·.kind == "assignees"))
  recordEvent db child.id (some a.id) "check_added" (Json.mkObj [("kind", "github-ci")])
  check "manual event recorded" ((← issueEvents db child.id).any (·.kind == "check_added"))

  -- api tokens
  let secret := "issues_pat_deadbeef"
  let tok ← createToken db a.id "ci-bot" (Crypto.sha256Hex secret) "issues_pat_dead"
  check "token created" (tok.name == "ci-bot")
  check "token resolves actor" (((← actorForTokenHash db (Crypto.sha256Hex secret)).map (·.id)) == some a.id)
  check "wrong token hash resolves nobody" ((← actorForTokenHash db (Crypto.sha256Hex "nope")).isNone)
  check "token delete scoped to owner" (!(← deleteToken db tok.id ⟨999⟩))
  check "token deleted by owner" (← deleteToken db tok.id a.id)

  -- delete cascade
  check "delete issue" (← deleteIssue db child.id)
  check "artifacts gone after cascade" ((← issueArtifacts db child.id).isEmpty)
  check "comments gone after cascade" ((← issueComments db child.id).isEmpty)

  IO.println "SHA-256"
  -- NIST test vectors.
  check "sha256 empty" (Crypto.sha256Hex "" == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  check "sha256 abc" (Crypto.sha256Hex "abc" == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  check "sha256 long"
    (Crypto.sha256Hex "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
      == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")

  IO.println "Plugin registry"
  check "github-branch registered" ((← Plugins.artifactHandler? "github-branch").isSome)
  check "github-ci registered" ((← Plugins.checkHandler? "github-ci").isSome)
  check "json-endpoint registered" ((← Plugins.checkHandler? "json-endpoint").isSome)
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
