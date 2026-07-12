# taxis

taxis is an extensible issue tracker built in Lean 4, with a REST API backend and a TypeScript
(React) frontend.

## Architecture

- **Backend** — a Lean 4 REST API on the in-core [`Std.Http`](https://lean-lang.org) async
  server, persisting to SQLite via [`leansqlite`](https://github.com/leanprover/leansqlite)
  (bundled — no system SQLite needed). JSON (de)serialisation uses `Lean.Data.Json`.
- **Frontend** — a Vite + React + TypeScript single-page app in [`frontend/`](frontend),
  built to static assets and served by the backend.
- **Extensibility** — *artifacts* (things attached to an issue: a GitHub PR, a branch) and
  *checks* (conditions like "CI passes on a branch") are plugins. Each plugin
  is a module that registers a handler in an `initialize` block, so adding a kind is "add a
  module + import it" with no change to the core.

## Concepts

- **Actors** — people or bots; only those with a linked Google account (or an API token) can
  authenticate. An actor flagged as a **bot** is shown with a 🤖 marker wherever its name appears.
- **Groups** — sets of actors used as a visibility filter.
- **Labels** — reusable named tags (name + description), managed on their own page; an issue
  can carry any number of them.
- **Issues** — title, description, lifecycle state (`open`/`closed`/`completed`), labels, a single
  optional **parent** (a hierarchical/containment relation, cycle-checked up the parent chain),
  a set of **dependencies** (other issues it depends on — the dependency graph), assignees,
  visibility groups, artifacts, checks, and comments. The **Tree** view is built from the parent
  relation; the **Graph** view's edges are the dependencies, rendered as an interactive,
  pan/zoom canvas (scroll to zoom, drag to pan, hover a node to trace its edges, click to open).
- **Comments** — a discussion thread on each issue; anyone signed in may comment, and a comment
  can be edited or removed by its author or an admin. Every issue is edited **inline** — clicking
  a field's pencil replaces just that block with an editor, leaving the rest of the page in place.
- **History** — every change to an issue is recorded as an **event**: edits to the title,
  description, and comments surface as a small edit-history dropdown (🕓) next to the text, while
  the remaining changes (state, lock, parent, dependencies, assignees, visibility, labels,
  artifacts, checks) appear as a chronological **Activity** log, each attributed to its actor.
- **Artifacts / Checks** — extensible, plugin-backed (see above). Built-in check kinds include
  `github-ci` and `json-endpoint` (fetch a JSON URL and assert a condition on a value at a path).
  The `json-endpoint` check can send an authentication header (`authValue`, optionally under a
  custom `authHeader`) so it can reach a protected endpoint.
- **API tokens** — bots authenticate with a personal access token (`Authorization: Bearer …`).
  Only a SHA-256 hash is stored; the secret is shown once, at creation. Manage your own under
  **Tokens** in the UI (`GET|POST /api/me/tokens`, `DELETE /api/me/tokens/:id`); an **admin** can
  mint a token for any other actor — e.g. a bot — from the Admin → Actors → *Tokens* dialog
  (`GET|POST /api/actors/:id/tokens`).

## Build & run

Prerequisites: [`elan`](https://github.com/leanprover/elan) (Lean toolchain manager) and
Node.js 22+.

```bash
# Backend
lake exe cache get      # optional, if available
lake build

# Frontend
cd frontend && npm install && npm run build && cd ..

# Run (serves API under /api and the built SPA at /)
lake exe taxis
```

Then open <http://localhost:8080>.

For frontend development with hot reload, run `npm run dev` in `frontend/` (it proxies `/api`
to the backend on port 8080) and `lake exe taxis` in another terminal.

## Configuration

All configuration is via environment variables. They may be exported into the shell **or** placed
in a `.env` file in the working directory (real environment variables take precedence). On startup
the server logs whether Google OAuth is configured and the redirect URI it expects.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ISSUES_PORT` | `8080` | Port to listen on |
| `ISSUES_DB` | `issues.sqlite` | SQLite database path |
| `ISSUES_FRONTEND_DIR` | `frontend/dist` | Directory of built frontend assets |
| `ISSUES_BASE_URL` | `http://localhost:<port>` | Public URL (used for the OAuth redirect) |
| `ISSUES_GOOGLE_CLIENT_ID` | — | Google OAuth client id; when set, mutations require auth |
| `ISSUES_GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `ISSUES_GITHUB_TOKEN` | — | Token for GitHub API calls (import, CI checks) |
| `ISSUES_CHECK_INTERVAL` | `0` | Background check-sweep interval in seconds (`0` disables) |
| `ISSUES_ADMIN_EMAILS` | — | Comma-separated emails granted admin on login (bootstrap) |
| `ISSUES_DEV_LOGIN` | — | If set, enables `POST /api/auth/dev-login` for local use |

When Google OAuth is **not** configured the API is open (single-user/local mode); when it is
configured, write operations require an authenticated session, and managing actors, groups, and
labels (plus running imports) additionally requires an **admin** actor.

## Sign-in with Google

1. In the [Google Cloud Console](https://console.cloud.google.com/) create an **OAuth 2.0 Client
   ID** (application type "Web application").
2. Add an **Authorized redirect URI** of `<ISSUES_BASE_URL>/auth/google/callback` (e.g.
   `http://localhost:8080/auth/google/callback` for local use, or your public URL in production).
3. Run the server with the client credentials and your public URL set:

   ```bash
   ISSUES_GOOGLE_CLIENT_ID=... \
   ISSUES_GOOGLE_CLIENT_SECRET=... \
   ISSUES_BASE_URL=https://issues.example.com \
   ISSUES_ADMIN_EMAILS=you@example.com \
   lake exe taxis
   ```

4. Click **Sign in with Google**. On the first login the server bootstraps admin for any email
   listed in `ISSUES_ADMIN_EMAILS`.

### Connecting a Google account to an actor

On login the server resolves the Google identity to an actor in this order:

1. by the Google subject id (`google_sub`) if this account has logged in before;
2. otherwise by **email** — a pre-existing actor with the same email is *linked* (its `google_sub`
   is filled in);
3. otherwise a new actor is created.

So to connect a Google account to an actor you created in advance, just set that actor's **email**
to the Google account's email; their first sign-in links the two automatically. Only actors with a
linked Google account can authenticate.

## API overview

All endpoints are under `/api`. Responses are JSON. Interactive documentation (Swagger UI) is
served at **`/docs`**, backed by the OpenAPI spec at `GET /api/openapi.json`.

- `GET /health`, `GET /plugins`, `GET /graph`, `GET /openapi.json`
- `GET|POST /actors`, `GET|PATCH|DELETE /actors/:id`
- `GET|POST /groups`, `GET|PATCH|DELETE /groups/:id`
- `GET|POST /labels`, `GET|PATCH|DELETE /labels/:id`
- `GET /issues` (filters: `state`, `label` = label id, `q`, `assignee`; paging: `limit`, `offset`),
  `POST /issues`, `GET|PATCH|DELETE /issues/:id`, `GET /issues/:id/events`
- `POST /issues/:id/artifacts`, `DELETE /artifacts/:id`
- `GET|POST /issues/:id/checks`, `POST /checks/:id/run`, `DELETE /checks/:id`
- `GET|POST /issues/:id/comments`, `PATCH|DELETE /comments/:id`
- `GET|POST /me/tokens`, `DELETE /me/tokens/:id`, `GET|POST /actors/:id/tokens` (admin)
- `POST /import/github`, `POST /import/gdoc`
- Auth: `GET /auth/google/login`, `GET /auth/google/callback`, `POST /auth/logout`,
  `POST /auth/dev-login`, `GET /me`

## Tests

```bash
lake test
```

Runs JSON round-trip, database, plugin-registry, and visibility tests.

## Design notes

- **Visibility** — an issue is visible if it has no visibility groups (public) or the viewer
  shares one of its groups. Visibility is **not** inherited from parent issues in this version.
- **Full-text search** is `LIKE`-based, because the bundled SQLite is built without FTS5.
