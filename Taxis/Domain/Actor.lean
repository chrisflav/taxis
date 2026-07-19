import Taxis.Domain.Ids

/-!
# Actors and groups

An actor is someone assigned to or responsible for an issue (a human or a bot). Only actors with
a linked Google (`googleSub`) or GitHub (`githubId`) account can authenticate against the
backend. A group is a collection of actors used as a visibility/permission filter.
-/

open Lean

namespace Taxis

/-- A group of actors, used as a visibility filter. -/
structure Group where
  id : GroupId
  name : String
  description : Option String := none
deriving Repr, BEq, Inhabited, ToJson, FromJson

/-- An actor: a human contributor or a bot. -/
structure Actor where
  id : ActorId
  email : String
  displayName : String
  groups : Array GroupId := #[]
  /-- Google `sub` claim of the linked account, if any. `none` ⇒ cannot authenticate via Google. -/
  googleSub : Option String := none
  /-- GitHub user id of the linked account, if any. `none` ⇒ cannot authenticate via GitHub. -/
  githubId : Option String := none
  /-- Administrators may manage actors, groups, labels, and run imports. -/
  admin : Bool := false
  /-- Whether this actor is a bot (rendered with a bot marker wherever the name is shown). -/
  bot : Bool := false
deriving Repr, BEq, Inhabited, ToJson, FromJson

end Taxis
