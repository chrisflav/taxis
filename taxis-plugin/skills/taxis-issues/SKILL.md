---
name: taxis-issues
description: Work with issues in a taxis issue tracker — list, search, read, create, update, resolve, comment on, and inspect the history of issues. Use whenever the user wants to manage or query taxis issues, or mentions a taxis issue by id/title.
---

# Working with taxis issues

taxis is an issue tracker with a REST API. This plugin exposes it through MCP tools
(prefix `taxis_`). Prefer these tools over raw `curl`. They are model-independent —
they call the taxis REST API directly and return JSON.

## Configuration

The tools read two environment variables (set them before starting the agent):

- `TAXIS_URL` — server base URL (default `http://localhost:8080`).
- `TAXIS_TOKEN` — a personal access token, sent as `Authorization: Bearer …`.
  Required for any write (create/update/delete/comment) when the server runs with
  auth enabled; read-only calls work without it in open/local mode. Mint a token in
  the taxis UI under **Tokens**, or have an admin create one for a bot actor.

Call `taxis_whoami` to confirm which actor the token authenticates as.

## The tools

| Tool | Purpose |
| --- | --- |
| `taxis_list_issues` | List/search issues. Filters: `state`, `label` (id), `q` (text), `assignee` (id); paging: `limit`, `offset`. |
| `taxis_get_issue` | Full detail for one issue: issue + labels, assignees, comments, artifacts, checks, events. |
| `taxis_create_issue` | Create an issue. Only `title` is required. |
| `taxis_update_issue` | Change fields of an issue (only the fields you pass). |
| `taxis_delete_issue` | Delete an issue permanently. |
| `taxis_add_comment` | Add a comment to an issue. |
| `taxis_list_comments` | List an issue's comments. |
| `taxis_issue_events` | The activity/history log for an issue. |
| `taxis_list_labels` | All labels (id, name, color). |
| `taxis_list_actors` | All actors (people + bots). |
| `taxis_whoami` | The actor behind the current token. |

## Key rule: ids, not names

Issue fields reference **ids**, not names:

- `labels`, `dependencies`, `visibility` are arrays of integer ids.
- `assignees` is an array of **actor** ids; `parent` is a single issue id (or `null`).

When the user names a label ("bug") or a person ("Alex"), first resolve it:

1. `taxis_list_labels` → find the label whose `name` matches → use its `id`.
2. `taxis_list_actors` → find the actor by `displayName`/`email` → use its `id`.

If a name is ambiguous or missing, ask the user rather than guessing an id.

## Common workflows

**Find an issue.** Use `taxis_list_issues` with `q` for text, or `state`/`assignee`/
`label` filters. Then `taxis_get_issue` for full detail before acting on it.

**Create a well-formed issue.** Give a clear `title` and a Markdown `description`, plus a
`goal` — one short, checkable condition that says when the issue is complete.
Resolve any labels/assignees to ids first. Example intent → call:
`taxis_create_issue { title, description, goal, labels: [3], assignees: [7] }`.

**Resolve / close.** `taxis_update_issue { id, state: "completed" }` (or `"closed"`).
`completed` = done successfully; `closed` = closed without completing.

**Update selectively.** Pass only the fields you want to change. To clear the parent,
pass `parent: null`. Arrays replace the whole set — to add one label, fetch the
current `labels` from `taxis_get_issue`, append, and send the full array.

**Discuss.** `taxis_add_comment { id, body }`. Read the thread with
`taxis_list_comments` or the full `taxis_get_issue`.

## Notes

- States are exactly `open`, `closed`, `completed`.
- Timestamps (`createdAt`, `updatedAt`) are integer epoch seconds.
- Errors come back as `taxis error: …`; a 401/403 usually means a missing or
  insufficient `TAXIS_TOKEN` (writes and admin actions need auth).
- For a triage pass over many issues, see the `taxis-triage` skill.
