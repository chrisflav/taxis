import Taxis.Domain
import Std.Data.HashMap

/-!
# Plugin registry

Artifact and check kinds are extensible. A plugin is a module that defines a handler and
registers it in an `initialize` block, so that merely importing the module makes the kind
available — adding a new artifact/check type is "add a module + import it", with no change to
the core. Handlers are looked up by their `kind` discriminator at request time.
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
  /-- Evaluate the check against its config, the issue, and the issue's artifacts,
      returning an outcome and an optional human-readable detail. -/
  evaluate : Json → Issue → Array Artifact → IO (CheckStatus × Option String)

initialize artifactRegistryRef : IO.Ref (Std.HashMap String ArtifactHandler) ← IO.mkRef {}
initialize checkRegistryRef : IO.Ref (Std.HashMap String CheckHandler) ← IO.mkRef {}

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

end Taxis.Plugins
