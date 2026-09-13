import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Db.Actors
import Taxis.Domain.Input

/-!
# API token repository

Only the SHA-256 hash of a token is stored. Authentication hashes the presented secret and looks
up the row by hash, so the plaintext never touches the database. Lookups also stamp `last_used`,
from `nowSeconds` rather than from the database's `unixepoch()`.
-/

open Lean

namespace Taxis.Db

open Schema (ApiTokensIndex)

private abbrev taxis : Database := HasModel.database Schema.ApiTokens

private abbrev apiTokensTable : taxis.Index := (HasModel.model Schema.ApiTokens).index

/-! ### A narrow view over `api_tokens`

Authenticating wants whose token it is and nothing else, so the lookup projects onto that one
column rather than reading the row and discarding the hash it was found by. -/

/-- The `actor_id` column of `api_tokens`, on its own. -/
private def tokenActorView : View taxis where
  Index := IUnit "actor_id"
  name _ := .ident { tableName := apiTokensTable, columnName := ApiTokensIndex.actor_id }

private def tokenActorHom : tokenActorView.Hom (Table.view apiTokensTable) :=
  View.Hom.ofMap fun _ => ApiTokensIndex.actor_id

/-- A stored row as the domain value. The secret's hash is not part of it. -/
private def tokenOfRow (r : Schema.ApiTokens) : ApiToken :=
  { id := ⟨Int64.ofInt r.id⟩, actorId := ⟨Int64.ofInt r.actor_id⟩, name := r.name,
    tokenPrefix := r.«prefix», createdAt := ⟨Int64.ofInt r.created_at⟩,
    lastUsed := r.last_used.map fun t => ⟨Int64.ofInt t⟩ }

/-- All tokens for an actor, newest first. -/
def listTokens (db : Conn) (actorId : ActorId) : IO (Array ApiToken) := do
  let rows ← run db <| HasModel.fetch (α := Schema.ApiTokens)
    { query := .orderBy [{ column := ApiTokensIndex.id, direction := .desc }]
        (.filter (.eq (.var ApiTokensIndex.actor_id .int) (.int actorId.val.toInt)) (.all _)) }
  return rows.map tokenOfRow

/-- Create a token row from a precomputed hash and display prefix. -/
def createToken (db : Conn) (actorId : ActorId) (name tokenHash pfx : String) : IO ApiToken := do
  let now ← nowSeconds
  let stored ← run db <| HasModel.insertReturning
    ({ id := 0, actor_id := actorId.val.toInt, name := name, token_hash := tokenHash,
       «prefix» := pfx, created_at := now, last_used := none } : Schema.ApiTokens)
  return tokenOfRow stored

/-- Resolve the actor owning the token with hash `tokenHash`, stamping `last_used`. -/
def actorForTokenHash (db : Conn) (tokenHash : String) : IO (Option Actor) := do
  let rows ← run db <| DBMonad.lookup <| Query.project tokenActorHom
    (.filter (.eq (.var ApiTokensIndex.token_hash .text) (.text tokenHash))
      (.all apiTokensTable))
  match rows[0]? with
  | none => pure none
  | some row =>
    let now ← nowSeconds
    run db do
      discard <| HasModel.update (α := Schema.ApiTokens)
        { value
            | .last_used => some (.int now)
            | _ => none
          condition := .eq (.var ApiTokensIndex.token_hash .text) (.text tokenHash) }
    getActor db ⟨Int64.ofInt (row.value (⟨⟩ : IUnit "actor_id"))⟩

/-- Delete a token, scoped to its owner so one actor cannot revoke another's token.
    Returns whether a row was removed. -/
def deleteToken (db : Conn) (id : TokenId) (actorId : ActorId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.ApiTokens)
    (.and (.eq (.var ApiTokensIndex.id .int) (.int id.val.toInt))
          (.eq (.var ApiTokensIndex.actor_id .int) (.int actorId.val.toInt)))
  return removed > 0

end Taxis.Db
