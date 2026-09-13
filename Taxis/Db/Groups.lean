import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Domain.Input

/-!
# Group repository

Every statement here is a `Query`, an `Insert`, an `Update` or a `Delete` of the `db` library
rather than SQL text, so the column names, their types and the tables they belong to are checked
when this module is compiled.
-/

open Lean

namespace Taxis.Db

open Schema (GroupsIndex ActorGroupsIndex)

/-- A stored row as the domain value. -/
private def groupOfRow (r : Schema.Groups) : Group :=
  { id := ⟨Int64.ofInt r.id⟩, name := r.name, description := r.description }

/-- Fetch a group by id. -/
def getGroup (db : Conn) (id : GroupId) : IO (Option Group) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Groups)
    { query := .filter (.eq (.var GroupsIndex.id .int) (.int id.val.toInt)) (.all _) }
  return rows[0]?.map groupOfRow

/-- Fetch a group by name. Names are unique, so this identifies one group. -/
def getGroupByName (db : Conn) (name : String) : IO (Option Group) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Groups)
    { query := .filter (.eq (.var GroupsIndex.name .text) (.text name)) (.all _) }
  return rows[0]?.map groupOfRow

/-- All groups, ordered by id. -/
def listGroups (db : Conn) : IO (Array Group) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Groups)
    { query := .orderBy [{ column := GroupsIndex.id }] (.all _) }
  return rows.map groupOfRow

/-- Create a group. -/
def createGroup (db : Conn) (input : GroupInput) : IO Group := do
  let stored ← run db <| HasModel.insertReturning
    ({ id := 0, name := input.name, description := input.description } : Schema.Groups)
  return groupOfRow stored

/-- The group called `name`, created if there is not one already.

    What `auth.readGroups` is resolved through at startup: naming a group that does not exist yet
    is how an operator turns private mode on for a fresh instance, and the alternative to creating
    it is refusing to start over a group they can only create by starting. -/
def getOrCreateGroupByName (db : Conn) (name : String) : IO Group := do
  match ← getGroupByName db name with
  | some g => pure g
  | none => createGroup db { name }

/-- How many actors belong to a group. Reported at startup for the groups that gate read access,
    where an unexpected zero is the difference between noticing at boot and hearing about it from
    a colleague who cannot get in.

    Counted by the database rather than by fetching the memberships and counting them here. -/
def groupMemberCount (db : Conn) (id : GroupId) : IO Nat := do
  let n ← run db <| HasModel.count (α := Schema.ActorGroups)
    { query := .filter (.eq (.var ActorGroupsIndex.group_id .int) (.int id.val.toInt)) (.all _) }
  return n.toNat

/-- Update a group; absent fields are unchanged. Returns `none` if it does not exist. -/
def updateGroup (db : Conn) (id : GroupId) (upd : GroupUpdate) : IO (Option Group) := do
  match ← getGroup db id with
  | none => pure none
  | some g =>
    let name := upd.name.getD g.name
    let description := match upd.description with | some d => some d | none => g.description
    discard <| run db <| HasModel.update (α := Schema.Groups)
      { value
          | .name => some (.text name)
          | .description => some (match description with
                                  | some d => .text d
                                  | none => .null .text)
          | _ => none
        condition := .eq (.var GroupsIndex.id .int) (.int id.val.toInt) }
    getGroup db id

/-- Delete a group. Returns whether a row was removed. -/
def deleteGroup (db : Conn) (id : GroupId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.Groups)
    (.eq (.var GroupsIndex.id .int) (.int id.val.toInt))
  return removed > 0

end Taxis.Db
