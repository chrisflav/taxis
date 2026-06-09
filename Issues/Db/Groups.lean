import Issues.Db.Connection
import Issues.Domain.Input

/-!
# Group repository
-/

open Lean

namespace Issues.Db

private structure GroupRow where
  id : GroupId
  name : String
  description : Option String
deriving SQLite.Row, Inhabited

private def GroupRow.toGroup (r : GroupRow) : Group :=
  { id := r.id, name := r.name, description := r.description }

/-- Fetch a group by id. -/
def getGroup (db : Conn) (id : GroupId) : IO (Option Group) := do
  let rows ← (← db query!"SELECT id, name, description FROM groups WHERE id = {id}" as GroupRow).toArray
  pure (rows[0]?.map GroupRow.toGroup)

/-- All groups, ordered by id. -/
def listGroups (db : Conn) : IO (Array Group) := do
  let rows ← (← db query!"SELECT id, name, description FROM groups ORDER BY id" as GroupRow).toArray
  pure (rows.map GroupRow.toGroup)

/-- Create a group. -/
def createGroup (db : Conn) (input : GroupInput) : IO Group := do
  let rows ← (← db query!"INSERT INTO groups (name, description) VALUES ({input.name}, {input.description})
    RETURNING id, name, description" as GroupRow).toArray
  pure (rows[0]!.toGroup)

/-- Update a group; absent fields are unchanged. Returns `none` if it does not exist. -/
def updateGroup (db : Conn) (id : GroupId) (upd : GroupUpdate) : IO (Option Group) := do
  match ← getGroup db id with
  | none => pure none
  | some g =>
    let name := upd.name.getD g.name
    let description := match upd.description with | some d => some d | none => g.description
    db exec!"UPDATE groups SET name = {name}, description = {description} WHERE id = {id}"
    getGroup db id

/-- Delete a group. Returns whether a row was removed. -/
def deleteGroup (db : Conn) (id : GroupId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM groups WHERE id = {id} RETURNING id" as GroupId).toArray
  pure !removed.isEmpty

end Issues.Db
