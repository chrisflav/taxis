# taxis agent plugin

An agent plugin that exposes **tools** and **skills** for working with issues in a
[taxis](../README.md) backend.

The tools are served over the [Model Context Protocol](https://modelcontextprotocol.io)
directly by the taxis server itself, at `POST <TAXIS_URL>/mcp` (Streamable HTTP transport,
JSON-RPC 2.0) — see `Taxis/Server/Mcp.lean` and `Taxis/Server/Handlers.lean`'s `mcpHandler` in
the main repo. There is no separate process to install or run: whatever's already serving the
REST API and the web UI serves `/mcp` too, so it's reachable from anywhere that can reach that
server, including a remote/Dockerized instance — not just on the machine your agent runs on.

## What's inside

```
taxis-plugin/
├── .claude-plugin/plugin.json   # plugin manifest (points at <TAXIS_URL>/mcp)
└── skills/
    ├── taxis-issues/SKILL.md    # how to list/read/create/update/comment on issues
    └── taxis-triage/SKILL.md    # a backlog-triage workflow
```

### Tools (MCP)

| Tool | Purpose |
| --- | --- |
| `taxis_list_issues` | List/search issues (`state`, `label`, `q`, `assignee`, `limit`, `offset`). |
| `taxis_get_issue` | Full detail: issue + labels, assignees, comments, artifacts, checks, events. |
| `taxis_create_issue` | Create an issue (only `title` required). |
| `taxis_update_issue` | Update selected fields (state, labels, assignees, parent, …). |
| `taxis_delete_issue` | Delete an issue. |
| `taxis_add_comment` / `taxis_list_comments` | Comment thread. |
| `taxis_issue_events` | Activity/history log. |
| `taxis_list_labels` / `taxis_list_actors` | Resolve label/actor names to ids. |
| `taxis_whoami` | The actor behind the current token. |

Reads (`taxis_list_issues`, `taxis_get_issue`, `taxis_list_comments`, `taxis_issue_events`,
`taxis_list_labels`, `taxis_list_actors`, `taxis_whoami`) work without a token when the server is
running in open (single-user/local) mode — same as the REST API. Writes (`taxis_create_issue`,
`taxis_update_issue`, `taxis_delete_issue`, `taxis_add_comment`) always need an authenticated
token once *any* login method (Google, GitHub, or central password) is configured on the server.

## Configuration

Two environment variables, read when the plugin loads:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAXIS_URL` | `http://localhost:8080` | Base URL of the taxis server — point this at a remote/Dockerized instance to use it from anywhere. |
| `TAXIS_TOKEN` | — | Personal access token, sent as `Authorization: Bearer …`. Needed for writes when auth is enabled. |

Mint a token in the taxis UI under **Tokens** (or have an admin create one for a bot actor), then
export it before launching the agent:

```bash
export TAXIS_URL=https://taxis.example.com
export TAXIS_TOKEN=xxxxxxxx
```

## Install in Claude Code

Add the plugin (via a marketplace, or point at this directory), or reference it from your
settings. Once loaded, the `taxis` MCP server is available immediately and the two skills become
available — there's no subprocess startup to wait on, since it's just an HTTP call to the taxis
server you've already configured via `TAXIS_URL`.

## Use with any other MCP client

Because the server speaks standard MCP over Streamable HTTP, any MCP host that supports a remote
server can point straight at it:

```json
{
  "type": "http",
  "url": "https://taxis.example.com/mcp",
  "headers": { "Authorization": "Bearer xxxxxxxx" }
}
```

## Test it by hand

```bash
curl -s https://taxis.example.com/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer xxxxxxxx" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"taxis_list_issues","arguments":{"limit":2}}}'
```
