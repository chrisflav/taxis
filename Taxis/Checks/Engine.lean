import Taxis.Db
import Taxis.Plugins

/-!
# Check execution engine

Runs a check by looking up its handler by `kind`, evaluating it against the issue and the issue's
artifacts, and persisting the outcome. Also provides a whole-tracker sweep used by the background
scheduler.
-/

open Lean

namespace Taxis.Checks

/-- Run a single check by id, persist and return the updated check. `none` if it doesn't exist. -/
def runCheck (db : Db.Conn) (id : CheckId) : IO (Option Check) := do
  match ← Db.getCheck db id with
  | none => pure none
  | some check =>
    match ← Db.checkIssue db id with
    | none => pure (some check)
    | some issueId =>
      match ← Plugins.checkHandler? check.kind with
      | none =>
        Db.recordCheckResult db id .error (some s!"no registered handler for check kind '{check.kind}'")
        Db.getCheck db id
      | some handler =>
        match ← Db.getIssue db issueId with
        | none => pure (some check)
        | some issue =>
          let artifacts ← Db.issueArtifacts db issueId
          let (status, detail) ←
            try handler.evaluate db check.config issue artifacts
            catch e => pure (CheckStatus.error, some s!"evaluation raised: {e}")
          Db.recordCheckResult db id status detail
          Db.getCheck db id

/-- Evaluate every check in the tracker. Returns the number of checks run. -/
def sweep (db : Db.Conn) : IO Nat := do
  let checks ← Db.allChecks db
  for (checkId, _) in checks do
    let _ ← runCheck db checkId
  pure checks.size

end Taxis.Checks
