import Taxis.Domain
import Taxis.Db.Connection
import Taxis.Repo.Ref
import Std.Data.HashMap

/-!
# Plugin registry

Artifact and check kinds are extensible. A plugin is a module that defines a handler and
registers it in an `initialize` block, so that merely importing the module makes the kind
available — adding a new artifact/check type is "add a module + import it", with no change to
the core. Handlers are looked up by their `kind` discriminator at request time.

The same mechanism carries the two halves of the repository dependency graph, split along the
axis that actually varies: a `RepoForge` knows how to read files out of repositories on one
*host*, and a `RepoDepsProvider` knows how to read dependencies out of the manifests of one
*ecosystem*. They compose — teaching the tracker about a new forge gives every ecosystem access
to it, and vice versa.
-/

open Lean

namespace Taxis.Plugins

/-- Describes one input field of an artifact payload or check config, so the frontend can render
    a proper form instead of asking for raw JSON. `type` is one of `string`, `number`, `boolean`,
    or `text` (multi-line). -/
structure FieldSpec where
  name : String
  label : String
  type : String := "string"
  required : Bool := false
  placeholder : Option String := none
  help : Option String := none
deriving Repr, Inhabited, ToJson

/-- Handler for one artifact `kind`: validates payloads and summarises them. -/
structure ArtifactHandler where
  kind : String
  /-- Input fields the payload is built from (drives the frontend form). -/
  fields : Array FieldSpec := #[]
  /-- Validate a payload, returning a message on rejection. -/
  validate : Json → Except String Unit := fun _ => .ok ()
  /-- How to present the artifact: a label and an optional link. Lets each kind render itself. -/
  render : Json → ArtifactDisplay := fun j => { label := j.compress }

/-- Handler for one check `kind`: validates config and evaluates the check. -/
structure CheckHandler where
  kind : String
  /-- Input fields the config is built from (drives the frontend form). -/
  fields : Array FieldSpec := #[]
  /-- Validate the check configuration. -/
  validateConfig : Json → Except String Unit := fun _ => .ok ()
  /-- Evaluate the check against its config, the issue, and the issue's artifacts (with database
      access, for checks that need to look up other issues/comments), returning an outcome and an
      optional human-readable detail. -/
  evaluate : Db.Conn → Json → Issue → Array Artifact → IO (CheckStatus × Option String)

/-- One outgoing dependency edge derived from a repository's manifest. -/
structure RepoDep where
  /-- Canonical id (`Repo.RepoRef.canonical`) of the depended-on repository. -/
  target : String
  /-- The dependency's URL as the manifest wrote it. -/
  targetUrl : String
  /-- Short qualifier shown on the edge, e.g. the pinned revision. -/
  detail : Option String := none
deriving Repr, Inhabited, BEq

/-- Reads one file out of a repository, by path (e.g. `"lakefile.toml"`). `.ok none` means the
    file is absent, which is not an error — providers probe for the manifests they understand. -/
abbrev RepoFileReader := String → IO (Except String (Option String))

/-- Reads files out of repositories hosted on one forge. -/
structure RepoForge where
  /-- Hosts served by this forge, lowercased, e.g. `#["github.com"]`. -/
  hosts : Array String
  fetchFile : Repo.RepoRef → String → IO (Except String (Option String))

/-- Derives the outgoing dependency edges of a repository for one ecosystem, by reading its
    manifests through `reader` (which is memoised per repository, so probing is cheap).

    Returning `.ok none` means "not my ecosystem" — no manifest this provider understands is
    present, so it has no opinion, and other providers still get a turn. `.ok (some #[])` is the
    stronger claim that the repository *is* of this ecosystem and has no dependencies. -/
structure RepoDepsProvider where
  kind : String
  deps : Repo.RepoRef → RepoFileReader → IO (Except String (Option (Array RepoDep)))

initialize artifactRegistryRef : IO.Ref (Std.HashMap String ArtifactHandler) ← IO.mkRef {}
initialize checkRegistryRef : IO.Ref (Std.HashMap String CheckHandler) ← IO.mkRef {}
initialize repoForgeRegistryRef : IO.Ref (Array RepoForge) ← IO.mkRef #[]
initialize repoDepsRegistryRef : IO.Ref (Std.HashMap String RepoDepsProvider) ← IO.mkRef {}

/-- Register (or replace) an artifact handler. Typically called from a plugin `initialize`. -/
def registerArtifactHandler (h : ArtifactHandler) : IO Unit :=
  artifactRegistryRef.modify (·.insert h.kind h)

/-- Register (or replace) a check handler. Typically called from a plugin `initialize`. -/
def registerCheckHandler (h : CheckHandler) : IO Unit :=
  checkRegistryRef.modify (·.insert h.kind h)

def artifactHandler? (kind : String) : IO (Option ArtifactHandler) :=
  return (← artifactRegistryRef.get).get? kind

def checkHandler? (kind : String) : IO (Option CheckHandler) :=
  return (← checkRegistryRef.get).get? kind

def artifactKinds : IO (Array String) :=
  return (← artifactRegistryRef.get).toList.map Prod.fst |>.toArray

def checkKinds : IO (Array String) :=
  return (← checkRegistryRef.get).toList.map Prod.fst |>.toArray

def allArtifactHandlers : IO (Array ArtifactHandler) :=
  return (← artifactRegistryRef.get).toList.map Prod.snd |>.toArray

def allCheckHandlers : IO (Array CheckHandler) :=
  return (← checkRegistryRef.get).toList.map Prod.snd |>.toArray

/-- Register a forge. Typically called from a plugin `initialize`. -/
def registerRepoForge (f : RepoForge) : IO Unit :=
  repoForgeRegistryRef.modify (·.push f)

/-- Register (or replace) a dependency provider. Typically called from a plugin `initialize`. -/
def registerRepoDepsProvider (p : RepoDepsProvider) : IO Unit :=
  repoDepsRegistryRef.modify (·.insert p.kind p)

/-- The forge serving `host`, if one is registered. -/
def repoForgeFor? (host : String) : IO (Option RepoForge) := do
  let lower := host.toLower
  return (← repoForgeRegistryRef.get).find? (·.hosts.contains lower)

def repoDepsProvider? (kind : String) : IO (Option RepoDepsProvider) :=
  return (← repoDepsRegistryRef.get).get? kind

/-- Every registered dependency provider, ordered by kind so that resolution — which takes the
    first provider to claim a repository — does not depend on hash-map iteration order. -/
def allRepoDepsProviders : IO (Array RepoDepsProvider) := do
  let ps := (← repoDepsRegistryRef.get).toList.map Prod.snd
  return (ps.mergeSort (fun a b => a.kind ≤ b.kind)).toArray

def repoDepsKinds : IO (Array String) := do
  return (← allRepoDepsProviders).map (·.kind)

end Taxis.Plugins
