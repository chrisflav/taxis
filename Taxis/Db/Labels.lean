import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Domain.Input

/-!
# Label repository

Every statement here is a `Query`, an `Insert`, an `Update` or a `Delete` of the `db` library
rather than SQL text, so the column names, their types and the tables they belong to are checked
when this module is compiled.
-/

open Lean

namespace Taxis.Db

open Schema (LabelsIndex)

/-- Default label colour when none is supplied. -/
private def defaultColor : String := "#6b7280"

/-- A stored row as the domain value. -/
private def labelOfRow (r : Schema.Labels) : Label :=
  { id := ⟨Int64.ofInt r.id⟩, name := r.name, description := r.description, color := r.color }

/-- Fetch a label by id. -/
def getLabel (db : Conn) (id : LabelId) : IO (Option Label) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Labels)
    { query := .filter (.eq (.var LabelsIndex.id .int) (.int id.val.toInt)) (.all _) }
  return rows[0]?.map labelOfRow

/-- All labels, ordered by name. -/
def listLabels (db : Conn) : IO (Array Label) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Labels)
    { query := .orderBy [{ column := LabelsIndex.name }] (.all _) }
  return rows.map labelOfRow

/-- Create a label.

    The insert supplies every column, the colour included: `insertReturning` is what reports the
    generated id, and it reports the row the database stored. -/
def createLabel (db : Conn) (input : LabelInput) : IO Label := do
  let stored ← run db <| HasModel.insertReturning
    ({ id := 0, name := input.name, description := input.description,
       color := input.color.getD defaultColor } : Schema.Labels)
  return labelOfRow stored

/-- Update a label; absent fields are unchanged. Returns `none` if it does not exist. -/
def updateLabel (db : Conn) (id : LabelId) (upd : LabelUpdate) : IO (Option Label) := do
  match ← getLabel db id with
  | none => pure none
  | some l =>
    let name := upd.name.getD l.name
    let description := match upd.description with | some d => some d | none => l.description
    let color := upd.color.getD l.color
    discard <| run db <| HasModel.update (α := Schema.Labels)
      { value
          | .name => some (.text name)
          | .description => some (match description with
                                  | some d => .text d
                                  | none => .null .text)
          | .color => some (.text color)
          | _ => none
        condition := .eq (.var LabelsIndex.id .int) (.int id.val.toInt) }
    getLabel db id

/-- Find a label by name, creating it if absent. Used when importing external labels.

    The created row carries the default colour explicitly, where the insert this replaces named
    only `name` and left the rest to the column defaults. -/
def getOrCreateLabelByName (db : Conn) (name : String) : IO LabelId := do
  let rows ← run db <| HasModel.fetch (α := Schema.Labels)
    { query := .filter (.eq (.var LabelsIndex.name .text) (.text name)) (.all _) }
  match rows[0]? with
  | some r => return ⟨Int64.ofInt r.id⟩
  | none =>
    let created ← run db <| HasModel.insertReturning
      ({ id := 0, name := name, description := none, color := defaultColor } : Schema.Labels)
    return ⟨Int64.ofInt created.id⟩

/-- Delete a label (removing it from all issues via cascade). Returns whether a row was removed. -/
def deleteLabel (db : Conn) (id : LabelId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.Labels)
    (.eq (.var LabelsIndex.id .int) (.int id.val.toInt))
  return removed > 0

end Taxis.Db
