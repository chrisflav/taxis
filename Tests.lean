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
    check "valid payload accepted" ((← h.validate (Json.mkObj [("owner", "o"), ("repo", "r"), ("branch", "b")])) |>.toOption |>.isSome)
    check "invalid payload rejected" ((← h.validate (Json.mkObj [("owner", "o")])) |>.toOption |>.isNone)
  | none => check "handler present" false

  IO.println "Context artifacts"
  -- Both payload fields are required, and the label is the title rather than anything guessed out
  -- of the text — which leaves shortening as the only thing the server derives from a payload it
  -- otherwise stores verbatim.
  check "context label is the title" (Plugins.contextLabel "Repro steps" == "Repro steps")
  check "context label is trimmed" (Plugins.contextLabel "  Repro steps \n" == "Repro steps")
  check "context label of an empty title" (Plugins.contextLabel "   " == "context")
  check "context label truncates" ((Plugins.truncateTo (String.ofList (List.replicate 90 'x')) 60).endsWith "…")
  check "context label leaves short text alone" (Plugins.truncateTo "short" 60 == "short")
  match ← Plugins.artifactHandler? "context" with
  | some h =>
    check "context payload requires text" ((← h.validate (Json.mkObj [("title", "t")])) |>.toOption |>.isNone)
    check "context payload requires title" ((← h.validate (Json.mkObj [("text", "note")])) |>.toOption |>.isNone)
    check "context payload rejects whitespace-only text"
      ((← h.validate (Json.mkObj [("title", "t"), ("text", " \n ")])) |>.toOption |>.isNone)
    check "context payload rejects whitespace-only title"
      ((← h.validate (Json.mkObj [("title", " "), ("text", "note")])) |>.toOption |>.isNone)
    -- A wrong-typed field is told apart from an absent one: a bot writing this payload by hand is
    -- the stated audience, and "missing" would send it looking in the wrong place.
    check "context payload rejects a non-string text"
      (match ← h.validate (Json.mkObj [("title", "t"), ("text", (42 : Nat))]) with
       | .error e => e == "'text' must be a string, but is 42"
       | .ok _ => false)
    check "context payload accepted"
      ((← h.validate (Json.mkObj [("title", "Repro steps"), ("text", "note")])) |>.toOption |>.isSome)
    -- Nothing to link to: a context artifact *is* its text, and the frontend renders the payload
    -- it already has. A url here would be a promise the kind cannot keep.
    let display ← h.render (Json.mkObj [("title", "Build environment"), ("text", "# Notes\nbody")])
    check "context renders its title and no link"
      (display.url.isNone && display.label == "Build environment")
  | none => check "context handler present" false

  IO.println "HMAC-SHA256"
  -- RFC 4231 test cases 1, 2, and 6 (the last exercising the hash-down of an over-long key).
  let bytes (b : UInt8) (n : Nat) : ByteArray := ⟨Array.replicate n b⟩
  check "hmac rfc4231 case 1"
    (Crypto.toHex (Crypto.hmac (bytes 0x0b 20) "Hi There")
      == "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
  check "hmac rfc4231 case 2"
    (Crypto.hmacHex "Jefe".toUTF8 "what do ya want for nothing?"
      == "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843")
  check "hmac rfc4231 case 6 (long key)"
    (Crypto.hmacHex (bytes 0xaa 131) "Test Using Larger Than Block-Size Key - Hash Key First"
      == "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54")

  IO.println "SigV4 presigning"
  -- The worked example from "Authenticating Requests: Using Query Parameters" in the S3 docs:
  -- a GET of test.txt in examplebucket, signed 2013-05-24 with the documented example keys.
  let awsExample : Taxis.Sigv4.Request := {
    method := "GET", host := "examplebucket.s3.amazonaws.com", path := "/test.txt"
    accessKey := "AKIAIOSFODNN7EXAMPLE", secretKey := "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    region := "us-east-1", amzDate := "20130524T000000Z", dateStamp := "20130524"
    expiresSeconds := 86400, headers := #[("host", "examplebucket.s3.amazonaws.com")] }
  check "sigv4 canonical request hash matches the AWS docs example"
    (Crypto.sha256Hex awsExample.canonicalRequest
      == "3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04")
  check "sigv4 signature matches the AWS docs example"
    (awsExample.signature == "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")
  check "sigv4 url carries the signature"
    (awsExample.url.endsWith s!"&X-Amz-Signature={awsExample.signature}")
  check "uri-encode keeps unreserved" (Taxis.Sigv4.uriEncode "AZaz09-._~" == "AZaz09-._~")
  check "uri-encode escapes specials" (Taxis.Sigv4.uriEncode "a b/c" == "a%20b%2Fc")
  check "uri-encode can keep path slashes" (Taxis.Sigv4.uriEncode "a b/c" (keepSlash := true) == "a%20b/c")
  check "uri-encode is utf-8 per byte" (Taxis.Sigv4.uriEncode "é" == "%C3%A9")
  -- Header values are canonicalised per the spec's Trimall rule; signing the raw value would
  -- guarantee a mismatch with what the store's verifier reconstructs.
  check "canonical headers are trimmed" (Taxis.Sigv4.trimall "  image/png " == "image/png")
  check "canonical headers collapse inner whitespace"
    (Taxis.Sigv4.trimall "text/plain;\t charset=utf-8" == "text/plain; charset=utf-8")
  check "trimmed header value signs like its clean form"
    (({ awsExample with headers := #[("host", " examplebucket.s3.amazonaws.com ")] } : Taxis.Sigv4.Request).signature
      == awsExample.signature)
  check "amz timestamp epoch" (Plugins.amzTimestamp 0 == ("19700101T000000Z", "19700101"))
  check "amz timestamp leap day" (Plugins.amzTimestamp 951782400 == ("20000229T000000Z", "20000229"))
  check "amz timestamp recent" (Plugins.amzTimestamp 1735689600 == ("20250101T000000Z", "20250101"))
  check "amz timestamp mid-day" (Plugins.amzTimestamp (1735689600 + 3661) == ("20250101T010101Z", "20250101"))

  IO.println "File stores"
  -- Stores are configured from JSON, whichever notation the operator wrote them in: this is the
  -- `ISSUES_FILESTORES` spelling, and the `[[filestores]]` one is exercised under "Configuration".
  let storeConfig (s : String) : Json := (Json.parse s).toOption.getD Json.null
  check "filename passes through clean" (Plugins.sanitizeFilename "report_v2.pdf" == "report_v2.pdf")
  check "filename spaces and slashes flattened" (Plugins.sanitizeFilename "my report/2026.pdf" == "my-report-2026.pdf")
  check "filename of only separators refused" (Plugins.sanitizeFilename ".." == "file")
  check "size formatting bytes" (Plugins.humanSize 512 == "512 B")
  check "size formatting mb" (Plugins.humanSize (3 * 1024 * 1024 + 512 * 1024) == "3.5 MB")
  match ← Plugins.artifactHandler? "file" with
  | some h =>
    check "file payload requires store" ((← h.validate (Json.mkObj [("key", "k")])) |>.toOption |>.isNone)
    check "file payload requires key" ((← h.validate (Json.mkObj [("store", "s")])) |>.toOption |>.isNone)
    check "file payload rejects traversal keys"
      ((← h.validate (Json.mkObj [("store", "s"), ("key", "a/../b")])) |>.toOption |>.isNone)
    -- An unconfigured store is *not* a validation failure (it would make artifacts uneditable
    -- after a store rename); it degrades in the rendered display instead.
    check "file payload tolerates unconfigured store"
      ((← h.validate (Json.mkObj [("store", "nope"), ("key", "k")])) |>.toOption |>.isSome)
    let unknownStore ← h.render (Json.mkObj [("store", "nope"), ("key", "k")])
    check "unknown store degrades in display"
      (unknownStore.url.isNone && unknownStore.label == "k — store 'nope' not configured")
    -- Configure a store, at which point the same payload becomes valid and renders to a link.
    let cfgErrors ← Plugins.configureFileStores (storeConfig
      "[{\"name\": \"test\", \"kind\": \"s3\", \"endpoint\": \"https://garage.example.com\", \"region\": \"garage\", \"bucket\": \"taxis\", \"accessKey\": \"GK1\", \"secretKey\": \"sk\", \"prefix\": \"taxis/\"}]")
    check "store configuration accepted" cfgErrors.isEmpty
    check "store lookup by name" ((← Plugins.fileStore? "test").isSome)
    check "file payload accepted with configured store"
      ((← h.validate (Json.mkObj [("store", "test"), ("key", "uploads/a.png")])) |>.toOption |>.isSome)
    let display ← h.render (Json.mkObj [("store", "test"), ("key", "uploads/a.png"), ("name", "a.png"), ("size", (2048 : Nat))])
    check "file renders name and size" (display.label == "a.png (2.0 KB)")
    check "file renders a signed link under the store prefix"
      (display.url.any fun url =>
        url.startsWith "https://garage.example.com/taxis/taxis/uploads/a.png?"
          && (url.splitOn "X-Amz-Signature=").length == 2)
    match ← Plugins.fileStore? "test" with
    | some store =>
      match ← store.uploadUrl "uploads/b.png" "image/png" with
      | .ok (url, headers) =>
        check "upload url is a signed PUT target"
          (url.startsWith "https://garage.example.com/taxis/taxis/uploads/b.png?"
            && (url.splitOn "X-Amz-SignedHeaders=content-type%3Bhost").length == 2
            && headers == #[("Content-Type", "image/png")])
      | .error _ => check "upload url minted" false
    | none => check "store present for upload" false
  | none => check "file handler present" false
  -- Expiry policy, read back out of the minted URL: clamped to AWS's one-week ceiling, and a
  -- short TTL gets a rounding window no larger than itself rather than the default hour.
  let s3cfg (ttl : Nat) : Plugins.S3Config :=
    match Plugins.S3Config.parse (Json.mkObj [("endpoint", "https://s3.example.com"), ("region", "r"),
        ("bucket", "b"), ("accessKey", "ak"), ("secretKey", "sk"), ("urlTtlSeconds", toJson ttl)]) with
    | .ok c => c
    | .error _ => panic! "s3 config did not parse"
  check "expiry clamped to the aws week ceiling"
    (((← (s3cfg 604800).downloadUrl "k").splitOn "X-Amz-Expires=604800&").length == 2)
  check "short ttl keeps a short window"
    (((← (s3cfg 300).downloadUrl "k").splitOn "X-Amz-Expires=600&").length == 2)
  check "mistyped optional field rejected"
    ((Plugins.S3Config.parse (Json.mkObj [("endpoint", "https://h"), ("region", "r"), ("bucket", "b"),
        ("accessKey", "ak"), ("secretKey", "sk"), ("pathStyle", "false")])) matches .error _)
  check "file stores that are not a list reported"
    (!(← Plugins.configureFileStores (Json.str "not a list")).isEmpty)
  check "unknown backend kind reported"
    ((← Plugins.configureFileStores (storeConfig "[{\"name\": \"x\", \"kind\": \"nope\"}]")).any (·.startsWith "file store 'x'"))
  check "duplicate store name reported"
    ((← Plugins.configureFileStores (storeConfig "[{\"name\": \"test\", \"kind\": \"s3\"}]")).any (· == "duplicate file store name 'test'"))
  check "missing s3 field reported"
    ((← Plugins.configureFileStores (storeConfig
      "[{\"name\": \"y\", \"kind\": \"s3\", \"endpoint\": \"https://h\"}]")).any
        (fun e => e.startsWith "file store 'y'"))

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

  IO.println "Configuration"
  -- A configuration file is read as JSON, so what matters is that the nesting, the arrays of
  -- tables and the types survive the crossing.
  match ← Toml.parse "a = 1\n[t]\nb = [\"x\", \"y\"]\nc = true\n" with
  | .ok j => check "toml becomes json" (j.compress == "{\"a\":1,\"t\":{\"b\":[\"x\",\"y\"],\"c\":true}}")
  | .error e => check s!"toml becomes json ({e})" false
  match ← Toml.parse "[[f]]\nname = \"a\"\n\n[[f]]\nname = \"b\"\n" with
  | .ok j => check "array of tables is a json array" (j.compress == "{\"f\":[{\"name\":\"a\"},{\"name\":\"b\"}]}")
  | .error e => check s!"array of tables is a json array ({e})" false
  match ← Toml.parse "auth.google.clientId = \"g\"\n" with
  | .ok j => check "dotted key nests" (j.compress == "{\"auth\":{\"google\":{\"clientId\":\"g\"}}}")
  | .error e => check s!"dotted key nests ({e})" false
  check "toml syntax error reported" ((← Toml.parse "port = \n") matches .error _)
  -- Dates have no JSON counterpart and no setting is one; the reader says so rather than guessing.
  check "toml date refused" ((← Toml.parse "when = 1979-05-27\n") matches .error _)

  -- These read a file rather than the environment, and environment variables outrank it by
  -- design: an `ISSUES_…` variable exported in the shell running the tests will fail them.
  let cfgPath : System.FilePath := "/tmp/taxis-selftest-config.toml"
  let dotenvPath : System.FilePath := "/tmp/taxis-selftest-config.env"
  let noDotenv : System.FilePath := "/tmp/taxis-selftest-config.env.absent"
  let writeCfg (lines : List String) : IO Unit := IO.FS.writeFile cfgPath ("\n".intercalate lines)
  let throws (act : IO Unit) : IO Bool :=
    try do act; pure false
    catch _ => pure true
  writeCfg [
    "port = 9099", "host = \"0.0.0.0\"", "db = \"/tmp/taxis-selftest-cfg.sqlite\"",
    "frontendDir = \"public\"", "baseUrl = \"https://issues.example.com\"",
    "checkInterval = 30", "repoDepsTtl = 0", "verbose = true", "nonsense = 1",
    "", "[auth]", "password = \"hunter2\"", "adminEmails = [\"a@x.io\", \"b@x.io\"]",
    "devLogin = true", "typo = true",
    "", "[auth.google]", "clientId = \"gid\"", "clientSecret = \"gsecret\"",
    "", "[auth.github]", "clientId = \"ghid\"", "clientSecret = \"ghsecret\"",
    "", "[github]", "token = \"ghtok\"",
    "", "[[filestores]]", "name = \"fromtoml\"", "kind = \"s3\"",
    "endpoint = \"https://garage.example.com\"", "region = \"garage\"", "bucket = \"taxis\"",
    "accessKey = \"GK2\"", "secretKey = \"sk2\"", ""]
  let loaded ← Config.load (some cfgPath) noDotenv
  let c := loaded.config
  check "configuration file reported" (loaded.path == some cfgPath)
  check "port from file" (c.port == 9099)
  check "host from file" (c.host == "0.0.0.0")
  check "db path from file" (c.dbPath == "/tmp/taxis-selftest-cfg.sqlite")
  check "frontend dir from file" (c.frontendDir == "public")
  check "base url from file" (c.publicBaseUrl == "https://issues.example.com")
  check "check interval from file" (c.checkIntervalSeconds == 30)
  check "a zero ttl is kept, not defaulted" (c.repoDepsTtlSeconds == 0)
  check "verbose from file" c.verbose
  check "password from file" (c.centralPassword == some "hunter2")
  check "admin emails from an array" (c.adminEmails == ["a@x.io", "b@x.io"])
  check "dev login from file" c.devLogin
  check "google credentials from file"
    (c.googleClientId == some "gid" && c.googleClientSecret == some "gsecret")
  check "github oauth credentials from file"
    (c.githubClientId == some "ghid" && c.githubClientSecret == some "ghsecret")
  -- The two GitHub settings are easy to conflate, so the file keeps them apart: `[auth.github]`
  -- signs people in, `[github]` calls the API.
  check "github api token from its own section" (c.githubToken == some "ghtok")
  check "unknown settings reported, not fatal" (loaded.unknown == #["auth.typo", "nonsense"])
  match c.fileStores with
  | some stores =>
    check "[[filestores]] arrives as a json array" ((stores.getArr?.toOption.map (·.size)) == some 1)
    check "a store written as toml configures"
      ((← Plugins.configureFileStores stores).isEmpty && (← Plugins.fileStore? "fromtoml").isSome)
  | none => check "[[filestores]] arrives as a json array" false

  -- Store credentials must not reach the process-global config: the field is consumed at startup
  -- and blanked, and `currentConfig` is what code without an `AppContext` reads.
  check "file stores are kept out of the published config" ((← currentConfig).fileStores.isNone)

  -- `.env` sits between the environment and the file.
  IO.FS.writeFile dotenvPath "ISSUES_HOST=10.0.0.1\nISSUES_PORT=9100\n"
  let viaDotenv ← Config.load (some cfgPath) dotenvPath
  check "a .env value beats the configuration file"
    (viaDotenv.config.host == "10.0.0.1" && viaDotenv.config.port == 9100)
  check "the configuration file still fills the rest"
    (viaDotenv.config.centralPassword == some "hunter2")
  -- A trailing comment in a `.env` used to be swallowed by a silent fallback to the default; now
  -- that a value which does not parse stops startup, it has to come off cleanly.
  IO.FS.writeFile dotenvPath "ISSUES_PORT=9100 # the port\nISSUES_HOST=\"10.0.0.2\" # quoted\n"
  let commented ← Config.load (some cfgPath) dotenvPath
  check "a trailing comment in a .env is not part of the value"
    (commented.config.port == 9100 && commented.config.host == "10.0.0.2")
  -- ...but a `#` that is part of the value stays part of it, in or out of quotes.
  IO.FS.writeFile dotenvPath "ISSUES_CENTRAL_PASSWORD=hunter#2\nISSUES_HOST=\"10.0.0.3 # not a comment\"\n"
  let hashes ← Config.load (some cfgPath) dotenvPath
  check "a # inside a .env value is kept"
    (hashes.config.centralPassword == some "hunter#2"
      && hashes.config.host == "10.0.0.3 # not a comment")

  let loadFails (lines : List String) : IO Bool := do
    writeCfg lines
    throws (discard (Config.load (some cfgPath) noDotenv))
  check "a setting of the wrong type refuses to start" (← loadFails ["port = \"nope\""])
  check "a port outside the range refuses to start" (← loadFails ["port = 70000"])
  check "a decimal where a whole number belongs refuses to start" (← loadFails ["port = 8080.0"])
  -- `Json.compress` renders 8080.0 back as `8080`, so the message has to name the shape rather
  -- than print the value, or it reads "must be a whole number, but is 8080".
  writeCfg ["port = 8080.0"]
  let decimalMsg ←
    try do let _ ← Config.load (some cfgPath) noDotenv; pure ""
    catch e => pure (toString e)
  check "the decimal is described, not printed back"
    ((decimalMsg.splitOn "but is a decimal").length == 2)
  -- A blank admin email is not inert: it would match an actor created with an empty email and
  -- make it an administrator, and `[""]` is what an unfilled template variable leaves behind.
  writeCfg ["[auth]", "adminEmails = [\"\", \" a@x.io \", \"   \"]"]
  let blanks ← Config.load (some cfgPath) noDotenv
  check "blank admin emails are dropped and the rest trimmed"
    (blanks.config.adminEmails == ["a@x.io"])
  check "a non-boolean flag refuses to start" (← loadFails ["[auth]", "devLogin = \"yes\""])
  check "file stores that are not tables refuse to start" (← loadFails ["filestores = 3"])
  check "an unparseable file refuses to start" (← loadFails ["port = "])
  check "a configuration file that was asked for must exist"
    (← throws (discard (Config.load (some "/tmp/taxis-selftest-absent.toml") noDotenv)))

  writeCfg [""]
  let bare ← Config.load (some cfgPath) noDotenv
  check "settings absent from the file fall back to defaults"
    (bare.config.port == 8080 && bare.config.dbPath == "issues.sqlite" && !bare.config.devLogin
      && bare.config.repoDepsTtlSeconds == 3600)
  check "base url follows the port it defaults to"
    (bare.config.publicBaseUrl == "http://localhost:8080")
  check "private mode is off by default"
    (!bare.config.privateMode && bare.config.readGroups == [])

  writeCfg ["[auth]", "private = true", "password = \"hunter2\"",
    "readGroups = [\"staff\", \"contractors\"]"]
  let priv := (← Config.load (some cfgPath) noDotenv).config
  check "private mode from file" priv.privateMode
  check "read groups from an array" (priv.readGroups == ["staff", "contractors"])
  -- The spelling the environment variable is forced into, accepted in the file too, so moving a
  -- `.env` into the configuration file is not also a rewrite.
  writeCfg ["[auth]", "private = true", "password = \"hunter2\"", "readGroups = \"staff\""]
  check "read groups from a comma-separated string"
    ((← Config.load (some cfgPath) noDotenv).config.readGroups == ["staff"])
  -- A private instance with no way in answers 401 to everything and no route can change that: a
  -- broken instance rather than a locked one, so it stops startup like any other unusable setting.
  check "private mode with no way to sign in refuses to start"
    (← loadFails ["[auth]", "private = true"])
  check "private mode with a password starts"
    (!(← loadFails ["[auth]", "private = true", "password = \"hunter2\""]))
  check "private mode with google configured starts"
    (!(← loadFails ["[auth]", "private = true", "", "[auth.google]",
        "clientId = \"g\"", "clientSecret = \"s\""]))
  check "private mode with github configured starts"
    (!(← loadFails ["[auth]", "private = true", "", "[auth.github]",
        "clientId = \"g\"", "clientSecret = \"s\""]))
  -- Half-configured OAuth reaches the consent screen and fails the exchange after it, so a guard
  -- that accepted a client id on its own would wave through the very lockout it exists to stop.
  check "private mode with a client id but no secret refuses to start"
    (← loadFails ["[auth]", "private = true", "", "[auth.google]", "clientId = \"g\""])
  check "private mode with a github client id but no secret refuses to start"
    (← loadFails ["[auth]", "private = true", "", "[auth.github]", "clientId = \"g\""])
  writeCfg ["[auth.google]", "clientId = \"g\""]
  check "a client id without its secret is not a configured sign-in method"
    (!(← Config.load (some cfgPath) noDotenv).config.googleConfigured)
  writeCfg ["[auth.google]", "clientId = \"g\"", "clientSecret = \"s\""]
  check "the pair is" ((← Config.load (some cfgPath) noDotenv).config.googleConfigured)
  -- `[]` means "no group restriction" deliberately; `[""]` is an unfilled template variable that
  -- would mean the same thing by accident, on the one setting where naming nothing opens up.
  check "an explicitly empty readGroups is allowed"
    (!(← loadFails ["[auth]", "private = true", "password = \"p\"", "readGroups = []"]))
  check "a readGroups of only blanks refuses to start"
    (← loadFails ["[auth]", "private = true", "password = \"p\"", "readGroups = [\"\"]"])
  check "a readGroups of only whitespace refuses to start"
    (← loadFails ["[auth]", "private = true", "password = \"p\"", "readGroups = \"  \""])
  check "blanks alongside a real group are still just dropped"
    (!(← loadFails ["[auth]", "private = true", "password = \"p\"",
        "readGroups = [\"\", \"staff\"]"]))
  check "a blank readGroups is not an error while the instance is open"
    (!(← loadFails ["[auth]", "readGroups = [\"\"]"]))
  check "private mode with dev login starts"
    (!(← loadFails ["[auth]", "private = true", "devLogin = true"]))
  -- The same file without `private` is a perfectly ordinary open instance, so the refusal has to
  -- be conditional on the mode rather than on the sign-in methods alone.
  check "no sign-in method is fine while the instance is open" (!(← loadFails ["[auth]"]))

  for f in [cfgPath, dotenvPath] do
    try IO.FS.removeFile f catch _ => pure ()
  -- The committed example is documentation that goes stale silently: a setting renamed in `Config`
  -- leaves it describing a key the server no longer reads, which `unknown` is exactly the check
  -- for. Run from the package root, as `lake test` does.
  if ← (System.FilePath.mk "config.example.toml").pathExists then
    let sample ← Config.load (some "config.example.toml") noDotenv
    check "the example configuration only names real settings" (sample.unknown == #[])
    check "the example configuration states the defaults"
      (sample.config.port == 8080 && sample.config.host == "127.0.0.1"
        && sample.config.repoDepsTtlSeconds == 3600 && !sample.config.devLogin
        && sample.config.fileStores.isNone)

  IO.println "Private mode"
  let plainActor : Actor := { id := ⟨1⟩, email := "a@x", displayName := "A", groups := #[⟨5⟩] }
  let adminActor : Actor := { plainActor with groups := #[], admin := true }
  check "anonymous may not read a private instance" (!mayReadGroups #[⟨5⟩] none)
  check "a member may read" (mayReadGroups #[⟨5⟩] (some plainActor))
  check "a non-member may not read" (!mayReadGroups #[⟨9⟩] (some plainActor))
  check "any one of several groups is enough" (mayReadGroups #[⟨9⟩, ⟨5⟩] (some plainActor))
  -- Otherwise one typo in `auth.readGroups` locks out the only account that could repair it.
  check "an admin may read whatever the groups say" (mayReadGroups #[⟨9⟩] (some adminActor))
  -- `auth.private` with no group named is a meaningful mode of its own: signing in is the gate.
  check "no group named admits any authenticated actor" (mayReadGroups #[] (some plainActor))
  check "no group named still excludes anonymous" (!mayReadGroups #[] none)

  -- Resolving `auth.readGroups` creates the group it names, so turning private mode on for a fresh
  -- instance does not require creating a group you can only create by starting the instance.
  let staff ← getOrCreateGroupByName db "staff"
  check "a read group is created if absent" (staff.name == "staff")
  check "resolving it again is the same group"
    ((← getOrCreateGroupByName db "staff").id == staff.id)
  check "a read group starts empty" ((← groupMemberCount db staff.id) == 0)
  let reader ← createActor db { email := "reader@x.io", displayName := "Reader", groups := #[staff.id] }
  check "membership is counted" ((← groupMemberCount db staff.id) == 1)
  check "the member is admitted" (mayReadGroups #[staff.id] (some reader))
  check "lookup by name finds it" (((← getGroupByName db "staff").map (·.id)) == some staff.id)
  check "lookup by name of an absent group is none" ((← getGroupByName db "nobody").isNone)

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
