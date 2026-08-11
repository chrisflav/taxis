import Taxis.Plugins.Registry

/-!
# File artifact

Built-in artifact kind `file`: an object held in one of the file stores configured at startup
(`[[filestores]]` / `ISSUES_FILESTORES`, see `Taxis.Plugins.S3Store`). The payload names the store
and the object key; rendering resolves them through the store into a time-limited download link,
so nothing permanent or secret is ever stored on the artifact.

Payload fields:
* `store` — name of a configured file store (required).
* `key` — the object key within that store, *without* the store's own prefix (required).
* `name` — display name, e.g. the original filename (defaults to the last key segment).
* `mime` — content type, informational.
* `size` — size in bytes, informational.

The frontend fills all of these in one go by uploading through `POST
/api/filestores/:name/upload-url`, but they can just as well be written by hand to point at an
object that is already in the bucket.
-/

open Lean

namespace Taxis.Plugins

/-- `1.4 MB`-style rendering of a byte count, for the artifact label. -/
def humanSize (bytes : Nat) : String :=
  if bytes < 1024 then s!"{bytes} B"
  else
    let inUnit (unit : Nat) : String :=
      let scaled := bytes * 10 / unit
      s!"{scaled / 10}.{scaled % 10}"
    if bytes < 1024 * 1024 then s!"{inUnit 1024} KB"
    else if bytes < 1024 * 1024 * 1024 then s!"{inUnit (1024 * 1024)} MB"
    else s!"{inUnit (1024 * 1024 * 1024)} GB"

/-- A filename reduced to characters that are safe in an object key and a URL path segment:
    alphanumerics, `.`, `-`, `_`; every other character (spaces, slashes, the lot) becomes `-`.
    Empty in, `file` out, so a key never ends in a bare separator. -/
def sanitizeFilename (name : String) : String :=
  let cleaned := String.ofList (name.toList.map fun c =>
    if c.isAlphanum || c == '.' || c == '-' || c == '_' then c else '-')
  -- All-separator names (e.g. "..") must not collapse into something path-like.
  if cleaned.toList.all (fun c => c == '.' || c == '-') then "file" else cleaned

private def str? (j : Json) (f : String) : Option String := (j.getObjValAs? String f).toOption

private def fileDisplay (j : Json) : IO ArtifactDisplay := do
  let key := (str? j "key").getD "?"
  let name := (str? j "name").getD ((key.splitOn "/").getLastD key)
  let label := match (j.getObjValAs? Nat "size").toOption with
    | some n => s!"{name} ({humanSize n})"
    | none => name
  match ← (str? j "store").mapM fileStore? with
  | some (some store) =>
    match ← store.downloadUrl key with
    | .ok url => return { label, url := some url }
    | .error e => return { label := s!"{label} — link unavailable: {e}" }
  | _ => return { label := s!"{label} — store '{(str? j "store").getD "?"}' not configured" }

/-- Artifact: a file in a configured file store, rendered as a fresh presigned download link. -/
def fileHandler : ArtifactHandler where
  kind := "file"
  fields := #[
    { name := "store", label := "File store", required := true, placeholder := some "primary",
      help := some "Name of a file store configured on the server." },
    { name := "key", label := "Object key", required := true, placeholder := some "uploads/2026/report.pdf" },
    { name := "name", label := "Display name", placeholder := some "report.pdf" },
    { name := "mime", label := "Content type", placeholder := some "application/pdf" },
    { name := "size", label := "Size (bytes)", type := "number" }]
  validate j := do
    match str? j "store", str? j "key" with
    | none, _ => return .error "missing required field 'store'"
    | _, none => return .error "missing required field 'key'"
    | some _, some key =>
      if key.isEmpty then return .error "'key' must not be empty"
      -- `..` never survives into a signed path: with path confinement this weak (keys are opaque
      -- strings to S3) it costs nothing to refuse the one pattern that means traversal elsewhere.
      else if (key.splitOn "/").any (· == "..") then return .error "'key' must not contain '..'"
      -- Deliberately no check that the named store is configured. Validation runs again on every
      -- edit of the payload, so a hard failure here would make artifacts uneditable after their
      -- store is renamed away; a wrong store name instead degrades visibly in `fileDisplay`
      -- ("store '…' not configured"), on the very view an attach lands on.
      else return .ok ()
  render := fileDisplay

initialize registerArtifactHandler fileHandler

end Taxis.Plugins
