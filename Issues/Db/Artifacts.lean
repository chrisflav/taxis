import Issues.Db.Connection
import Issues.Domain.Input

/-!
# Artifact repository

Artifacts belong to a single issue. The opaque `payload` is stored as a JSON string.
-/

open Lean

namespace Issues.Db

private structure ArtifactRow where
  id : ArtifactId
  kind : String
  payload : String
deriving SQLite.Row, Inhabited

private def ArtifactRow.toArtifact (r : ArtifactRow) : Artifact :=
  { id := r.id, kind := r.kind, payload := (Json.parse r.payload).toOption.getD .null }

/-- All artifacts attached to an issue. -/
def issueArtifacts (db : Conn) (issueId : IssueId) : IO (Array Artifact) := do
  let rows ← (← db query!"SELECT id, kind, payload FROM artifacts WHERE issue_id = {issueId} ORDER BY id" as ArtifactRow).toArray
  pure (rows.map ArtifactRow.toArtifact)

/-- Fetch a single artifact by id. -/
def getArtifact (db : Conn) (id : ArtifactId) : IO (Option Artifact) := do
  let rows ← (← db query!"SELECT id, kind, payload FROM artifacts WHERE id = {id}" as ArtifactRow).toArray
  pure (rows[0]?.map ArtifactRow.toArtifact)

/-- The issue an artifact is attached to, if any. -/
def artifactIssue (db : Conn) (id : ArtifactId) : IO (Option IssueId) := do
  let rows ← (← db query!"SELECT issue_id FROM artifacts WHERE id = {id}" as IssueId).toArray
  pure rows[0]?

/-- Attach a new artifact to an issue. -/
def createArtifact (db : Conn) (issueId : IssueId) (input : ArtifactInput) : IO Artifact := do
  let payloadStr := input.payload.compress
  let rows ← (← db query!"INSERT INTO artifacts (issue_id, kind, payload) VALUES ({issueId}, {input.kind}, {payloadStr})
    RETURNING id, kind, payload" as ArtifactRow).toArray
  pure (rows[0]!.toArtifact)

/-- Delete an artifact. Returns whether a row was removed. -/
def deleteArtifact (db : Conn) (id : ArtifactId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM artifacts WHERE id = {id} RETURNING id" as ArtifactId).toArray
  pure !removed.isEmpty

end Issues.Db
