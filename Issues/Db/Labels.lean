import Issues.Db.Connection
import Issues.Domain.Input

/-!
# Label repository
-/

open Lean

namespace Issues.Db

private structure LabelRow where
  id : LabelId
  name : String
  description : Option String
  color : String
deriving SQLite.Row, Inhabited

private def LabelRow.toLabel (r : LabelRow) : Label :=
  { id := r.id, name := r.name, description := r.description, color := r.color }

/-- Default label colour when none is supplied. -/
private def defaultColor : String := "#6b7280"

/-- Fetch a label by id. -/
def getLabel (db : Conn) (id : LabelId) : IO (Option Label) := do
  let rows ← (← db query!"SELECT id, name, description, color FROM labels WHERE id = {id}" as LabelRow).toArray
  pure (rows[0]?.map LabelRow.toLabel)

/-- All labels, ordered by name. -/
def listLabels (db : Conn) : IO (Array Label) := do
  let rows ← (← db query!"SELECT id, name, description, color FROM labels ORDER BY name" as LabelRow).toArray
  pure (rows.map LabelRow.toLabel)

/-- Create a label. -/
def createLabel (db : Conn) (input : LabelInput) : IO Label := do
  let color := input.color.getD defaultColor
  let rows ← (← db query!"INSERT INTO labels (name, description, color) VALUES ({input.name}, {input.description}, {color})
    RETURNING id, name, description, color" as LabelRow).toArray
  pure (rows[0]!.toLabel)

/-- Update a label; absent fields are unchanged. Returns `none` if it does not exist. -/
def updateLabel (db : Conn) (id : LabelId) (upd : LabelUpdate) : IO (Option Label) := do
  match ← getLabel db id with
  | none => pure none
  | some l =>
    let name := upd.name.getD l.name
    let description := match upd.description with | some d => some d | none => l.description
    let color := upd.color.getD l.color
    db exec!"UPDATE labels SET name = {name}, description = {description}, color = {color} WHERE id = {id}"
    getLabel db id

/-- Find a label by name, creating it if absent. Used when importing external labels. -/
def getOrCreateLabelByName (db : Conn) (name : String) : IO LabelId := do
  let rows ← (← db query!"SELECT id, name, description, color FROM labels WHERE name = {name}" as LabelRow).toArray
  match rows[0]? with
  | some r => pure r.id
  | none =>
    let created ← (← db query!"INSERT INTO labels (name) VALUES ({name}) RETURNING id, name, description, color" as LabelRow).toArray
    pure created[0]!.id

/-- Delete a label (removing it from all issues via cascade). Returns whether a row was removed. -/
def deleteLabel (db : Conn) (id : LabelId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM labels WHERE id = {id} RETURNING id" as LabelId).toArray
  pure !removed.isEmpty

end Issues.Db
