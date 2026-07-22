import Lean.Data.Json

/-!
# MCP tool schema

The static [Model Context Protocol](https://modelcontextprotocol.io) tool definitions exposed at
`POST /mcp` (see `Taxis.Server.mcpHandler` in `Handlers.lean`, which needs the resource handlers
defined there and so can't import this module in the other direction). Kept separate because it's
pure data — no dependency on the handler/routing layer — and mirrors what used to be a standalone
Python MCP server in `taxis-plugin/mcp/taxis_mcp.py`, now served in-process instead of proxying
back over HTTP to this same server.
-/

open Lean

namespace Taxis.Server

/-- The MCP protocol revision this server implements. -/
def mcpProtocolVersion : String := "2025-06-18"

private def obj (fields : List (String × Json)) : Json := Json.mkObj fields
private def arr (xs : List Json) : Json := Json.arr xs.toArray
private def str (s : String) : Json := Json.str s

private def intArray (desc : String) : Json :=
  obj [("type", str "array"), ("items", obj [("type", str "integer")]), ("description", str desc)]

private def stringProp (desc : String) : Json := obj [("type", str "string"), ("description", str desc)]

private def intProp (desc : String) : Json := obj [("type", str "integer"), ("description", str desc)]

private def stateProp (desc : String) : Json :=
  obj [("type", str "string"), ("enum", arr [str "open", str "closed", str "completed"]), ("description", str desc)]

private def idProp : String × Json := ("id", intProp "Issue id.")

/-- Body fields shared by `taxis_create_issue` and `taxis_update_issue`, mirroring
    `Taxis.IssueInput`/`Taxis.IssueUpdate`'s JSON field names exactly — `mcpCallTool` forwards the
    call's `arguments` object straight through as the request body, so no translation happens
    between an MCP tool argument and the REST field it sets. -/
private def writeFields : List (String × Json) :=
  [ ("title", stringProp "Issue title.")
  , ("description", stringProp "Markdown body.")
  , ("goal", stringProp "Short goal condition: what must hold for the issue to be complete.")
  , ("state", stateProp "Lifecycle state.")
  , ("labels", intArray "Label ids (use taxis_list_labels to resolve names).")
  , ("assignees", intArray "Actor ids (use taxis_list_actors to resolve names).")
  , ("parent", obj [("type", arr [str "integer", str "null"]), ("description", str "Parent issue id, or null to clear.")])
  , ("dependencies", intArray "Ids of issues this one depends on.")
  , ("visibility", intArray "Group ids; empty means public.")
  , ("locked", obj [("type", str "boolean"), ("description", str "Whether the issue is locked.")])
  ]

private def tool (name description : String) (properties : List (String × Json)) (required : List String := []) : Json :=
  obj [ ("name", str name), ("description", str description),
        ("inputSchema", obj (
          [("type", str "object"), ("properties", obj properties)] ++
          (if required.isEmpty then [] else [("required", arr (required.map str))]))) ]

/-- The tools exposed at `tools/list`, dispatched by `Taxis.Server.mcpCallTool`. -/
def mcpTools : Array Json := #[
  tool "taxis_list_issues"
    "List/search issues with optional filters and paging. Returns an array of issues."
    [ ("state", stateProp "Filter by lifecycle state.")
    , ("label", intProp "Filter by label id.")
    , ("q", stringProp "Text search (LIKE) on title/description.")
    , ("assignee", intProp "Filter by assignee actor id.")
    , ("limit", intProp "Max issues to return.")
    , ("offset", intProp "Issues to skip (paging).") ],
  tool "taxis_get_issue"
    "Get one issue's full detail: the issue, its labels, assignees, comments, attached artifacts/checks, and activity events."
    [idProp] ["id"],
  tool "taxis_create_issue" "Create a new issue. Only `title` is required." writeFields ["title"],
  tool "taxis_update_issue"
    "Update fields of an existing issue. Only the fields you pass are changed. Set state to 'completed' or 'closed' to resolve an issue."
    (idProp :: writeFields) ["id"],
  tool "taxis_delete_issue" "Delete an issue permanently." [idProp] ["id"],
  tool "taxis_add_comment" "Add a comment to an issue's discussion thread."
    [idProp, ("body", stringProp "Comment body (Markdown).")] ["id", "body"],
  tool "taxis_list_comments" "List the comments on an issue." [idProp] ["id"],
  tool "taxis_issue_events" "List the activity/history events recorded for an issue." [idProp] ["id"],
  tool "taxis_list_labels" "List all labels (id, name, color, description). Use to map label names to ids." [],
  tool "taxis_list_actors" "List all actors (people and bots). Use to map actor names/emails to ids." [],
  tool "taxis_whoami" "Return the actor the current bearer token authenticates as (GET /me)." []
]

end Taxis.Server
