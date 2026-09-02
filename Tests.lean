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
  let child ← createIssue db { title := "Child", goal := "the child ships", parent := some parent.id, dependencies := #[dep.id], assignees := #[a.id], labels := #[bug.id] }
  check "child has parent" (child.parent == some parent.id)
  check "child has goal" (child.goal == "the child ships")
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
  let lockGoal ←
    try let _ ← updateIssue db child.id { goal := some "something else" }; pure false
    catch e => pure ((validationMessage? e).isSome)
  check "locked goal change rejected" lockGoal
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
  let _ ← updateIssue db child.id { goal := some "the child ships on time" } (some a.id)
  check "goal change recorded" ((← issueEvents db child.id).any (·.kind == "goal"))
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

  IO.println "Repository references"
  let canonical (u : String) := (Repo.RepoRef.parse? u).map (·.canonical)
  check "repo https url" (canonical "https://github.com/Owner/Repo" == some "github.com/owner/repo")
  check "repo .git suffix" (canonical "https://github.com/Owner/Repo.git" == some "github.com/owner/repo")
  check "repo scp form" (canonical "git@github.com:owner/repo.git" == some "github.com/owner/repo")
  check "repo bare owner/name" (canonical "owner/repo" == some "github.com/owner/repo")
  check "repo trailing slash" (canonical "https://github.com/owner/repo/" == some "github.com/owner/repo")
  check "repo non-github host" (canonical "https://gitlab.com/g/p" == some "gitlab.com/g/p")
  check "repo branch from tree url" ((Repo.RepoRef.parse? "https://github.com/o/r/tree/dev").bind (·.ref) == some "dev")
  check "repo short name" ((Repo.RepoRef.parse? "https://github.com/O/R").map (·.shortName) == some "O/R")
  check "repo empty rejected" (canonical "" == none)
  check "repo owner-only rejected" (canonical "https://github.com/owner" == none)

  IO.println "Lake dependency provider"
  let ghRef := (Repo.RepoRef.parse? "https://github.com/o/r").get!
  let reader (files : List (String × String)) : Plugins.RepoFileReader := fun path =>
    pure (.ok (files.lookup path))
  let manifest := "{\"packages\": [
    {\"url\": \"https://github.com/leanprover/leansqlite\", \"inherited\": false, \"inputRev\": \"v4.31.0\"},
    {\"url\": \"https://github.com/other/transitive\", \"inherited\": true}]}"
  match ← Plugins.lakeDeps ghRef (reader [("lake-manifest.json", manifest)]) with
  | .ok (some ds) =>
    check "manifest keeps direct dep" (ds.size == 1 && ds[0]!.target == "github.com/leanprover/leansqlite")
    check "manifest keeps pinned rev" (ds[0]!.detail == some "v4.31.0")
  | _ => check "manifest parsed" false
  let toml := "name = \"taxis\"\n\n[[require]]\nname = \"leansqlite\"\ngit = \"https://github.com/leanprover/leansqlite\"\nrev = \"v4.31.0\"\n\n[[lean_lib]]\nname = \"Taxis\"\n"
  match ← Plugins.lakeDeps ghRef (reader [("lakefile.toml", toml)]) with
  | .ok (some ds) =>
    check "toml require parsed" (ds.size == 1 && ds[0]!.target == "github.com/leanprover/leansqlite")
    check "toml rev parsed" (ds[0]!.detail == some "v4.31.0")
  | _ => check "toml parsed" false
  let lakefile := "import Lake\nrequire leansqlite from git \"https://github.com/leanprover/leansqlite\" @ \"v4.31.0\"\n"
  match ← Plugins.lakeDeps ghRef (reader [("lakefile.lean", lakefile)]) with
  | .ok (some ds) =>
    check "lakefile.lean require parsed" (ds.size == 1 && ds[0]!.target == "github.com/leanprover/leansqlite")
    check "lakefile.lean rev parsed" (ds[0]!.detail == some "v4.31.0")
  | _ => check "lakefile.lean parsed" false
  -- No manifest of any kind: not a Lake package, so the provider declines rather than claiming
  -- the repository with an empty dependency set.
  check "non-lake repo declined" ((← Plugins.lakeDeps ghRef (reader [("README.md", "hi")])) matches .ok none)
  check "lake provider registered" ((← Plugins.repoDepsProvider? "lake").isSome)
  check "github forge registered" ((← Plugins.repoForgeFor? "GitHub.com").isSome)
  check "unknown forge absent" ((← Plugins.repoForgeFor? "example.invalid").isNone)

  IO.println "Repository graph"
  let repoArtifact (url : String) : Artifact :=
    { id := ⟨0⟩, kind := "repository", payload := Json.mkObj [("url", url)] }
  let collected := Repo.collect #[
    (⟨1⟩, repoArtifact "https://github.com/Owner/Repo.git"),
    (⟨2⟩, repoArtifact "git@github.com:owner/repo"),
    (⟨1⟩, repoArtifact "not a url at all")]
  check "same repo written differently is one node" (collected.size == 1)
  check "node lists every issue it hangs off" (collected[0]!.issues == #[⟨1⟩, ⟨2⟩])
  check "unparseable repository artifact dropped" (collected.all (·.ref.canonical != "not a url at all"))

  IO.println "Response compression"
  -- A gzip stream this decompresses to the input is checked from the outside, by
  -- `scripts/check-gzip.mjs`; what is checked here is the framing and the decision rule.
  let jsonish := String.join (List.replicate 400 "{\"id\":12,\"title\":\"a repeated title\"},")
  let compressed := gzipBytes jsonish.toUTF8 gzipLevel
  check "gzip magic bytes" (compressed[0]? == some 0x1f && compressed[1]? == some 0x8b)
  check "gzip deflate method" (compressed[2]? == some 0x08)
  check "gzip shrinks repetitive json" (compressed.size < jsonish.toUTF8.size / 4)
  check "gzip of empty input is a valid stream" ((gzipBytes ByteArray.empty gzipLevel).size > 0)
  check "compresses a large body for a client that accepts it"
    ((gzipIfWorthwhile jsonish true).isSome)
  check "sends plain to a client that does not accept gzip"
    ((gzipIfWorthwhile jsonish false).isNone)
  check "leaves a body below the threshold alone"
    ((gzipIfWorthwhile "{\"ok\":true}" true).isNone)
  -- Incompressible and over the threshold: the result would be larger, so it must be declined.
  let noisy := String.join ((List.range 1200).map (fun i => toString (i * 7919 % 100000)))
  check "declines when compression would not help"
    (match gzipIfWorthwhile noisy true with
     | some out => out.size < noisy.toUTF8.size
     | none => true)

  IO.println "Visibility"
  let pub : Issue := { id := ⟨1⟩, title := "p", visibility := #[], createdAt := ⟨0⟩, updatedAt := ⟨0⟩ }
  let priv : Issue := { pub with visibility := #[⟨5⟩] }
  let member : Actor := { id := ⟨1⟩, email := "", displayName := "", groups := #[⟨5⟩] }
  let outsider : Actor := { member with groups := #[⟨9⟩] }
  check "public visible to anon" (visibleTo none pub)
  check "private hidden from anon" (!visibleTo none priv)
  check "private visible to member" (visibleTo (some member) priv)
  check "private hidden from outsider" (!visibleTo (some outsider) priv)

  IO.println "Change feed"
  -- A separate database, so the sequence numbers are this section's alone and the assertions can
  -- talk about "one change" rather than "one more than whatever the tests above left behind".
  let cpath : System.FilePath := "/tmp/issues-selftest-changes.sqlite"
  for suffix in ["", "-wal", "-shm"] do
    try IO.FS.removeFile (cpath.toString ++ suffix) catch _ => pure ()
  let cdb ← connect cpath
  migrate cdb
  -- Everything below reads as a signed-in reader belonging to no group, i.e. one who sees exactly
  -- the public issues. `since`/`upTo` are threaded by hand the way a client threads them.
  let anyone : Option (Array GroupId) := some #[]
  let feed (since : Int64) : IO ChangesPage := changesSince cdb since anyone 500
  let touched (p : ChangesPage) : Array Int64 := p.changes.map (·.id.val)
  let dropped (p : ChangesPage) : Array Int64 :=
    (p.changes.filter (·.row.isNone)).map (·.id.val)

  let cLabel ← createLabel cdb { name := "flaky" }
  let cParent ← createIssue cdb { title := "Parent" }
  let cDep ← createIssue cdb { title := "Dependency" }
  let afterSeed ← changesHead cdb
  check "creating an issue is a change" (afterSeed > 0)

  -- A child: the child is new, and the parent's child count moved with it.
  let cChild ← createIssue cdb { title := "Child", parent := some cParent.id, dependencies := #[cDep.id], labels := #[cLabel.id] }
  let p1 ← feed afterSeed
  check "a new child is reported" ((touched p1).contains cChild.id.val)
  check "its parent is reported too, for the child count" ((touched p1).contains cParent.id.val)
  check "the feed carries the row, not just the id"
    ((p1.changes.find? (·.id.val == cChild.id.val)).bind (·.row) |>.map (·.title) |> (· == some "Child"))
  check "the row carries its relations" ((p1.changes.find? (·.id.val == cChild.id.val)).bind (·.row)
    |>.map (·.labels) |> (· == some #[cLabel.id]))
  check "one entry per issue however many tables moved"
    ((touched p1).size == (touched p1).toList.eraseDups.length)

  -- A save that changes nothing files nothing: the relation setters diff rather than rewrite.
  let afterChild ← changesHead cdb
  let _ ← updateIssue cdb cChild.id { labels := some #[cLabel.id] }
  let p2 ← feed afterChild
  -- The issue row itself is always stamped, so the issue appears; what must *not* appear is a
  -- storm of label rows, and the parent must not be dragged in.
  check "an unchanged relation does not drag in the parent" (!(touched p2).contains cParent.id.val)

  -- Attachments are counts on the row, so they move it.
  let afterNoop ← changesHead cdb
  let art ← createArtifact cdb cChild.id
    { kind := "context", payload := Json.mkObj [("title", Json.str "t"), ("body", Json.str "b")] }
  let p3 ← feed afterNoop
  check "attaching an artifact is a change" ((touched p3).contains cChild.id.val)
  check "the artifact count is in the row" ((p3.changes.find? (·.id.val == cChild.id.val)).bind (·.row)
    |>.map (·.artifactCount) |> (· == some 1))
  let afterArtifact ← changesHead cdb
  let _ ← deleteArtifact cdb art.id
  check "detaching one is a change too" ((touched (← feed afterArtifact)).contains cChild.id.val)

  -- Deleting a label takes it off every issue carrying it, through a foreign-key cascade that no
  -- Lean code here can see. The trigger does.
  let afterDetach ← changesHead cdb
  let _ ← deleteLabel cdb cLabel.id
  check "deleting a label moves the issues that carried it"
    ((touched (← feed afterDetach)).contains cChild.id.val)

  -- Deletion: a tombstone that outlives the row, and a change for everything that pointed at it.
  let afterLabel ← changesHead cdb
  let _ ← deleteIssue cdb cDep.id
  let p4 ← feed afterLabel
  check "a deleted issue is reported as gone" ((dropped p4).contains cDep.id.val)
  check "and what depended on it is reported as changed" ((touched p4).contains cChild.id.val)
  check "the depender is an upsert, not a drop" (!(dropped p4).contains cChild.id.val)
  check "the dropped issue really is gone from the tracker" ((← getIssue cdb cDep.id).isNone)

  -- Visibility. A private issue is not this reader's news at all; one that *becomes* private is,
  -- because they were holding it a moment ago.
  let cGroup ← createGroup cdb { name := "secret" }
  let afterDelete ← changesHead cdb
  let hidden ← createIssue cdb { title := "Hidden", visibility := #[cGroup.id] }
  let p5 ← feed afterDelete
  check "an issue created private is never mentioned" (!(touched p5).contains hidden.id.val)
  let insider : Option (Array GroupId) := some #[cGroup.id]
  let p5m ← changesSince cdb afterDelete insider 500
  check "but a member of its group is told about it" ((p5m.changes.map (·.id.val)).contains hidden.id.val)

  let afterHidden ← changesHead cdb
  let exposed ← createIssue cdb { title := "Was public" }
  let afterExposed ← changesHead cdb
  let _ ← updateIssue cdb exposed.id { visibility := some #[cGroup.id] }
  let p6 ← feed afterExposed
  check "an issue that becomes private is reported as gone to whoever could see it"
    ((dropped p6).contains exposed.id.val)
  let p6m ← changesSince cdb afterExposed insider 500
  check "and as an upsert to whoever now can"
    (((p6m.changes.find? (·.id.val == exposed.id.val)).bind (·.row)).isSome)
  check "no news for the issue that was already private"
    (!(touched (← feed afterHidden)).contains hidden.id.val)

  -- The cursor contract: complete up to `upTo`, and honest when it cannot help.
  let head ← changesHead cdb
  let level ← feed head
  check "a client level with the log is told nothing" (level.changes.isEmpty)
  check "and its cursor moves to the head" (level.upTo == head)
  let small ← changesSince cdb afterSeed anyone 1
  check "a capped page says there is more" small.more
  check "and stops at a sequence it is complete through" (small.upTo < head)
  -- Pages are not disjoint by issue and should not be: an issue touched twice appears once in each
  -- page that holds one of its rows. What has to hold is that walking in small steps ends where one
  -- big read ends, and misses nothing on the way.
  let big ← changesSince cdb afterSeed anyone 500
  let mut cursor := afterSeed
  let mut walked : Array Int64 := #[]
  for _ in [0:500] do
    let page ← changesSince cdb cursor anyone 1
    walked := walked ++ page.changes.map (·.id.val)
    cursor := page.upTo
    if !page.more then break
  check "paging one row at a time ends where one big read ends" (cursor == big.upTo)
  check "and misses none of what the big read saw"
    ((big.changes.map (·.id.val)).all (fun i => walked.contains i))
  let pruned ← pruneChanges cdb 1
  check "pruning drops all but the rows kept" (pruned > 0)
  let stale ← feed 0
  check "a cursor older than the log asks for a fresh read" stale.reset
  check "and a reset page carries no changes" stale.changes.isEmpty

  let n ← failures.get
  IO.println ""
  if n > 0 then
    IO.eprintln s!"{n} test(s) failed"
    IO.Process.exit 1
  else
    IO.println "all tests passed"
