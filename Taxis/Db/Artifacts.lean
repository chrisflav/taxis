import Taxis.Db.Connection
import Taxis.Db.Schema
import Taxis.Domain.Input

/-!
# Artifact repository

Artifacts belong to a single issue. The opaque `payload` is stored as a JSON string.

Every statement here is a `Query`, an `Insert`, an `Update` or a `Delete` of the `db` library
rather than SQL text, so the column names, their types and the tables they belong to are checked
when this module is compiled.
-/

open Lean

namespace Taxis.Db

open Schema (ArtifactsIndex)

private abbrev taxis : Database := HasModel.database Schema.Artifacts

private abbrev artifactsTable : taxis.Index := (HasModel.model Schema.Artifacts).index

/-! ### A narrow view over `artifacts`

Asking which issue an artifact hangs off wants that one column, where the row also carries the
plugin payload — the largest thing in the table and the whole point of not reading it. -/

/-- The `issue_id` column of `artifacts`, on its own. -/
private def artifactIssueView : View taxis where
  Index := IUnit "issue_id"
  name _ := .ident { tableName := artifactsTable, columnName := ArtifactsIndex.issue_id }

private def artifactIssueHom : artifactIssueView.Hom (Table.view artifactsTable) :=
  View.Hom.ofMap fun _ => ArtifactsIndex.issue_id

/-- A stored row as the domain value. -/
private def artifactOfRow (r : Schema.Artifacts) : Artifact :=
  { id := ⟨Int64.ofInt r.id⟩, kind := r.kind,
    payload := (Json.parse r.payload).toOption.getD .null }

/-- All artifacts attached to an issue. -/
def issueArtifacts (db : Conn) (issueId : IssueId) : IO (Array Artifact) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Artifacts)
    { query := .orderBy [{ column := ArtifactsIndex.id }]
        (.filter (.eq (.var ArtifactsIndex.issue_id .int) (.int issueId.val.toInt)) (.all _)) }
  return rows.map artifactOfRow

/-- Fetch a single artifact by id. -/
def getArtifact (db : Conn) (id : ArtifactId) : IO (Option Artifact) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Artifacts)
    { query := .filter (.eq (.var ArtifactsIndex.id .int) (.int id.val.toInt)) (.all _) }
  return rows[0]?.map artifactOfRow

/-- The issue an artifact is attached to, if any. -/
def artifactIssue (db : Conn) (id : ArtifactId) : IO (Option IssueId) := do
  let rows ← run db <| DBMonad.lookup <| Query.project artifactIssueHom
    (.filter (.eq (.var ArtifactsIndex.id .int) (.int id.val.toInt)) (.all artifactsTable))
  return rows[0]?.map fun row => ⟨Int64.ofInt (row.value (⟨⟩ : IUnit "issue_id"))⟩

/-- Attach a new artifact to an issue.

    It is `insertReturning` that reports the generated id, which is what the `RETURNING` clause
    used to do. -/
def createArtifact (db : Conn) (issueId : IssueId) (input : ArtifactInput) : IO Artifact := do
  let stored ← run db <| HasModel.insertReturning
    ({ id := 0, issue_id := issueId.val.toInt, kind := input.kind,
       payload := input.payload.compress } : Schema.Artifacts)
  return artifactOfRow stored

/-- Every artifact of a kind across the whole tracker, each with the issue it hangs off. Used by
    views that are organised by artifact rather than by issue, such as the repository graph. -/
def artifactsOfKind (db : Conn) (kind : String) : IO (Array (IssueId × Artifact)) := do
  let rows ← run db <| HasModel.fetch (α := Schema.Artifacts)
    { query := .orderBy [{ column := ArtifactsIndex.id }]
        (.filter (.eq (.var ArtifactsIndex.kind .text) (.text kind)) (.all _)) }
  return rows.map fun r => (⟨Int64.ofInt r.issue_id⟩, artifactOfRow r)

/-- The issue owning a `kind` artifact whose JSON payload contains `needle` as a substring. Used
    by imports/syncs to recognise an item that was already brought in before.

    The substring match escapes the `LIKE` wildcards in `needle`, which the hand-written `LIKE`
    this replaces did not: a needle containing `%` or `_` now matches those characters rather than
    standing for anything. -/
def findArtifactIssueByPayload (db : Conn) (kind needle : String) : IO (Option IssueId) := do
  let rows ← run db <| DBMonad.lookup <| Query.limit 1 <| Query.project artifactIssueHom
    (.filter
      (.and (.eq (.var ArtifactsIndex.kind .text) (.text kind))
            (.contains (.var ArtifactsIndex.payload .text) needle))
      (.all artifactsTable))
  return rows[0]?.map fun row => ⟨Int64.ofInt (row.value (⟨⟩ : IUnit "issue_id"))⟩

/-- Replace an artifact's payload, keeping its kind. Returns whether a row was updated.

    The kind is deliberately fixed: it selects the plugin that gives the payload its shape, so
    changing it would leave the stored payload describing nothing. Attaching a different kind is a
    delete and a create. -/
def updateArtifactPayload (db : Conn) (id : ArtifactId) (payload : Json) : IO Bool := do
  let updated ← run db <| HasModel.update (α := Schema.Artifacts)
    { value
        | .payload => some (.text payload.compress)
        | _ => none
      condition := .eq (.var ArtifactsIndex.id .int) (.int id.val.toInt) }
  return updated > 0

/-- Delete an artifact. Returns whether a row was removed. -/
def deleteArtifact (db : Conn) (id : ArtifactId) : IO Bool := do
  let removed ← run db <| HasModel.delete (α := Schema.Artifacts)
    (.eq (.var ArtifactsIndex.id .int) (.int id.val.toInt))
  return removed > 0

end Taxis.Db
