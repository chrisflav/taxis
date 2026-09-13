import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Db.Actors

/-!
# Session repository

Opaque session tokens map to an actor with an expiry. Lookups only return non-expired sessions.

The expiry and the moment it is compared against come from `nowSeconds` rather than from the
database's `unixepoch()`: the query language has no expression for a call the database evaluates,
and the two agree to the second.
-/

open Lean

namespace Taxis.Db

open Schema (SessionsIndex)

private abbrev taxis : Database := HasModel.database Schema.Sessions

private abbrev sessionsTable : taxis.Index := (HasModel.model Schema.Sessions).index

/-! ### A narrow view over `sessions`

Resolving a token wants whose session it is and nothing else, so the lookup projects onto that one
column rather than reading the row and discarding its expiry and creation time. -/

/-- The `actor_id` column of `sessions`, on its own. -/
private def sessionActorView : View taxis where
  Index := IUnit "actor_id"
  name _ := .ident { tableName := sessionsTable, columnName := SessionsIndex.actor_id }

private def sessionActorHom : sessionActorView.Hom (Table.view sessionsTable) :=
  View.Hom.ofMap fun _ => SessionsIndex.actor_id

/-- Create a session for `actorId` valid for `ttlSeconds`, keyed by `token`. -/
def createSession (db : Conn) (token : String) (actorId : ActorId) (ttlSeconds : Int64) :
    IO Unit := do
  let now ← nowSeconds
  run db <| HasModel.insert
    ({ id := token, actor_id := actorId.val.toInt, created_at := now,
       expires_at := now + ttlSeconds.toInt } : Schema.Sessions)

/-- Resolve the actor for a live (non-expired) session token. -/
def sessionActor (db : Conn) (token : String) : IO (Option Actor) := do
  let now ← nowSeconds
  let rows ← run db <| DBMonad.lookup <| Query.project sessionActorHom
    (.filter
      (.and (.eq (.var SessionsIndex.id .text) (.text token))
            (.gt (.var SessionsIndex.expires_at .int) (.int now)))
      (.all sessionsTable))
  match rows[0]? with
  | none => pure none
  | some row => getActor db ⟨Int64.ofInt (row.value (⟨⟩ : IUnit "actor_id"))⟩

/-- Delete a session (logout). -/
def deleteSession (db : Conn) (token : String) : IO Unit :=
  run db do
    discard <| HasModel.delete (α := Schema.Sessions)
      (.eq (.var SessionsIndex.id .text) (.text token))

/-- Remove all expired sessions. -/
def pruneSessions (db : Conn) : IO Unit := do
  let now ← nowSeconds
  run db do
    discard <| HasModel.delete (α := Schema.Sessions)
      (.le (.var SessionsIndex.expires_at .int) (.int now))

end Taxis.Db
