import Taxis.Json
import SQLite

/-!
# Status enumerations

Issue lifecycle state and check outcome, each serialised as a lowercase string on the wire
and stored as `TEXT` in the database.
-/

open Lean

namespace Taxis

/-- Lifecycle state of an issue. -/
inductive IssueState where
  | open
  | closed
  | completed
deriving DecidableEq, Repr, BEq, Inhabited

namespace IssueState

def toString : IssueState → String
  | .open => "open"
  | .closed => "closed"
  | .completed => "completed"

def ofString? : String → Option IssueState
  | "open" => some .open
  | "closed" => some .closed
  | "completed" => some .completed
  | _ => none

instance : ToString IssueState := ⟨toString⟩

instance : ToJson IssueState where toJson s := toJson s.toString
instance : FromJson IssueState where
  fromJson? j := do
    let s ← fromJson? (α := String) j
    match ofString? s with
    | some v => pure v
    | none => throw s!"invalid issue state: {s}"

instance : SQLite.QueryParam IssueState where
  bind stmt i s := SQLite.QueryParam.bind stmt i s.toString
instance : SQLite.ResultColumn IssueState where
  get stmt i := do
    let s ← SQLite.ResultColumn.get (α := String) stmt i
    match ofString? s with
    | some v => pure v
    | none => throw (IO.userError s!"invalid issue state in database: {s}")

end IssueState

/-- Outcome of evaluating a check. -/
inductive CheckStatus where
  | pending
  | passing
  | failing
  | error
deriving DecidableEq, Repr, BEq, Inhabited

namespace CheckStatus

def toString : CheckStatus → String
  | .pending => "pending"
  | .passing => "passing"
  | .failing => "failing"
  | .error => "error"

def ofString? : String → Option CheckStatus
  | "pending" => some .pending
  | "passing" => some .passing
  | "failing" => some .failing
  | "error" => some .error
  | _ => none

instance : ToString CheckStatus := ⟨toString⟩

instance : ToJson CheckStatus where toJson s := toJson s.toString
instance : FromJson CheckStatus where
  fromJson? j := do
    let s ← fromJson? (α := String) j
    match ofString? s with
    | some v => pure v
    | none => throw s!"invalid check status: {s}"

instance : SQLite.QueryParam CheckStatus where
  bind stmt i s := SQLite.QueryParam.bind stmt i s.toString
instance : SQLite.ResultColumn CheckStatus where
  get stmt i := do
    let s ← SQLite.ResultColumn.get (α := String) stmt i
    match ofString? s with
    | some v => pure v
    | none => throw (IO.userError s!"invalid check status in database: {s}")

end CheckStatus

end Taxis
