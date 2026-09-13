import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Domain.Input

/-!
# Check repository

Checks belong to a single issue. The opaque `config` is stored as a JSON string; `status`,
`detail`, and `last_run` are updated by the check-execution engine.

Every statement here is a `Query`, an `Insert`, an `Update` or a `Delete` of the `db` library
rather than SQL text, so the column names, their types and the tables they belong to are checked
when this module is compiled.
-/

open Lean

namespace Taxis.Db

open Schema (ChecksIndex)

private abbrev taxis : Database := HasModel.database Schema.Checks

private abbrev checksTable : taxis.Index := (HasModel.model Schema.Checks).index

/-! ### Narrow views over `checks`

The sweeper wants every check's id and issue, and a single lookup wants an issue id: neither wants
the plugin configuration or the last verdict's detail, which is most of the row. -/

/-- The two columns the sweeper reads, and the one an issue lookup does. -/
private inductive CheckPairColumn where
  | issue_id | id
  deriving DecidableEq, Hashable, Repr, Enum

instance : ToString CheckPairColumn where
  toString
    | .issue_id => "issue_id"
    | .id => "id"

instance : FromString CheckPairColumn where
  fromString
    | "issue_id" => some .issue_id
    | "id" => some .id
    | _ => none

instance : Indexing CheckPairColumn where

private def CheckPairColumn.toChecks : CheckPairColumn → Schema.ChecksIndex
  | .issue_id => .issue_id
  | .id => .id

private def checkPairView : View taxis where
  Index := CheckPairColumn
  name c := .ident { tableName := checksTable, columnName := c.toChecks }

private def checkPairHom : checkPairView.Hom (Table.view checksTable) :=
  View.Hom.ofMap CheckPairColumn.toChecks

/-- The stored `status` string as the check-outcome enum.

    The column is `text` rather than an enumerated type, so a value the domain does not know is
    possible in principle; it can only come from something other than this application writing the
    row, and reading it as one of the four would be worse than failing. -/
private def checkStatusOf (s : String) : IO CheckStatus :=
  match CheckStatus.ofString? s with
  | some st => pure st
  | none => throw (IO.userError s!"invalid check status in database: {s}")

/-- A stored row as the domain value. -/
private def checkOfRow (r : Schema.Checks) : IO Check := do
  return { id := ⟨Int64.ofInt r.id⟩, kind := r.kind,
           config := (Json.parse r.config).toOption.getD .null,
           status := ← checkStatusOf r.status, detail := r.detail,
           lastRun := r.last_run.map fun t => ⟨Int64.ofInt t⟩ }

/-- All checks attached to an issue. -/
def issueChecks (db : Conn) (issueId : IssueId) : IO (Array Check) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Checks)
    { query := .orderBy [{ column := ChecksIndex.id }]
        (.filter (.eq (.var ChecksIndex.issue_id .int) (.int issueId.val.toInt)) (.all _)) }
  rows.mapM checkOfRow

/-- Every check in the tracker, paired with the issue it belongs to. Used by the sweeper. -/
def allChecks (db : Conn) : IO (Array (CheckId × IssueId)) := do
  let rows ← run db <| DBMonad.lookup <| Query.project checkPairHom
    (.orderBy [{ column := ChecksIndex.id }] (.all checksTable))
  return rows.map fun row =>
    (⟨Int64.ofInt (row.value CheckPairColumn.id)⟩,
     ⟨Int64.ofInt (row.value CheckPairColumn.issue_id)⟩)

/-- Fetch a single check by id. -/
def getCheck (db : Conn) (id : CheckId) : IO (Option Check) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Checks)
    { query := .filter (.eq (.var ChecksIndex.id .int) (.int id.val.toInt)) (.all _) }
  match rows[0]? with
  | none => pure none
  | some r => some <$> checkOfRow r

/-- The issue a check is attached to, if any. -/
def checkIssue (db : Conn) (id : CheckId) : IO (Option IssueId) := do
  let rows ← run db <| DBMonad.lookup <| Query.project checkPairHom
    (.filter (.eq (.var ChecksIndex.id .int) (.int id.val.toInt)) (.all checksTable))
  return rows[0]?.map fun row => ⟨Int64.ofInt (row.value CheckPairColumn.issue_id)⟩

/-- Attach a new check to an issue (initially `pending`).

    The insert supplies every column, the initial status included: the model layer sends the whole
    row, where the statement this replaces named three and left the rest to the column defaults. -/
def createCheck (db : Conn) (issueId : IssueId) (input : CheckInput) : IO Check := do
  let stored ← run db <| HasModel.insertReturning
    ({ id := 0, issue_id := issueId.val.toInt, kind := input.kind,
       config := input.config.compress, status := CheckStatus.pending.toString, detail := none,
       last_run := none } : Schema.Checks)
  checkOfRow stored

/-- Record the outcome of evaluating a check, stamping `last_run` from `nowSeconds` — the query
    language has no expression for the `unixepoch()` the database used to evaluate, and the two
    agree to the second. -/
def recordCheckResult (db : Conn) (id : CheckId) (status : CheckStatus) (detail : Option String) :
    IO Unit := do
  let now ← nowSeconds
  run db do
    discard <| HasModel.update (α := Schema.Checks)
      { value
          | .status => some (.text status.toString)
          | .detail => some (match detail with
                             | some d => .text d
                             | none => .null .text)
          | .last_run => some (.int now)
          | _ => none
        condition := .eq (.var ChecksIndex.id .int) (.int id.val.toInt) }

/-- Replace a check's config, keeping its kind, and put it back to `pending`.

    The previous status described the *old* config, so carrying it over would leave a check
    reporting `passing` for a condition nobody has evaluated yet — and, since a non-passing check
    blocks completing an issue, that is the direction that silently lets work through. Clearing it
    makes the check say what is true: not run since it changed. -/
def updateCheckConfig (db : Conn) (id : CheckId) (config : Json) : IO Bool := do
  let updated ← run db <| HasModel.update (α := Schema.Checks)
    { value
        | .config => some (.text config.compress)
        | .status => some (.text CheckStatus.pending.toString)
        | .detail => some (.null .text)
        | .last_run => some (.null .int)
        | _ => none
      condition := .eq (.var ChecksIndex.id .int) (.int id.val.toInt) }
  return updated > 0

/-- Delete a check. Returns whether a row was removed. -/
def deleteCheck (db : Conn) (id : CheckId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.Checks)
    (.eq (.var ChecksIndex.id .int) (.int id.val.toInt))
  return removed > 0

end Taxis.Db
