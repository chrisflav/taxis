import Taxis.Domain.Ids

/-!
# API tokens

A personal access token lets a (typically bot) actor authenticate against the API without an
interactive Google login, by sending `Authorization: Bearer <token>`. Only a SHA-256 hash of the
token is stored; the plaintext is shown exactly once, at creation. The stored `prefix` (the first
few characters of the plaintext) lets a user recognise a token in the list without revealing it.
-/

open Lean

namespace Taxis

/-- An API token as returned to clients. The secret itself is never included except in the
    one-time creation response (`ApiTokenCreated`). -/
structure ApiToken where
  id : TokenId
  actorId : ActorId
  name : String := ""
  /-- First characters of the plaintext token, for recognition. -/
  tokenPrefix : String := ""
  createdAt : Timestamp
  lastUsed : Option Timestamp := none
deriving Inhabited, ToJson, FromJson

/-- The response returned once, immediately after creating a token: the metadata plus the
    plaintext secret, which is not recoverable afterwards. -/
structure ApiTokenCreated where
  token : ApiToken
  /-- The plaintext token; store it now, it cannot be retrieved again. -/
  secret : String
deriving Inhabited, ToJson, FromJson

end Taxis
