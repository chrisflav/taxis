import Issues.Json

/-!
# OpenAPI specification

A hand-written OpenAPI 3.0 document describing the REST API, served at `GET /api/openapi.json`
and rendered by Swagger UI at `/docs`.
-/

open Lean

namespace Issues.Server.OpenApi

private def obj := Json.mkObj
private def arr (xs : List Json) : Json := Json.arr xs.toArray
private def str (s : String) : Json := Json.str s
private def jtrue : Json := Json.bool true
private def ref (name : String) : Json := obj [("$ref", str s!"#/components/schemas/{name}")]
private def typ (t : String) : Json := obj [("type", str t)]
private def nullable (t : String) : Json := obj [("type", str t), ("nullable", jtrue)]
private def arrayOf (items : Json) : Json := obj [("type", str "array"), ("items", items)]
private def enumStr (vals : List String) : Json := obj [("type", str "string"), ("enum", arr (vals.map str))]

private def schemaObj (fields : List (String × Json)) (required : List String := []) : Json :=
  obj ([("type", str "object"), ("properties", obj fields)]
    ++ (if required.isEmpty then [] else [("required", arr (required.map str))]))

private def idParam : Json :=
  obj [("name", str "id"), ("in", str "path"), ("required", jtrue), ("schema", typ "integer")]
private def queryParam (name desc : String) : Json :=
  obj [("name", str name), ("in", str "query"), ("schema", typ "string"), ("description", str desc)]

private def jsonBody (schema : Json) : Json :=
  obj [("required", jtrue), ("content", obj [("application/json", obj [("schema", schema)])])]
private def jsonResp (desc : String) (schema : Json) : Json :=
  obj [("description", str desc), ("content", obj [("application/json", obj [("schema", schema)])])]
private def emptyResp (desc : String) : Json := obj [("description", str desc)]

private def responses (rs : List (String × Json)) : Json :=
  obj (rs ++ [("default", jsonResp "Error" (ref "Error"))])

private def operation (tag summary : String) (params : List Json) (body : Option Json)
    (resps : List (String × Json)) : Json :=
  obj ([("tags", arr [str tag]), ("summary", str summary)]
    ++ (if params.isEmpty then [] else [("parameters", arr params)])
    ++ (match body with | some b => [("requestBody", b)] | none => [])
    ++ [("responses", responses resps)])

private def schemas : Json := obj [
  ("Error", schemaObj [("error", typ "string")]),
  ("Actor", schemaObj [("id", typ "integer"), ("email", typ "string"), ("displayName", typ "string"),
    ("groups", arrayOf (typ "integer")), ("googleSub", nullable "string")]),
  ("ActorInput", schemaObj [("email", typ "string"), ("displayName", typ "string"),
    ("groups", arrayOf (typ "integer")), ("googleSub", typ "string")] ["email", "displayName"]),
  ("ActorUpdate", schemaObj [("email", typ "string"), ("displayName", typ "string"),
    ("groups", arrayOf (typ "integer")), ("googleSub", typ "string")]),
  ("Group", schemaObj [("id", typ "integer"), ("name", typ "string"), ("description", nullable "string")]),
  ("GroupInput", schemaObj [("name", typ "string"), ("description", typ "string")] ["name"]),
  ("Label", schemaObj [("id", typ "integer"), ("name", typ "string"), ("description", nullable "string"),
    ("color", typ "string")]),
  ("LabelInput", schemaObj [("name", typ "string"), ("description", typ "string"), ("color", typ "string")] ["name"]),
  ("Artifact", schemaObj [("id", typ "integer"), ("kind", typ "string"), ("payload", typ "object")]),
  ("ArtifactInput", schemaObj [("kind", typ "string"), ("payload", typ "object")] ["kind"]),
  ("Check", schemaObj [("id", typ "integer"), ("kind", typ "string"), ("config", typ "object"),
    ("status", enumStr ["pending", "passing", "failing", "error"]), ("detail", nullable "string"),
    ("lastRun", nullable "integer")]),
  ("CheckInput", schemaObj [("kind", typ "string"), ("config", typ "object")] ["kind"]),
  ("Issue", schemaObj [("id", typ "integer"), ("title", typ "string"), ("description", typ "string"),
    ("state", enumStr ["open", "closed", "completed"]), ("locked", typ "boolean"),
    ("labels", arrayOf (typ "integer")), ("parents", arrayOf (typ "integer")),
    ("assignees", arrayOf (typ "integer")), ("artifacts", arrayOf (typ "integer")),
    ("visibility", arrayOf (typ "integer")), ("checks", arrayOf (typ "integer")),
    ("createdAt", typ "integer"), ("updatedAt", typ "integer")]),
  ("IssueInput", schemaObj [("title", typ "string"), ("description", typ "string"),
    ("state", enumStr ["open", "closed", "completed"]), ("locked", typ "boolean"),
    ("labels", arrayOf (typ "integer")), ("parents", arrayOf (typ "integer")),
    ("assignees", arrayOf (typ "integer")), ("visibility", arrayOf (typ "integer"))] ["title"]),
  ("IssueUpdate", schemaObj [("title", typ "string"), ("description", typ "string"),
    ("state", enumStr ["open", "closed", "completed"]), ("locked", typ "boolean"),
    ("labels", arrayOf (typ "integer")), ("parents", arrayOf (typ "integer")),
    ("assignees", arrayOf (typ "integer")), ("visibility", arrayOf (typ "integer"))]),
  ("IssueDetail", schemaObj [("issue", ref "Issue"), ("assignedActors", arrayOf (ref "Actor")),
    ("issueLabels", arrayOf (ref "Label")), ("attachedArtifacts", arrayOf (ref "Artifact")),
    ("attachedChecks", arrayOf (ref "Check"))]),
  ("Plugins", schemaObj [("artifactKinds", arrayOf (typ "string")), ("checkKinds", arrayOf (typ "string"))]),
  ("Graph", schemaObj [("nodes", arrayOf (typ "object")), ("edges", arrayOf (typ "object"))]),
  ("Deleted", schemaObj [("deleted", typ "boolean")])
]

