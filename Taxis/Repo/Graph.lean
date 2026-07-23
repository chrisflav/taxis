import Taxis.Plugins
import Taxis.Db

/-!
# Repository dependency graph

Builds the graph whose nodes are the repositories attached to issues (as `repository` artifacts)
and whose edges are dependency relations between them.

Nodes come from the tracker's own data and are always exact. Edges are *derived*: for each
repository, the registered `RepoDepsProvider`s are offered its files until one recognises the
repository as belonging to its ecosystem, and the dependencies it reports become outgoing edges.
Only edges between two repositories the tracker knows about are kept, unless external targets are
asked for — a dependency on something nobody has attached is real, but it isn't part of the graph
the user is curating.

Deriving an edge costs network requests, so results are cached per repository for
`repoDepsTtlSeconds`. Resolution never fails the graph: a repository whose dependencies can't be
read becomes a node carrying an `error`, so the rest of the graph still renders.
-/

open Lean

namespace Taxis.Repo

/-- The outcome of resolving one repository's dependencies. -/
structure DepsResult where
  /-- The provider kind that claimed the repository, if any. -/
  ecosystem : Option String := none
  deps : Array Plugins.RepoDep := #[]
  /-- Why resolution failed or came up empty, for display next to the node. -/
  error : Option String := none
deriving Inhabited

/-- A repository the tracker knows about, folded together from its `repository` artifacts. -/
structure AttachedRepo where
  ref : RepoRef
  /-- Display name from the artifact payload, if one was given. -/
  name : Option String := none
  /-- Provider kind pinned by the artifact payload; `none` probes every provider. -/
  ecosystem : Option String := none
  /-- Every issue this repository is attached to. -/
  issues : Array IssueId := #[]
deriving Inhabited

/-- A node of the dependency graph: one repository. -/
structure Node where
  /-- Canonical repository id; the endpoint edges refer to. -/
  id : String
  url : String
  name : String
  issues : Array IssueId := #[]
  /-- False for a repository that only appears as the target of a dependency. -/
  attached : Bool := true
  ecosystem : Option String := none
  error : Option String := none

/-- An edge: `source` depends on `target`. -/
structure Edge where
  source : String
  target : String
  /-- Provider kind the edge was derived by, e.g. `"lake"`. -/
  via : String
  detail : Option String := none

structure Graph where
  nodes : Array Node := #[]
  edges : Array Edge := #[]

/-! ## Resolution -/

initialize depsCacheRef : IO.Ref (Std.HashMap String (Nat × DepsResult)) ← IO.mkRef {}

/-- Drop every cached dependency resolution, so the next graph build re-reads the manifests. -/
def clearCache : IO Unit := depsCacheRef.set {}

private def cacheKey (repo : AttachedRepo) : String :=
  s!"{repo.ref.canonical}@{repo.ref.ref.getD "HEAD"}#{repo.ecosystem.getD ""}"

/-- Offer a repository to the providers, first claim wins. -/
private def resolveUncached (repo : AttachedRepo) : IO DepsResult := do
  let some forge ← Plugins.repoForgeFor? repo.ref.host
    | return { error := some s!"no forge registered for host '{repo.ref.host}'" }
  -- Memoised per repository, so several providers probing the same manifest — or the same
  -- provider reading a file twice — cost one request.
  let filesRef ← IO.mkRef (∅ : Std.HashMap String (Except String (Option String)))
  let read : Plugins.RepoFileReader := fun path => do
    if let some cached := (← filesRef.get).get? path then return cached
    let result ← try forge.fetchFile repo.ref path catch e => pure (.error s!"{e}")
    filesRef.modify (·.insert path result)
    pure result
  let all ← Plugins.allRepoDepsProviders
  let providers : Array Plugins.RepoDepsProvider := match repo.ecosystem with
    | some kind => all.filter (fun p => p.kind == kind)
    | none => all
  if providers.isEmpty then
    if let some kind := repo.ecosystem then
      return { error := some s!"no dependency provider registered for ecosystem '{kind}'" }
  let mut result : DepsResult := {}
  for provider in providers do
    match ← (try provider.deps repo.ref read catch e => pure (.error s!"{e}")) with
    | .ok (some deps) => return { ecosystem := some provider.kind, deps }
    | .ok none => pure ()
    -- Keep going: another provider may still recognise the repository. The first failure is
    -- reported only if nobody does.
    | .error e => if result.error.isNone then result := { result with error := some e }
  return result

/-- Resolve a repository's dependencies, using the cached result when it is younger than
    `ttlSeconds`. A `ttlSeconds` of `0` disables caching. -/
