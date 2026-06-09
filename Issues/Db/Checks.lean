import Issues.Db.Connection
import Issues.Domain.Input

/-!
# Check repository

Checks belong to a single issue. The opaque `config` is stored as a JSON string; `status`,
`detail`, and `last_run` are updated by the check-execution engine.
-/

open Lean

namespace Issues.Db

private structure CheckRow where
  id : CheckId
  kind : String
  config : String
  status : CheckStatus
  detail : Option String
  lastRun : Option Timestamp
deriving SQLite.Row, Inhabited

private def CheckRow.toCheck (r : CheckRow) : Check :=
  { id := r.id, kind := r.kind, config := (Json.parse r.config).toOption.getD .null,
    status := r.status, detail := r.detail, lastRun := r.lastRun }

/-- All checks attached to an issue. -/
def issueChecks (db : Conn) (issueId : IssueId) : IO (Array Check) := do
  let rows ← (← db query!"SELECT id, kind, config, status, detail, last_run FROM checks WHERE issue_id = {issueId} ORDER BY id" as CheckRow).toArray
  pure (rows.map CheckRow.toCheck)

/-- Every check in the tracker, paired with the issue it belongs to. Used by the sweeper. -/
def allChecks (db : Conn) : IO (Array (CheckId × IssueId)) := do
  (← db query!"SELECT id, issue_id FROM checks ORDER BY id" as (CheckId × IssueId)).toArray

/-- Fetch a single check by id. -/
def getCheck (db : Conn) (id : CheckId) : IO (Option Check) := do
  let rows ← (← db query!"SELECT id, kind, config, status, detail, last_run FROM checks WHERE id = {id}" as CheckRow).toArray
  pure (rows[0]?.map CheckRow.toCheck)

/-- The issue a check is attached to, if any. -/
def checkIssue (db : Conn) (id : CheckId) : IO (Option IssueId) := do
  let rows ← (← db query!"SELECT issue_id FROM checks WHERE id = {id}" as IssueId).toArray
  pure rows[0]?

/-- Attach a new check to an issue (initially `pending`). -/
def createCheck (db : Conn) (issueId : IssueId) (input : CheckInput) : IO Check := do
  let configStr := input.config.compress
  let rows ← (← db query!"INSERT INTO checks (issue_id, kind, config) VALUES ({issueId}, {input.kind}, {configStr})
    RETURNING id, kind, config, status, detail, last_run" as CheckRow).toArray
  pure (rows[0]!.toCheck)

/-- Record the outcome of evaluating a check, stamping `last_run` with the database clock. -/
def recordCheckResult (db : Conn) (id : CheckId) (status : CheckStatus) (detail : Option String) : IO Unit := do
  db exec!"UPDATE checks SET status = {status}, detail = {detail}, last_run = unixepoch() WHERE id = {id}"

/-- Delete a check. Returns whether a row was removed. -/
def deleteCheck (db : Conn) (id : CheckId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM checks WHERE id = {id} RETURNING id" as CheckId).toArray
  pure !removed.isEmpty

end Issues.Db
