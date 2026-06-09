import Issues.Domain.Ids
import Issues.Domain.Enums

/-!
# Request payloads

Input structures decoded from request bodies for create/update operations. They mirror the
entities but omit server-assigned fields (ids, timestamps). Update payloads make every field
optional; a field left absent leaves the stored value unchanged.
-/

open Lean

namespace Issues

/-- Body for creating an actor. -/
structure ActorInput where
  email : String
  displayName : String
  groups : Array GroupId := #[]
  googleSub : Option String := none
  admin : Bool := false
deriving ToJson

instance : FromJson ActorInput where
  fromJson? j := do pure {
    email := ← jsonField? j "email"
    displayName := ← jsonField? j "displayName"
    groups := ← jsonFieldD? j "groups" #[]
    googleSub := ← jsonFieldOpt? j "googleSub"
    admin := ← jsonFieldD? j "admin" false }

/-- Body for updating an actor; absent fields are left unchanged. -/
structure ActorUpdate where
  email : Option String := none
  displayName : Option String := none
  groups : Option (Array GroupId) := none
  googleSub : Option String := none
  admin : Option Bool := none
deriving ToJson, FromJson

/-- Body for creating a group. -/
structure GroupInput where
  name : String
  description : Option String := none
deriving ToJson, FromJson

/-- Body for updating a group. -/
structure GroupUpdate where
  name : Option String := none
  description : Option String := none
deriving ToJson, FromJson

/-- Body for creating a label. -/
structure LabelInput where
  name : String
  description : Option String := none
  color : Option String := none
deriving ToJson, FromJson

/-- Body for updating a label. -/
structure LabelUpdate where
  name : Option String := none
  description : Option String := none
  color : Option String := none
deriving ToJson, FromJson

/-- Body for creating an issue. -/
structure IssueInput where
  title : String
  description : String := ""
  state : IssueState := .open
  locked : Bool := false
  labels : Array LabelId := #[]
  parents : Array IssueId := #[]
  assignees : Array ActorId := #[]
  visibility : Array GroupId := #[]
deriving ToJson

instance : FromJson IssueInput where
  fromJson? j := do pure {
    title := ← jsonField? j "title"
    description := ← jsonFieldD? j "description" ""
    state := ← jsonFieldD? j "state" .open
    locked := ← jsonFieldD? j "locked" false
    labels := ← jsonFieldD? j "labels" #[]
    parents := ← jsonFieldD? j "parents" #[]
    assignees := ← jsonFieldD? j "assignees" #[]
    visibility := ← jsonFieldD? j "visibility" #[] }

/-- Body for updating an issue; absent scalar/relation fields are left unchanged. -/
structure IssueUpdate where
  title : Option String := none
  description : Option String := none
  state : Option IssueState := none
  locked : Option Bool := none
  labels : Option (Array LabelId) := none
  parents : Option (Array IssueId) := none
  assignees : Option (Array ActorId) := none
  visibility : Option (Array GroupId) := none
deriving ToJson, FromJson

/-- Body for attaching an artifact to an issue. -/
structure ArtifactInput where
  kind : String
  payload : Json := .null

instance : FromJson ArtifactInput where
  fromJson? j := do pure {
    kind := ← jsonField? j "kind"
    payload := ← jsonFieldD? j "payload" .null }

/-- Body for attaching a check to an issue. -/
structure CheckInput where
  kind : String
  config : Json := .null

instance : FromJson CheckInput where
  fromJson? j := do pure {
    kind := ← jsonField? j "kind"
    config := ← jsonFieldD? j "config" .null }

end Issues
