import Taxis.Db.Connection
import Taxis.Db.Actors

/-!
# Session repository

Opaque session tokens map to an actor with an expiry. Lookups only return non-expired sessions.
-/

open Lean

namespace Taxis.Db

/-- Create a session for `actorId` valid for `ttlSeconds`, keyed by `token`. -/
def createSession (db : Conn) (token : String) (actorId : ActorId) (ttlSeconds : Int64) : IO Unit := do
  db exec!"INSERT INTO sessions (id, actor_id, expires_at) VALUES ({token}, {actorId}, unixepoch() + {ttlSeconds})"

/-- Resolve the actor for a live (non-expired) session token. -/
def sessionActor (db : Conn) (token : String) : IO (Option Actor) := do
  let ids ← (← db query!"SELECT actor_id FROM sessions WHERE id = {token} AND expires_at > unixepoch()" as ActorId).toArray
  match ids[0]? with
  | none => pure none
  | some id => getActor db id

/-- Delete a session (logout). -/
def deleteSession (db : Conn) (token : String) : IO Unit := do
  db exec!"DELETE FROM sessions WHERE id = {token}"

/-- Remove all expired sessions. -/
def pruneSessions (db : Conn) : IO Unit := do
  db exec!"DELETE FROM sessions WHERE expires_at <= unixepoch()"

end Taxis.Db
