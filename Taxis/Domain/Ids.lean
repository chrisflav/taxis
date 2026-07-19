import Taxis.Json
import SQLite

/-!
# Typed identifiers

Each entity gets a distinct id type wrapping an `Int64` (the SQLite integer primary key),
so ids for different entities cannot be mixed up. Each id serialises to/from a bare JSON
number and binds/reads directly as a SQLite column.
-/

open Lean

namespace Taxis

/-- Declares a typed id wrapping `Int64`, with JSON and SQLite instances. -/
macro "declare_id " id:ident : command => `(
  structure $id where
    val : Int64
  deriving DecidableEq, Repr, BEq, Hashable, Inhabited, SQLite.ResultColumn, SQLite.QueryParam

  instance : ToJson $id where toJson x := toJson x.val
  instance : FromJson $id where fromJson? j := return { val := (← fromJson? (α := Int64) j) }
)

declare_id ActorId
declare_id GroupId
declare_id IssueId
declare_id ArtifactId
declare_id CheckId
declare_id LabelId
declare_id SessionId
declare_id CommentId
declare_id TokenId
declare_id EventId
declare_id NotificationId
declare_id ReviewRequestId

/-- A wall-clock instant, stored as Unix time in seconds. -/
structure Timestamp where
  epochSeconds : Int64
deriving DecidableEq, Repr, BEq, Inhabited, SQLite.ResultColumn, SQLite.QueryParam

instance : ToJson Timestamp where toJson x := toJson x.epochSeconds
instance : FromJson Timestamp where fromJson? j := return { epochSeconds := (← fromJson? (α := Int64) j) }

end Taxis
