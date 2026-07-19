import Taxis.Plugins.Registry

/-!
# Session plugin

Built-in artifact kind `session`: a claim-lock marker recording which agent session currently
holds an issue, attached by external orchestration systems (e.g. Orchestra) that use taxis as
their issue backend instead of a file-based claim record.

Payload fields:
* `task_id` — the id of the task holding the claim (required).
* `agent` — the agent backend that claimed it, e.g. `claude` (required).
* `series` — an optional series/queue name the task belongs to.
* `claimed_at` — when the claim was taken (required).

There is no `(issue_id, kind)` uniqueness constraint enforced server-side — "at most one active
claim" is the caller's responsibility (list artifacts, filter by kind, check emptiness before
creating).
-/

open Lean

namespace Taxis.Plugins

private def sessionDisplay (j : Json) : ArtifactDisplay :=
  let str? (f : String) := (j.getObjValAs? String f).toOption
  let taskId := (str? "task_id").getD "?"
  let agent := (str? "agent").getD "?"
  { label := s!"Claimed by {agent} (task {taskId})", url := none }

/-- Artifact: a claim-lock marker recording which agent session holds an issue. -/
def sessionHandler : ArtifactHandler where
  kind := "session"
  fields := #[
    { name := "task_id", label := "Task ID", required := true },
    { name := "agent", label := "Agent backend", required := true },
    { name := "series", label := "Series" },
    { name := "claimed_at", label := "Claimed at", required := true }]
  validate j := do
    let _ ← j.getObjValAs? String "task_id"
    let _ ← j.getObjValAs? String "agent"
    let _ ← j.getObjValAs? String "claimed_at"
    pure ()
  render := sessionDisplay

initialize registerArtifactHandler sessionHandler

end Taxis.Plugins