private def paths : Json := obj [
  ("/health", obj [("get", operation "System" "Health check" [] none
    [("200", jsonResp "OK" (schemaObj [("status", typ "string"), ("version", typ "string")]))])]),
  ("/openapi.json", obj [("get", operation "System" "This OpenAPI document" [] none
    [("200", jsonResp "OpenAPI spec" (typ "object"))])]),
  ("/plugins", obj [("get", operation "System" "List registered artifact and check kinds" [] none
    [("200", jsonResp "Plugin kinds" (ref "Plugins"))])]),
  ("/graph", obj [("get", operation "Issues" "Dependency graph of visible issues" [] none
    [("200", jsonResp "Graph" (ref "Graph"))])]),

  ("/me", obj [("get", operation "Auth" "The current authenticated actor" [] none
    [("200", jsonResp "Actor" (ref "Actor")), ("401", emptyResp "Not authenticated")])]),
  ("/auth/google/login", obj [("get", operation "Auth" "Redirect to Google consent" [] none
    [("302", emptyResp "Redirect")])]),
  ("/auth/google/callback", obj [("get", operation "Auth" "OAuth callback" [queryParam "code" "Authorization code"] none
    [("302", emptyResp "Redirect with session cookie")])]),
  ("/auth/logout", obj [("post", operation "Auth" "Destroy the current session" [] none
    [("200", emptyResp "Logged out")])]),
  ("/auth/dev-login", obj [("post", operation "Auth" "Development-only email login (gated by ISSUES_DEV_LOGIN)"
    [] (some (jsonBody (schemaObj [("email", typ "string"), ("displayName", typ "string")] ["email"])))
    [("200", jsonResp "Session" (schemaObj [("token", typ "string"), ("actor", ref "Actor")]))])]),

  ("/actors", obj [
    ("get", operation "Actors" "List actors" [] none [("200", jsonResp "Actors" (arrayOf (ref "Actor")))]),
    ("post", operation "Actors" "Create an actor" [] (some (jsonBody (ref "ActorInput")))
      [("201", jsonResp "Created" (ref "Actor"))])]),
  ("/actors/{id}", obj [
    ("get", operation "Actors" "Fetch an actor" [idParam] none [("200", jsonResp "Actor" (ref "Actor")), ("404", emptyResp "Not found")]),
    ("patch", operation "Actors" "Update an actor" [idParam] (some (jsonBody (ref "ActorUpdate"))) [("200", jsonResp "Actor" (ref "Actor"))]),
    ("delete", operation "Actors" "Delete an actor" [idParam] none [("200", jsonResp "Deleted" (ref "Deleted"))])]),

  ("/groups", obj [
    ("get", operation "Groups" "List groups" [] none [("200", jsonResp "Groups" (arrayOf (ref "Group")))]),
    ("post", operation "Groups" "Create a group" [] (some (jsonBody (ref "GroupInput"))) [("201", jsonResp "Created" (ref "Group"))])]),
  ("/groups/{id}", obj [
    ("get", operation "Groups" "Fetch a group" [idParam] none [("200", jsonResp "Group" (ref "Group"))]),
    ("patch", operation "Groups" "Update a group" [idParam] (some (jsonBody (ref "GroupInput"))) [("200", jsonResp "Group" (ref "Group"))]),
    ("delete", operation "Groups" "Delete a group" [idParam] none [("200", jsonResp "Deleted" (ref "Deleted"))])]),

  ("/labels", obj [
    ("get", operation "Labels" "List labels" [] none [("200", jsonResp "Labels" (arrayOf (ref "Label")))]),
    ("post", operation "Labels" "Create a label" [] (some (jsonBody (ref "LabelInput"))) [("201", jsonResp "Created" (ref "Label"))])]),
  ("/labels/{id}", obj [
    ("get", operation "Labels" "Fetch a label" [idParam] none [("200", jsonResp "Label" (ref "Label"))]),
    ("patch", operation "Labels" "Update a label" [idParam] (some (jsonBody (ref "LabelInput"))) [("200", jsonResp "Label" (ref "Label"))]),
    ("delete", operation "Labels" "Delete a label" [idParam] none [("200", jsonResp "Deleted" (ref "Deleted"))])]),

  ("/issues", obj [
    ("get", operation "Issues" "List issues"
      [queryParam "state" "Filter by state (open/closed/completed)", queryParam "label" "Filter by label id",
       queryParam "q" "LIKE text search on title/description", queryParam "assignee" "Filter by assignee id"]
      none [("200", jsonResp "Issues" (arrayOf (ref "Issue")))]),
    ("post", operation "Issues" "Create an issue" [] (some (jsonBody (ref "IssueInput"))) [("201", jsonResp "Created" (ref "Issue"))])]),
  ("/issues/{id}", obj [
    ("get", operation "Issues" "Fetch an issue with related entities" [idParam] none
      [("200", jsonResp "Issue detail" (ref "IssueDetail")), ("404", emptyResp "Not found")]),
    ("patch", operation "Issues" "Update an issue (rejected on locked fields)" [idParam] (some (jsonBody (ref "IssueUpdate")))
      [("200", jsonResp "Issue" (ref "Issue")), ("422", jsonResp "Validation error" (ref "Error"))]),
    ("delete", operation "Issues" "Delete an issue" [idParam] none [("200", jsonResp "Deleted" (ref "Deleted"))])]),

  ("/issues/{id}/artifacts", obj [("post", operation "Artifacts" "Attach an artifact to an issue"
    [idParam] (some (jsonBody (ref "ArtifactInput"))) [("201", jsonResp "Created" (ref "Artifact")), ("422", jsonResp "Unknown kind or invalid payload" (ref "Error"))])]),
  ("/artifacts/{id}", obj [("delete", operation "Artifacts" "Delete an artifact" [idParam] none [("200", jsonResp "Deleted" (ref "Deleted"))])]),

  ("/issues/{id}/checks", obj [
    ("get", operation "Checks" "List checks on an issue" [idParam] none [("200", jsonResp "Checks" (arrayOf (ref "Check")))]),
    ("post", operation "Checks" "Attach a check to an issue" [idParam] (some (jsonBody (ref "CheckInput"))) [("201", jsonResp "Created" (ref "Check"))])]),
  ("/checks/{id}/run", obj [("post", operation "Checks" "Evaluate a check now" [idParam] none [("200", jsonResp "Updated check" (ref "Check"))])]),
  ("/checks/{id}", obj [("delete", operation "Checks" "Delete a check" [idParam] none [("200", jsonResp "Deleted" (ref "Deleted"))])]),

  ("/import/github", obj [("post", operation "Import" "Import issues from a GitHub repository"
    [] (some (jsonBody (schemaObj [("owner", typ "string"), ("repo", typ "string"), ("state", typ "string")] ["owner", "repo"])))
    [("201", jsonResp "Import result" (schemaObj [("imported", typ "integer"), ("issueIds", arrayOf (typ "integer"))]))])]),
  ("/import/gdoc", obj [("post", operation "Import" "Import one issue per line of text (or a Google Doc)"
    [] (some (jsonBody (schemaObj [("text", typ "string"), ("docId", typ "string"), ("accessToken", typ "string")])))
    [("201", jsonResp "Import result" (schemaObj [("imported", typ "integer"), ("issueIds", arrayOf (typ "integer"))]))])])
]

