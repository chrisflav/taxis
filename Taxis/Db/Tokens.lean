import Taxis.Db.Connection
import Taxis.Db.Actors
import Taxis.Domain.Input

/-!
# API token repository

Only the SHA-256 hash of a token is stored. Authentication hashes the presented secret and looks
up the row by hash, so the plaintext never touches the database. Lookups also stamp `last_used`.
-/

open Lean

namespace Taxis.Db

private structure TokenRow where
  id : TokenId
  actorId : ActorId
  name : String
  tokenPrefix : String
  createdAt : Timestamp
  lastUsed : Option Timestamp
deriving SQLite.Row, Inhabited

private def TokenRow.toToken (r : TokenRow) : ApiToken :=
  { id := r.id, actorId := r.actorId, name := r.name, tokenPrefix := r.tokenPrefix,
    createdAt := r.createdAt, lastUsed := r.lastUsed }

/-- All tokens for an actor, newest first. -/
def listTokens (db : Conn) (actorId : ActorId) : IO (Array ApiToken) := do
  let rows ← (← db query!"SELECT id, actor_id, name, prefix, created_at, last_used FROM api_tokens
    WHERE actor_id = {actorId} ORDER BY id DESC" as TokenRow).toArray
  pure (rows.map TokenRow.toToken)

/-- Create a token row from a precomputed hash and display prefix. -/
def createToken (db : Conn) (actorId : ActorId) (name tokenHash pfx : String) : IO ApiToken := do
  let rows ← (← db query!"INSERT INTO api_tokens (actor_id, name, token_hash, prefix)
    VALUES ({actorId}, {name}, {tokenHash}, {pfx})
    RETURNING id, actor_id, name, prefix, created_at, last_used" as TokenRow).toArray
  pure (rows[0]!.toToken)

/-- Resolve the actor owning the token with hash `tokenHash`, stamping `last_used`. -/
def actorForTokenHash (db : Conn) (tokenHash : String) : IO (Option Actor) := do
  let ids ← (← db query!"SELECT actor_id FROM api_tokens WHERE token_hash = {tokenHash}" as ActorId).toArray
  match ids[0]? with
  | none => pure none
  | some actorId =>
    db exec!"UPDATE api_tokens SET last_used = unixepoch() WHERE token_hash = {tokenHash}"
    getActor db actorId

/-- Delete a token, scoped to its owner so one actor cannot revoke another's token.
    Returns whether a row was removed. -/
def deleteToken (db : Conn) (id : TokenId) (actorId : ActorId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM api_tokens WHERE id = {id} AND actor_id = {actorId} RETURNING id" as TokenId).toArray
  pure !removed.isEmpty

end Taxis.Db
