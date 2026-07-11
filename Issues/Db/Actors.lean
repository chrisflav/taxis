import Issues.Db.Connection
import Issues.Domain.Input

/-!
# Actor repository

Actors have a many-to-many relationship with groups via `actor_groups`.
-/

open Lean

namespace Issues.Db

private structure ActorRow where
  id : ActorId
  email : String
  displayName : String
  googleSub : Option String
  admin : Bool
  bot : Bool
deriving SQLite.Row, Inhabited

private def actorGroups (db : Conn) (id : ActorId) : IO (Array GroupId) := do
  (← db query!"SELECT group_id FROM actor_groups WHERE actor_id = {id} ORDER BY group_id" as GroupId).toArray

private def ActorRow.toActor (r : ActorRow) (db : Conn) : IO Actor := do
  let groups ← actorGroups db r.id
  pure { id := r.id, email := r.email, displayName := r.displayName, groups := groups, googleSub := r.googleSub, admin := r.admin, bot := r.bot }

private def setActorGroups (db : Conn) (id : ActorId) (groups : Array GroupId) : IO Unit := do
  db exec!"DELETE FROM actor_groups WHERE actor_id = {id}"
  for g in groups do
    db exec!"INSERT OR IGNORE INTO actor_groups (actor_id, group_id) VALUES ({id}, {g})"

/-- Fetch an actor by id. -/
def getActor (db : Conn) (id : ActorId) : IO (Option Actor) := do
  let rows ← (← db query!"SELECT id, email, display_name, google_sub, admin, bot FROM actors WHERE id = {id}" as ActorRow).toArray
  match rows[0]? with
  | none => pure none
  | some r => some <$> r.toActor db

/-- Fetch an actor by their linked Google subject id. -/
def getActorByGoogleSub (db : Conn) (sub : String) : IO (Option Actor) := do
  let rows ← (← db query!"SELECT id, email, display_name, google_sub, admin, bot FROM actors WHERE google_sub = {sub}" as ActorRow).toArray
  match rows[0]? with
  | none => pure none
  | some r => some <$> r.toActor db

/-- Fetch an actor by email address. -/
def getActorByEmail (db : Conn) (email : String) : IO (Option Actor) := do
  let rows ← (← db query!"SELECT id, email, display_name, google_sub, admin, bot FROM actors WHERE email = {email}" as ActorRow).toArray
  match rows[0]? with
  | none => pure none
  | some r => some <$> r.toActor db

/-- Link a Google subject id to an existing actor. -/
def linkGoogleSub (db : Conn) (id : ActorId) (sub : String) : IO Unit := do
  db exec!"UPDATE actors SET google_sub = {sub} WHERE id = {id}"

/-- All actors, ordered by id. -/
def listActors (db : Conn) : IO (Array Actor) := do
  let rows ← (← db query!"SELECT id, email, display_name, google_sub, admin, bot FROM actors ORDER BY id" as ActorRow).toArray
  rows.mapM (·.toActor db)

/-- Create an actor with its group memberships. -/
def createActor (db : Conn) (input : ActorInput) : IO Actor :=
  withTransaction db do
    let rows ← (← db query!"INSERT INTO actors (email, display_name, google_sub, admin, bot)
      VALUES ({input.email}, {input.displayName}, {input.googleSub}, {input.admin}, {input.bot})
      RETURNING id, email, display_name, google_sub, admin, bot" as ActorRow).toArray
    let r := rows[0]!
    setActorGroups db r.id input.groups
    r.toActor db

/-- Update an actor; absent fields are unchanged. Returns `none` if it does not exist. -/
def updateActor (db : Conn) (id : ActorId) (upd : ActorUpdate) : IO (Option Actor) :=
  withTransaction db do
    match ← getActor db id with
    | none => pure none
    | some a =>
      let email := upd.email.getD a.email
      let displayName := upd.displayName.getD a.displayName
      let googleSub := match upd.googleSub with | some s => some s | none => a.googleSub
      let admin := upd.admin.getD a.admin
      let bot := upd.bot.getD a.bot
      db exec!"UPDATE actors SET email = {email}, display_name = {displayName}, google_sub = {googleSub}, admin = {admin}, bot = {bot} WHERE id = {id}"
      if let some gs := upd.groups then setActorGroups db id gs
      getActor db id

/-- Set an actor's admin flag (used to bootstrap admins from configuration). -/
def setActorAdmin (db : Conn) (id : ActorId) (admin : Bool) : IO Unit := do
  db exec!"UPDATE actors SET admin = {admin} WHERE id = {id}"

/-- Delete an actor. Returns whether a row was removed. -/
def deleteActor (db : Conn) (id : ActorId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM actors WHERE id = {id} RETURNING id" as ActorId).toArray
  pure !removed.isEmpty

end Issues.Db