def resolveDeps (ttlSeconds : Nat) (repo : AttachedRepo) : IO DepsResult := do
  let key := cacheKey repo
  let now ← IO.monoMsNow
  if ttlSeconds > 0 then
    if let some (cachedAt, cached) := (← depsCacheRef.get).get? key then
      if now - cachedAt < ttlSeconds * 1000 then return cached
  let result ← resolveUncached repo
  depsCacheRef.modify (·.insert key (now, result))
  return result

/-! ## Building the graph -/

/-- Fold `repository` artifacts into the repositories they denote. Several issues may carry the
    same repository (and one issue may carry it more than once); each becomes a single node
    listing every issue it is attached to. Artifacts whose URL doesn't parse are dropped. -/
def collect (artifacts : Array (IssueId × Artifact)) : Array AttachedRepo := Id.run do
  let str? (j : Json) (f : String) : Option String :=
    (j.getObjValAs? String f).toOption.filter (!·.trimAscii.isEmpty)
  let mut index : Std.HashMap String Nat := {}
  let mut repos : Array AttachedRepo := #[]
  for (issueId, artifact) in artifacts do
    let some url := str? artifact.payload "url" | continue
    let some parsed := RepoRef.parse? url | continue
    -- An explicit `ref` on the artifact overrides one read out of the URL.
    let ref := { parsed with ref := (str? artifact.payload "ref").orElse (fun _ => parsed.ref) }
    match index[ref.canonical]? with
    | some i =>
      let existing := repos[i]!
      if !existing.issues.contains issueId then
        repos := repos.set! i { existing with issues := existing.issues.push issueId }
    | none =>
      index := index.insert ref.canonical repos.size
      repos := repos.push {
        ref, issues := #[issueId]
        name := str? artifact.payload "name"
        ecosystem := str? artifact.payload "ecosystem" }
  return repos

/-- Build the dependency graph over `repos`. With `includeExternal`, dependencies on repositories
    nobody has attached appear as extra nodes flagged `attached := false`; otherwise those edges
    are dropped. -/
def build (ttlSeconds : Nat) (includeExternal : Bool) (repos : Array AttachedRepo) : IO Graph := do
  let attached : Std.HashSet String := repos.foldl (fun s r => s.insert r.ref.canonical) {}
  -- Resolved concurrently. Each repository's dependencies come from manifests fetched over the
  -- network, and one repository's fetches tell us nothing about another's — so done one after the
  -- next, a graph over n repositories took n round trips end to end, which was nearly all of what
  -- this endpoint spent its time on.
  --
  -- `resolveDeps` writes its result into the shared cache without synchronisation. Two resolutions
  -- finishing together can drop one of the two entries; the cost of that is re-reading one
  -- repository's manifests next time, which is the same thing a cold cache does anyway.
  let tasks ← repos.mapM (fun repo => IO.asTask (resolveDeps ttlSeconds repo))
  let results ← tasks.mapM (fun t => IO.ofExcept t.get)
  let mut nodes : Array Node := #[]
  let mut edges : Array Edge := #[]
  let mut external : Std.HashMap String Node := {}
  for (repo, result) in repos.zip results do
    nodes := nodes.push {
      id := repo.ref.canonical
      url := repo.ref.url
      name := repo.name.getD repo.ref.shortName
      issues := repo.issues
      ecosystem := result.ecosystem
      error := result.error }
    for dep in result.deps do
      -- A repository requiring itself (or listing a dependency twice) shouldn't show up as an
      -- edge; self-loops have no meaning here and duplicates just thicken the line.
      if dep.target == repo.ref.canonical then continue
      if edges.any (fun e => e.source == repo.ref.canonical && e.target == dep.target) then continue
      if !attached.contains dep.target then
        if !includeExternal then continue
        if !external.contains dep.target then
          let name := (RepoRef.parse? dep.targetUrl).map RepoRef.shortName |>.getD dep.target
          external := external.insert dep.target
            { id := dep.target, url := dep.targetUrl, name, attached := false }
      edges := edges.push {
        source := repo.ref.canonical, target := dep.target
        via := result.ecosystem.getD "unknown", detail := dep.detail }
  return { nodes := nodes ++ external.toArray.map Prod.snd, edges }

/-! ## Serialisation -/

def Node.toJson (n : Node) : Json :=
  Json.mkObj [
    ("id", n.id), ("url", n.url), ("name", n.name),
    ("issues", Lean.toJson n.issues), ("attached", Json.bool n.attached),
    ("ecosystem", Lean.toJson n.ecosystem), ("error", Lean.toJson n.error)]

def Edge.toJson (e : Edge) : Json :=
  Json.mkObj [
    ("source", e.source), ("target", e.target),
    ("via", e.via), ("detail", Lean.toJson e.detail)]

def Graph.toJson (g : Graph) : Json :=
  Json.mkObj [
    ("nodes", Json.arr (g.nodes.map Node.toJson)),
    ("edges", Json.arr (g.edges.map Edge.toJson))]

end Taxis.Repo
