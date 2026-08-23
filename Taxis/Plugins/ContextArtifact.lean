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

    Naming the note is the writer's job, not this function's — which is why `title` is required.
    A label is what makes a rail of several context artifacts navigable at all: you can tell the
    deployment notes from the repro steps without unfolding either. -/
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
  -- "absent" and "present but not a string" are told apart, which the other kinds do not bother
  -- with: this is the one kind whose stated audience writes its payload by hand against the API,
  -- and a bot that sent `text` as a list is not helped by being told the field is missing.
  validate j := pure <| do
    for field in ["title", "text"] do
      match j.getObjVal? field with
      | .error _ => throw s!"missing required field '{field}'"
      | .ok v => match v.getStr? with
        | .error _ => throw s!"'{field}' must be a string, but is {v.compress}"
        | .ok s => if s.trimAscii.isEmpty then throw s!"'{field}' must not be empty"
  render j := pure { label := contextLabel ((str? j "title").getD "") }

initialize registerArtifactHandler contextHandler

end Taxis.Plugins
