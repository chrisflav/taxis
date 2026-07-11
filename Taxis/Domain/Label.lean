import Taxis.Domain.Ids

/-!
# Labels

A label is a reusable, named tag with an optional description, managed independently of issues.
An issue may carry an arbitrary number of labels.
-/

open Lean

namespace Taxis

/-- A configurable label. `color` is a CSS hex colour chosen by the user. -/
structure Label where
  id : LabelId
  name : String
  description : Option String := none
  color : String := "#6b7280"
deriving Repr, BEq, Inhabited, ToJson, FromJson

end Taxis
