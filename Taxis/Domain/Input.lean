import Taxis.Domain.Ids
import Taxis.Domain.Enums

/-!
# Request payloads

Input structures decoded from request bodies for create/update operations. They mirror the
entities but omit server-assigned fields (ids, timestamps). Update payloads make every field
optional; a field left absent leaves the stored value unchanged.
-/

open Lean

namespace Taxis

/-- Body for creating an actor. -/
structure ActorInput where
  email : String
  displayName : String
  groups : Array GroupId := #[]
  googleSub : Option String := none
  admin : Bool := false
  bot : Bool := false
deriving ToJson

instance : FromJson ActorInput where
  fromJson? j := do pure {
    email := ← jsonField? j "email"
    displayName := ← jsonField? j "displayName"
    groups := ← jsonFieldD? j "groups" #[]
    googleSub := ← jsonFieldOpt? j "googleSub"
    admin := ← jsonFieldD? j "admin" false
    bot := ← jsonFieldD? j "bot" false }

/-- Body for updating an actor; absent fields are left unchanged. -/
structure ActorUpdate where
  email : Option String := none
  displayName : Option String := none
  groups : Option (Array GroupId) := none
  googleSub : Option String := none
  admin : Option Bool := none
  bot : Option Bool := none
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
  parent : Option IssueId := none
  dependencies : Array IssueId := #[]
  assignees : Array ActorId := #[]
  visibility : Array GroupId := #[]
  deadline : Option Timestamp := none
deriving ToJson

instance : FromJson IssueInput where
  fromJson? j := do pure {
    title := ← jsonField? j "title"
    description := ← jsonFieldD? j "description" ""
    state := ← jsonFieldD? j "state" .open
    locked := ← jsonFieldD? j "locked" false
    labels := ← jsonFieldD? j "labels" #[]
    parent := ← jsonFieldOpt? j "parent"
    dependencies := ← jsonFieldD? j "dependencies" #[]
    assignees := ← jsonFieldD? j "assignees" #[]
    visibility := ← jsonFieldD? j "visibility" #[]
    deadline := ← jsonFieldOpt? j "deadline" }

/-- Body for updating an issue; absent scalar/relation fields are left unchanged. `parent` and
    `deadline` are three-valued: absent leaves it unchanged, `null` clears it, a value sets it. -/
structure IssueUpdate where
  title : Option String := none
  description : Option String := none
  state : Option IssueState := none
  locked : Option Bool := none
  labels : Option (Array LabelId) := none
  parent : Option (Option IssueId) := none
  dependencies : Option (Array IssueId) := none
  assignees : Option (Array ActorId) := none
  visibility : Option (Array GroupId) := none
  deadline : Option (Option Timestamp) := none
deriving ToJson

instance : FromJson IssueUpdate where
  fromJson? j := do pure {
    title := ← jsonFieldOpt? j "title"
    description := ← jsonFieldOpt? j "description"
    state := ← jsonFieldOpt? j "state"
    locked := ← jsonFieldOpt? j "locked"
    labels := ← jsonFieldOpt? j "labels"
    parent := ← jsonFieldTri? j "parent"
    dependencies := ← jsonFieldOpt? j "dependencies"
    assignees := ← jsonFieldOpt? j "assignees"
    visibility := ← jsonFieldOpt? j "visibility"
    deadline := ← jsonFieldTri? j "deadline" }

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

/-- Body for posting a comment on an issue. Setting `review` turns it into a review. -/
structure CommentInput where
  body : String
  review : Option ReviewState := none

instance : FromJson CommentInput where
  fromJson? j := do pure {
    body := ← jsonField? j "body"
    review := ← jsonFieldOpt? j "review" }

/-- Body for creating an API token. -/
structure TokenInput where
  name : String := ""

instance : FromJson TokenInput where
  fromJson? j := do pure { name := ← jsonFieldD? j "name" "" }

end Taxis
