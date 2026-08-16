import Taxis.Db.Connection
import Taxis.Domain.Input

/-!
# Group repository
-/

open Lean

namespace Taxis.Db

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

/-- Fetch a group by name. Names are unique, so this identifies one group. -/
def getGroupByName (db : Conn) (name : String) : IO (Option Group) := do
  let rows ← (← db query!"SELECT id, name, description FROM groups WHERE name = {name}" as GroupRow).toArray
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

/-- The group called `name`, created if there is not one already.

    What `auth.readGroups` is resolved through at startup: naming a group that does not exist yet
    is how an operator turns private mode on for a fresh instance, and the alternative to creating
    it is refusing to start over a group they can only create by starting. -/
def getOrCreateGroupByName (db : Conn) (name : String) : IO Group := do
  match ← getGroupByName db name with
  | some g => pure g
  | none => createGroup db { name }

-- Not `CountRow`: `private` keeps a name out of scope, not out of the environment, and
-- `Taxis.Db.Issues` already has one under that name — importing both then fails to elaborate.
private structure GroupCountRow where
  n : Int64
deriving SQLite.Row, Inhabited

/-- How many actors belong to a group. Reported at startup for the groups that gate read access,
    where an unexpected zero is the difference between noticing at boot and hearing about it from
    a colleague who cannot get in. -/
def groupMemberCount (db : Conn) (id : GroupId) : IO Nat := do
  let rows ← (← db query!"SELECT COUNT(*) FROM actor_groups WHERE group_id = {id}" as GroupCountRow).toArray
  pure ((rows[0]?.map (·.n.toNatClampNeg)).getD 0)

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

end Taxis.Db
