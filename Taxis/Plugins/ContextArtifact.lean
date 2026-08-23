import Taxis.Plugins.Registry

/-!
# Context artifact

Built-in artifact kind `context`: a block of free-form prose attached to an issue, held *beside*
the issue rather than in it. The description says what the issue is; a context artifact carries
what someone — usually an agent, on a later run — would otherwise have to rediscover: which
approach was already tried and abandoned, where the flaky test actually lives, what the build
environment needs. That material is worth keeping and is not worth putting in front of every
human who opens the issue, so it lives here, folded away, instead of diluting the description.

The payload is plain text; the frontend renders it as markdown (with LaTeX), the same way it
renders descriptions and comments. Nothing is interpreted server-side — the payload is stored and
handed back verbatim, and the rail's one-line label is the artifact's title, shortened to fit.

Payload fields (both required):
* `title` — a short label, and the only part of the artifact the rail shows folded.
* `text` — the context itself, markdown with `$…$` math.
-/

open Lean

namespace Taxis.Plugins

/-- Shorten `s` to at most `limit` characters, marking the cut with an ellipsis. -/
def truncateTo (s : String) (limit : Nat := 60) : String :=
  if s.length ≤ limit then s else (s.take limit).trimAsciiEnd.toString ++ "…"

/-- The one-line label a `context` artifact shows in the rail: its title, shortened to fit.

    A label is what makes a rail of several context artifacts navigable — you can tell the
    deployment notes from the repro steps without unfolding either — so the title is required
    rather than derived. Guessing one from the text means the rail reads as whatever syntax the
    note happens to open with, and the person best placed to say what a note is about in five
    words is whoever just wrote it. -/
def contextLabel (title : String) : String :=
  let title := title.trimAscii.toString
  if title.isEmpty then "context" else truncateTo title

private def str? (j : Json) (f : String) : Option String := (j.getObjValAs? String f).toOption

/-- Artifact: free-form context for an issue, rendered as markdown where it is displayed.

    No `url`: there is nothing to link to, the artifact *is* its text. The frontend reads the
    payload it already has and renders it in place. -/
def contextHandler : ArtifactHandler where
  kind := "context"
  fields := #[
    { name := "title", label := "Title", required := true, placeholder := some "Build environment notes",
      help := some "The one line the rail shows; the text stays folded away beneath it." },
    { name := "text", label := "Context", type := "markdown", required := true,
      placeholder := some "Markdown, with $\\LaTeX$ math.",
      help := some "Background that shouldn't crowd the description — notes for whoever (or whatever) picks this up next." }]
  validate j := pure <| do
    for field in ["title", "text"] do
      match str? j field with
      | none => throw s!"missing required field '{field}'"
      | some v => if v.trimAscii.isEmpty then throw s!"'{field}' must not be empty"
  render j := pure { label := contextLabel ((str? j "title").getD "") }

initialize registerArtifactHandler contextHandler

end Taxis.Plugins
