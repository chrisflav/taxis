import Lake.Toml
import Lean.Data.Json

/-!
# Reading TOML

`config.toml` is read with Lake's TOML implementation — the one behind `lakefile.toml` — rather
than with a reader of our own. It ships with the toolchain, it is a complete implementation of the
format kept correct by someone else, and it costs the binary around 140 KB, because the Lean
frontend it is built on is already linked in.

What this module adds is the conversion to `Lean.Json`. Everything downstream already reads its
configuration out of `Json` — `Config`, and in particular the file-store backends, whose `make`
takes a store's configuration as `Json` — so a `[[filestores]]` block and an entry of the
`ISSUES_FILESTORES` JSON array reach the same code by the same route.
-/

open Lean

namespace Taxis.Toml

/-- Where a value sits in the document, for error messages: `filestores[0].name`. -/
private def index (path : String) (i : Nat) : String := s!"{path}[{i}]"

private def child (path key : String) : String :=
  if path.isEmpty then key else s!"{path}.{key}"

/-- A TOML value as JSON. Dates and times are the one TOML type with no JSON counterpart; no
    setting is one, so they are reported rather than quietly stringified. -/
private partial def valueToJson (path : String) : Lake.Toml.Value → Except String Json
  | .string _ s => .ok (Json.str s)
  | .integer _ n => .ok (Json.num (JsonNumber.fromInt n))
  | .float _ f =>
    match JsonNumber.fromFloat? f with
    | .inr n => .ok (Json.num n)
    | .inl _ => .error s!"'{path}' is not a finite number"
  | .boolean _ b => .ok (Json.bool b)
  | .dateTime _ _ =>
    .error s!"'{path}' is a date or a time, which no setting takes — quote it to make it a string"
  | .array _ xs => Json.arr <$> xs.mapIdxM (fun i x => valueToJson (index path i) x)
  | .table _ t => do
    let mut out := Json.mkObj []
    for (k, v) in t.items do
      let key := k.toString (escape := false)
      out := out.setObjVal! key (← valueToJson (child path key) v)
    return out

/-- Read a TOML document as JSON. `fileName` appears in parse errors, which carry a line and
    column; the errors from the JSON conversion carry the dotted key instead. -/
def parse (input : String) (fileName : String := "config.toml") : IO (Except String Json) := do
  match ← (Lake.Toml.loadToml (Lean.Parser.mkInputContext input fileName)).toBaseIO with
  | .ok table => return valueToJson "" (.table .missing table)
  | .error log =>
    let msgs ← log.toList.mapM (·.toString)
    return .error ("; ".intercalate (msgs.map (·.trimAscii.toString)))

/-- Read a TOML file as JSON. -/
def load (path : System.FilePath) : IO (Except String Json) := do
  parse (← IO.FS.readFile path) path.toString

end Taxis.Toml