/-- Standalone Swagger UI page (loads Swagger UI from a CDN) pointed at the spec above. -/
def docsHtml : String :=
  "<!doctype html>
<html lang='en'>
<head>
  <meta charset='utf-8'/>
  <meta name='viewport' content='width=device-width, initial-scale=1'/>
  <title>Issue Tracker API</title>
  <link rel='stylesheet' href='https://unpkg.com/swagger-ui-dist@5/swagger-ui.css'/>
</head>
<body>
  <div id='swagger-ui'></div>
  <script src='https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js' crossorigin></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui' });
    };
  </script>
</body>
</html>"

/-- The complete OpenAPI 3.0 document. -/
def spec : Json := obj [
  ("openapi", str "3.0.3"),
  ("info", obj [("title", str "Issue Tracker API"), ("version", str "0.1.0"),
    ("description", str "REST API for the Lean issue tracker. All endpoints are served under `/api`.")]),
  ("servers", arr [obj [("url", str "/api")]]),
  ("tags", arr (["Issues", "Labels", "Actors", "Groups", "Artifacts", "Checks", "Import", "Auth", "System"].map
    (fun t => obj [("name", str t)]))),
  ("paths", paths),
  ("components", obj [("schemas", schemas)])
]

end Issues.Server.OpenApi
