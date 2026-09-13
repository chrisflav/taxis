import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Domain.Input

/-!
# Actor repository

Actors have a many-to-many relationship with groups via `actor_groups`.

Every statement here is a `Query`, an `Insert`, an `Update` or a `Delete` of the `db` library
rather than SQL text, so the column names, their types and the tables they belong to are checked
when this module is compiled.
-/

open Lean

namespace Taxis.Db

open Schema (ActorsIndex ActorGroupsIndex)

private abbrev taxis : Database := HasModel.database Schema.Actors

private abbrev actorsTable : taxis.Index := (HasModel.model Schema.Actors).index

/-- The `actors` table as a view: what a condition over an actor row is written against. -/
private abbrev actorsView : View taxis := Table.view actorsTable

/-- The groups an actor belongs to, ordered by id. -/
private def actorGroups (db : Conn) (id : ActorId) : IO (Array GroupId) := do
  let rows ← run db <| HasModel.fetch (α := Schema.ActorGroups)
    { query := .orderBy [{ column := ActorGroupsIndex.group_id }]
        (.filter (.eq (.var ActorGroupsIndex.actor_id .int) (.int id.val.toInt)) (.all _)) }
  return rows.map fun r => ⟨Int64.ofInt r.group_id⟩

/-- A stored row as the domain value, with its group memberships read alongside. -/
private def actorOfRow (r : Schema.Actors) (db : Conn) : IO Actor := do
  let id : ActorId := ⟨Int64.ofInt r.id⟩
  return { id := id, email := r.email, displayName := r.display_name,
           groups := ← actorGroups db id, googleSub := r.google_sub, githubId := r.github_id,
           admin := r.admin, bot := r.bot }

private def setActorGroups (db : Conn) (id : ActorId) (groups : Array GroupId) : IO Unit :=
  run db do
    discard <| HasModel.delete (α := Schema.ActorGroups)
      (.eq (.var ActorGroupsIndex.actor_id .int) (.int id.val.toInt))
    for g in groups do
      -- The pair is the primary key, so a repeated group in the input conflicts and is skipped.
      discard <| HasModel.insertIfAbsent
        ({ actor_id := id.val.toInt, group_id := g.val.toInt } : Schema.ActorGroups)

/-- The single actor a condition matches, if there is one. -/
private def actorWhere (db : Conn) (cond : DBExpr taxis actorsView .bool) : IO (Option Actor) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Actors) { query := .filter cond (.all _) }
  match rows[0]? with
  | none => pure none
  | some r => some <$> actorOfRow r db

/-- Fetch an actor by id. -/
def getActor (db : Conn) (id : ActorId) : IO (Option Actor) :=
  actorWhere db (.eq (.var ActorsIndex.id .int) (.int id.val.toInt))

/-- Fetch an actor by their linked Google subject id. -/
def getActorByGoogleSub (db : Conn) (sub : String) : IO (Option Actor) :=
  actorWhere db (.eq (.var ActorsIndex.google_sub .text) (.text sub))

/-- Fetch an actor by their linked GitHub user id. -/
def getActorByGithubId (db : Conn) (id : String) : IO (Option Actor) :=
  actorWhere db (.eq (.var ActorsIndex.github_id .text) (.text id))

/-- Fetch an actor by email address. -/
def getActorByEmail (db : Conn) (email : String) : IO (Option Actor) :=
  actorWhere db (.eq (.var ActorsIndex.email .text) (.text email))

/-- Link a Google subject id to an existing actor. -/
def linkGoogleSub (db : Conn) (id : ActorId) (sub : String) : IO Unit :=
  run db do
    discard <| HasModel.update (α := Schema.Actors)
      { value
          | .google_sub => some (.text sub)
          | _ => none
        condition := .eq (.var ActorsIndex.id .int) (.int id.val.toInt) }

/-- Link a GitHub user id to an existing actor. -/
def linkGithubId (db : Conn) (id : ActorId) (githubId : String) : IO Unit :=
  run db do
    discard <| HasModel.update (α := Schema.Actors)
      { value
          | .github_id => some (.text githubId)
          | _ => none
        condition := .eq (.var ActorsIndex.id .int) (.int id.val.toInt) }

/-- All actors, ordered by id. -/
def listActors (db : Conn) : IO (Array Actor) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Actors)
    { query := .orderBy [{ column := ActorsIndex.id }] (.all _) }
  rows.mapM (actorOfRow · db)

/-- Create an actor with its group memberships.

    It is `insertReturning` that reports the generated id, which is what the `RETURNING` clause
    used to do. -/
def createActor (db : Conn) (input : ActorInput) : IO Actor :=
  withTransaction db do
    let stored ← run db <| HasModel.insertReturning
      ({ id := 0, email := input.email, display_name := input.displayName,
         google_sub := input.googleSub, github_id := input.githubId, admin := input.admin,
         bot := input.bot } : Schema.Actors)
    setActorGroups db ⟨Int64.ofInt stored.id⟩ input.groups
    actorOfRow stored db

/-- Update an actor; absent fields are unchanged. Returns `none` if it does not exist. -/
def updateActor (db : Conn) (id : ActorId) (upd : ActorUpdate) : IO (Option Actor) :=
  withTransaction db do
    match ← getActor db id with
    | none => pure none
    | some a =>
      let email := upd.email.getD a.email
      let displayName := upd.displayName.getD a.displayName
      let googleSub := match upd.googleSub with | some s => some s | none => a.googleSub
      let githubId := match upd.githubId with | some s => some s | none => a.githubId
      let admin := upd.admin.getD a.admin
      let bot := upd.bot.getD a.bot
      discard <| run db <| HasModel.update (α := Schema.Actors)
        { value
            | .email => some (.text email)
            | .display_name => some (.text displayName)
            | .google_sub => some (match googleSub with
                                   | some s => .text s
                                   | none => .null .text)
            | .github_id => some (match githubId with
                                  | some s => .text s
                                  | none => .null .text)
            | .admin => some (if admin then .true else .false)
            | .bot => some (if bot then .true else .false)
            | _ => none
          condition := .eq (.var ActorsIndex.id .int) (.int id.val.toInt) }
      if let some gs := upd.groups then setActorGroups db id gs
      getActor db id

/-- Set an actor's admin flag (used to bootstrap admins from configuration). -/
def setActorAdmin (db : Conn) (id : ActorId) (admin : Bool) : IO Unit :=
  run db do
    discard <| HasModel.update (α := Schema.Actors)
      { value
          | .admin => some (if admin then .true else .false)
          | _ => none
        condition := .eq (.var ActorsIndex.id .int) (.int id.val.toInt) }

/-- Delete an actor. Returns whether a row was removed. -/
def deleteActor (db : Conn) (id : ActorId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.Actors)
    (.eq (.var ActorsIndex.id .int) (.int id.val.toInt))
  return removed > 0

end Taxis.Db
