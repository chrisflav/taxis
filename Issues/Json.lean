import Lean.Data.Json
import Lean.Elab.Deriving.FromToJson

/-!
# JSON scaffolding

Re-exports Lean's `Json`, `ToJson`, `FromJson`, and their deriving handlers, and adds
`ToJson`/`FromJson` instances for the fixed-width integer type used at the database
boundary. All wire (de)serialisation in the tracker goes through these classes, following
the design's "many custom structures and simple JSON ↔ data conversions" approach.
-/

open Lean

namespace Issues

/-- Encode an `Int64` as a JSON number. -/
instance : ToJson Int64 where
  toJson i := toJson i.toInt

/-- Decode an `Int64` from a JSON number. -/
instance : FromJson Int64 where
  fromJson? j := do return Int64.ofInt (← fromJson? (α := Int) j)

/-- Helper: decode a field, returning a descriptive error on failure. -/
def jsonField? [FromJson α] (j : Json) (name : String) : Except String α := do
  fromJson? (← j.getObjVal? name)

/-- Helper: decode an optional field (absent or `null` ⇒ `none`). -/
def jsonFieldOpt? [FromJson α] (j : Json) (name : String) : Except String (Option α) := do
  match j.getObjVal? name with
  | .error _ => pure none
  | .ok .null => pure none
  | .ok v => some <$> fromJson? v

/-- Helper: decode a field, falling back to `dflt` when it is absent or `null`. -/
def jsonFieldD? [FromJson α] (j : Json) (name : String) (dflt : α) : Except String α := do
  match j.getObjVal? name with
  | .error _ => pure dflt
  | .ok .null => pure dflt
  | .ok v => fromJson? v

end Issues
