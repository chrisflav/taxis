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

/-- Declares a typed id wrapping `Int64`, with JSON and SQLite instances. `parse?`/`toString` are
    built via `mkIdentFrom` (not plain identifiers in the quotation) so the generated names are
    the literal `$id.parse?`/`$id.toString` — a plain identifier here would be macro-hygienic and
    therefore unreachable by name from outside this macro. -/
macro "declare_id " id:ident : command => do
  let idName := id.getId
  let parseIdent := mkIdentFrom id (idName.str "parse?")
  let toStringIdent := mkIdentFrom id (idName.str "toString")
  `(
    structure $id where
      val : Int64
    deriving DecidableEq, Repr, BEq, Hashable, Inhabited, SQLite.ResultColumn, SQLite.QueryParam

    instance : ToJson $id where toJson x := toJson x.val
    instance : FromJson $id where fromJson? j := return { val := (← fromJson? (α := Int64) j) }
    instance : ToString $id where toString x := toString x.val

    /-- Parse an id from a decimal string, as given on a CLI or in a URL path segment. Returns
        `none` on anything that isn't a plain integer. -/
    def $parseIdent (s : String) : Option $id := s.toInt?.map fun n => ⟨Int64.ofInt n⟩
    def $toStringIdent (x : $id) : String := ToString.toString x.val
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
