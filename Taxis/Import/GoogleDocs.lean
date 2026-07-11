import Taxis.Domain
import Taxis.Http.Client

/-!
# Google Docs import ("by line")

Turns a document into one issue per non-empty line. The document text can be supplied directly,
or fetched from Google Drive by exporting a document id as `text/plain` using a supplied OAuth
access token.
-/

open Lean

namespace Taxis.Import

/-- Split raw text into one `IssueInput` per non-empty, trimmed line. -/
def linesToIssues (text : String) : Array IssueInput := Id.run do
  let mut out := #[]
  for line in text.splitOn "\n" do
    let title := line.trimAscii.toString
    if !title.isEmpty then
      out := out.push { title }
  return out

/-- Export a Google Doc as plain text via the Drive API using an OAuth access token. -/
def fetchGoogleDocText (docId accessToken : String) : IO (Except String String) := do
  let url := s!"https://www.googleapis.com/drive/v3/files/{docId}/export?mimeType=text/plain"
  match ← Http.request "GET" url #[("Authorization", s!"Bearer {accessToken}")] none with
  | .error e => return .error e
  | .ok resp =>
    if resp.status < 200 || resp.status >= 300 then
      return .error s!"Drive export failed (HTTP {resp.status}): {resp.body}"
    return .ok resp.body

end Taxis.Import
