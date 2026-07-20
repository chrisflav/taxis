import Taxis.Db.Connection
import Taxis.Domain.Input

/-!
# Artifact repository

Artifacts belong to a single issue. The opaque `payload` is stored as a JSON string.
-/

open Lean

namespace Taxis.Db

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

private structure IssueArtifactRow where
  issueId : IssueId
  id : ArtifactId
  kind : String
  payload : String
deriving SQLite.Row, Inhabited

/-- Every artifact of a kind across the whole tracker, each with the issue it hangs off. Used by
    views that are organised by artifact rather than by issue, such as the repository graph. -/
def artifactsOfKind (db : Conn) (kind : String) : IO (Array (IssueId × Artifact)) := do
  let rows ← (← db query!"SELECT issue_id, id, kind, payload FROM artifacts WHERE kind = {kind}
    ORDER BY id" as IssueArtifactRow).toArray
  pure (rows.map fun r =>
    (r.issueId, { id := r.id, kind := r.kind, payload := (Json.parse r.payload).toOption.getD .null }))

/-- The issue owning a `kind` artifact whose JSON payload contains `needle` as a substring. Used
    by imports/syncs to recognise an item that was already brought in before. -/
def findArtifactIssueByPayload (db : Conn) (kind needle : String) : IO (Option IssueId) := do
  let like := "%" ++ needle ++ "%"
  let rows ← (← db query!"SELECT issue_id FROM artifacts WHERE kind = {kind} AND payload LIKE {like} LIMIT 1" as IssueId).toArray
  pure rows[0]?

/-- Delete an artifact. Returns whether a row was removed. -/
def deleteArtifact (db : Conn) (id : ArtifactId) : IO Bool := do
  let removed ← (← db query!"DELETE FROM artifacts WHERE id = {id} RETURNING id" as ArtifactId).toArray
  pure !removed.isEmpty

end Taxis.Db
