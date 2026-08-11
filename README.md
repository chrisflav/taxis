# taxis

taxis is an extensible issue tracker built in Lean 4, with a REST API backend and a TypeScript
(React) frontend.

## Architecture

- **Backend** — a Lean 4 REST API on the in-core [`Std.Http`](https://lean-lang.org) async
  server, persisting to SQLite via [`leansqlite`](https://github.com/leanprover/leansqlite)
  (bundled — no system SQLite needed). JSON (de)serialisation uses `Lean.Data.Json`.
- **Frontend** — a Vite + React + TypeScript single-page app in [`frontend/`](frontend),
  built to static assets and served by the backend.
- **Extensibility** — *artifacts* (things attached to an issue: a GitHub PR, a branch),
  *checks* (conditions like "CI passes on a branch"), *file-store backends* (how to reach one
  kind of object storage — see [File artifacts](#file-artifacts)), and the two halves of the
  repository dependency graph (*forges*, which read files out of repositories on one host, and
  *dependency providers*, which read dependencies out of one ecosystem's manifests) are all
  plugins. Each
  plugin is a module that registers a handler in an `initialize` block, so adding a kind is "add
  a module + import it" with no change to the core.

## Concepts

- **Actors** — people or bots; only those with a linked Google account (or an API token) can
  authenticate. An actor flagged as a **bot** is shown with a 🤖 marker wherever its name appears.
- **Groups** — sets of actors used as a visibility filter.
- **Labels** — reusable named tags (name + description), managed on their own page; an issue
  can carry any number of them.
- **Issues** — title, description, **goal** (a short condition that must be fulfilled to complete
  the issue), lifecycle state (`open`/`closed`/`completed`), labels, a single
  optional **parent** (a hierarchical/containment relation, cycle-checked up the parent chain),
  a set of **dependencies** (other issues it depends on — the dependency graph), assignees,
  visibility groups, artifacts, checks, and comments. The **Tree** view is built from the parent
  relation; the **Graph** view's edges are the dependencies, rendered as an interactive,
  pan/zoom canvas (scroll to zoom, drag to pan, hover a node to trace its edges, click to open).
- **Repositories** — a `repository` artifact attaches a source repository to an issue, and the
  **Repos** view draws the dependency graph over them: the nodes are the attached repositories,
  and an edge from A to B means A's package manifest requires B. Edges are derived per
  ecosystem — built in is `lake`, which reads a Lean repository's `lake-manifest.json` (skipping
  transitive `inherited` entries), falling back to its `lakefile.toml` or `lakefile.lean`. The
  artifact can pin a branch to read (`ref`) and an ecosystem (`ecosystem`); left blank, the
  default branch is read and the providers detect the ecosystem themselves. Reading manifests
  costs network requests, so results are cached (`repoDepsTtl`) and the view has a
  **Refresh** button. Only repositories on issues you can see enter the graph.
- **Comments** — a discussion thread on each issue; anyone signed in may comment, and a comment
  can be edited or removed by its author or an admin. Every issue is edited **inline** — clicking
  a field's pencil replaces just that block with an editor, leaving the rest of the page in place.
- **History** — every change to an issue is recorded as an **event**: edits to the title,
  description, goal, and comments surface as a small edit-history dropdown (🕓) next to the text,
  while the remaining changes (state, lock, parent, dependencies, assignees, visibility, labels,
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

Prerequisites: [`elan`](https://github.com/leanprover/elan) (Lean toolchain manager), Node.js 22+,
and zlib's development headers (`zlib1g-dev` on Debian/Ubuntu, `zlib-devel` on Fedora, already
present in the macOS SDK) — the server compresses its own API responses, through `bindings/gzip.c`.

```bash
# Backend
lake exe cache get      # optional, if available
lake build

# Frontend
cd frontend && npm install && npm run build && cd ..

# Run (serves API under /api and the built SPA at /)
lake exe taxis
```

Then open <http://localhost:8080>. It runs with no configuration at all; to change anything, copy
`config.example.toml` to `config.toml` and edit it (see [Configuration](#configuration)).

For frontend development with hot reload, run `npm run dev` in `frontend/` (it proxies `/api`
to the backend on port 8080) and `lake exe taxis` in another terminal.

### Run with Docker

```bash
cd docker
cp .env.example .env   # fill in what you need
docker compose up --build
```

Builds the backend and frontend from source and runs the server at <http://localhost:8080>, with
the SQLite database persisted in `docker/data/` on the host (override the location with
`TAXIS_DATA_DIR`). Configuration (see below) is passed as
environment variables in `docker/docker-compose.yaml`; Compose automatically loads `docker/.env`
(not committed — see `docker/.env.example` for what's available and their defaults) to fill in
the `${VAR:-default}` placeholders there. To use a `config.toml` instead, uncomment the
`ISSUES_CONFIG` variable and the matching volume in `docker-compose.yaml`.

## Configuration

Configuration goes in a **`config.toml`** file, or in environment variables, or both. The server
reads `config.toml` from its working directory if it is there; `--config <path>` (or
`ISSUES_CONFIG`) names a different file, which then has to exist.

```toml
# config.toml — everything is optional; these are the defaults unless noted
port = 8080
host = "127.0.0.1"                        # bind address
db = "issues.sqlite"                      # SQLite database path
frontendDir = "frontend/dist"             # built frontend assets
baseUrl = "http://localhost:8080"         # public URL, used for the OAuth redirects
checkInterval = 0                         # background check sweep, in seconds (0 disables)
repoDepsTtl = 3600                        # repository dependency cache, in seconds (0 disables)

[auth]
password = "…"                            # central login password; enables password sign-in
adminEmails = ["you@example.com"]         # granted admin on login (bootstrap)
devLogin = false                          # enables POST /api/auth/dev-login — never in production

[auth.google]                             # when set, mutations require an authenticated session
clientId = "…"
clientSecret = "…"

[auth.github]                             # GitHub OAuth App, for signing in
clientId = "…"
clientSecret = "…"

[github]
token = "…"                               # token for GitHub API calls — see the warning below

[[filestores]]                            # zero or more; see File artifacts below
name = "primary"
kind = "s3"
endpoint = "https://s3.example.com"
region = "garage"
bucket = "taxis"
accessKey = "…"
secretKey = "…"
```

`[auth.github]` and `[github]` are easy to conflate but serve different purposes: the first is a
GitHub OAuth App used for **signing in**, the second is a personal-access token the server uses to
**call the GitHub API** on your behalf (importing issues, evaluating `github-ci` checks, reading
package manifests for the repository graph). They are configured independently of each other.

A file that fails to parse, holds a setting of the wrong type, or names a port outside 1–65535
stops startup with the line at fault. A key the server does not recognise is reported on stderr
and otherwise ignored, so a typo does not pass silently. On startup the server also logs which
file it read, whether Google/GitHub OAuth are configured, and the redirect URIs it expects.

### Environment variables

Every setting also has an environment variable, which **takes precedence** over the file — which
is what lets a container override a baked-in configuration. Variables may be exported into the
shell or placed in a `.env` file in the working directory; the full order is environment, then
`.env`, then `config.toml`, then the defaults above.

| Variable | `config.toml` | Purpose |
| --- | --- | --- |
| `ISSUES_PORT` | `port` | Port to listen on |
| `ISSUES_HOST` | `host` | Address to bind to |
| `ISSUES_DB` | `db` | SQLite database path |
| `ISSUES_FRONTEND_DIR` | `frontendDir` | Directory of built frontend assets |
| `ISSUES_BASE_URL` | `baseUrl` | Public URL (used for the OAuth redirects) |
| `ISSUES_CENTRAL_PASSWORD` | `auth.password` | Central login password; when set, password login is enabled |
| `ISSUES_ADMIN_EMAILS` | `auth.adminEmails` | Emails granted admin on login — comma-separated in the variable, a list in the file |
| `ISSUES_DEV_LOGIN` | `auth.devLogin` | Enables `POST /api/auth/dev-login` for local use |
| `ISSUES_GOOGLE_CLIENT_ID` | `auth.google.clientId` | Google OAuth client id; when set, mutations require auth |
| `ISSUES_GOOGLE_CLIENT_SECRET` | `auth.google.clientSecret` | Google OAuth client secret |
| `ISSUES_GITHUB_CLIENT_ID` | `auth.github.clientId` | GitHub OAuth App client id; when set, mutations require auth |
| `ISSUES_GITHUB_CLIENT_SECRET` | `auth.github.clientSecret` | GitHub OAuth App client secret |
| `ISSUES_GITHUB_TOKEN` | `github.token` | Token for GitHub API calls (import, CI checks) — unrelated to the OAuth App above |
| `ISSUES_CHECK_INTERVAL` | `checkInterval` | Background check-sweep interval in seconds (`0` disables) |
| `ISSUES_REPO_DEPS_TTL` | `repoDepsTtl` | How long resolved repository dependencies stay cached, in seconds (`0` disables caching) |
| `ISSUES_FILESTORES` | `[[filestores]]` | File stores for `file` artifacts — a JSON array in the variable (see [File artifacts](#file-artifacts)) |
| `ISSUES_VERBOSE` | `verbose` | Log every request to stderr (also `--verbose`) |
| `ISSUES_CONFIG` | — | Path of the configuration file to read (also `--config`) |

A blank value counts as unset, so `ISSUES_GOOGLE_CLIENT_ID=` leaves Google OAuth off rather than
configuring it with an empty id — which is what makes the `${VAR:-}` placeholders in
`docker/docker-compose.yaml` safe to leave empty.

When neither Google nor GitHub OAuth is configured the API is open (single-user/local mode); when
either is, write operations require an authenticated session, and managing actors, groups, and
labels (plus running imports) additionally requires an **admin** actor.

## Sign-in with Google

1. In the [Google Cloud Console](https://console.cloud.google.com/) create an **OAuth 2.0 Client
   ID** (application type "Web application").
2. Add an **Authorized redirect URI** of `<baseUrl>/auth/google/callback` (e.g.
   `http://localhost:8080/auth/google/callback` for local use, or your public URL in production).
3. Put the client credentials and your public URL in `config.toml`, then run `lake exe taxis`:

   ```toml
   baseUrl = "https://issues.example.com"

   [auth]
   adminEmails = ["you@example.com"]

   [auth.google]
   clientId = "…"
   clientSecret = "…"
   ```

   The matching environment variables (`ISSUES_GOOGLE_CLIENT_ID`, `ISSUES_GOOGLE_CLIENT_SECRET`,
   `ISSUES_BASE_URL`, `ISSUES_ADMIN_EMAILS`) do the same thing.

4. Click **Sign in with Google**. On the first login the server bootstraps admin for any email
   listed in `auth.adminEmails`.

### Connecting a Google account to an actor

On login the server resolves the Google identity to an actor in this order:

1. by the Google subject id (`google_sub`) if this account has logged in before;
2. otherwise by **email** — a pre-existing actor with the same email is *linked* (its `google_sub`
   is filled in);
3. otherwise a new actor is created.

So to connect a Google account to an actor you created in advance, just set that actor's **email**
to the Google account's email; their first sign-in links the two automatically. Only actors with a
linked Google account can authenticate.

## Sign-in with GitHub

1. In GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App** (a personal
   account or organization both work).
2. Set **Authorization callback URL** to `<baseUrl>/auth/github/callback` (e.g.
   `http://localhost:8080/auth/github/callback` for local use, or your public URL in production).
3. Generate a client secret, then put both credentials and your public URL in `config.toml`:

   ```toml
   baseUrl = "https://issues.example.com"

   [auth]
   adminEmails = ["you@example.com"]

   [auth.github]
   clientId = "…"
   clientSecret = "…"
   ```

   Note that this is `[auth.github]`, the OAuth App used for signing in — not `[github].token`,
   which is the personal-access token for API calls.

4. Click **Sign in with GitHub**. On the first login the server bootstraps admin for any email
   listed in `auth.adminEmails`.

Login requests the `read:user user:email` scopes. If the account's primary email isn't public, the
server falls back to `GET /user/emails` and uses the verified primary address from there instead —
either way, sign-in needs *some* verified email on the GitHub account.

### Connecting a GitHub account to an actor

Same resolution order as Google, using the GitHub account's numeric user id instead of a Google
subject id:

1. by the linked GitHub user id (`github_id`) if this account has logged in before;
2. otherwise by **email** — a pre-existing actor with the same email is *linked* (its `github_id`
   is filled in);
3. otherwise a new actor is created.

Google and GitHub sign-in can be enabled at the same time; an actor may have both a `googleSub` and
a `githubId` linked (independently, via matching email on each provider's first login).

## File artifacts

A `file` artifact links an issue to a file held in an S3-compatible object store — a self-hosted
[Garage](https://garagehq.deuxfleurs.fr/) or [SeaweedFS](https://github.com/seaweedfs/seaweedfs),
an actual AWS bucket. The server never proxies file bytes: it mints **presigned URLs** (AWS
Signature v4), so uploads and downloads go straight between the browser and the bucket, and the
store's credentials never leave the server. Attaching a `file` artifact in the UI offers a drop
zone; the file is uploaded under a fresh `uploads/…` key and the artifact then records the store
name and object key. Rendering an artifact resolves that pair into a time-limited download link
(default 1 hour, `urlTtlSeconds`; signing times are rounded for cacheability, so a link can
outlive the TTL by up to an hour — never by more than the TTL itself), so nothing permanent or
secret is stored anywhere.

Stores are declared as `[[filestores]]` tables in `config.toml` — several can be configured at
once, and the attach dialogue lets you pick one (the first is the default):

```toml
[[filestores]]
name = "primary"
kind = "s3"
endpoint = "https://s3.example.com"
region = "garage"
bucket = "taxis"
accessKey = "…"
secretKey = "…"
prefix = "taxis/"
```

`name` is what `file` artifacts refer to, and `kind` selects the backend (file-store kinds are a
plugin, like artifact kinds; `s3` is built in). For `s3`: `region` is the signing region (Garage
calls it `s3_region`; AWS, the bucket's region); `prefix` (optional) is a key prefix everything
the tracker writes lives under; `pathStyle` (default `true`) addresses objects as
`endpoint/bucket/key` rather than `bucket.endpoint/key`; `urlTtlSeconds` (default 3600) is how
long download links stay valid.

The same stores can be given as a JSON array in `ISSUES_FILESTORES`, with the field names above —
which is how they are configured where there is no configuration file, as under Docker Compose:

```bash
ISSUES_FILESTORES='[{"name": "primary", "kind": "s3", "endpoint": "https://s3.example.com",
  "region": "garage", "bucket": "taxis", "accessKey": "…", "secretKey": "…", "prefix": "taxis/"}]'
```

A store that cannot be built is reported on startup and skipped; the others still come up, and
`file` artifacts pointing at the missing one degrade to a plain label instead of a link.

Direct browser uploads need a **CORS rule on the bucket** allowing `PUT` from the tracker's
origin (with the `Content-Type` header); without one, the drop zone fails and the artifact form
can still be filled in by hand to point at any object already in the bucket. Bots do the same via
the API: `POST /api/filestores/primary/upload-url` with `{"filename": …, "contentType": …}`, `PUT`
the bytes to the returned URL, then attach a `file` artifact with the returned key.

Anyone who can see an issue can follow its file links while they last; the object keys carry a
random component, so links can't be guessed, but a bucket should still not be publicly readable.

## API overview

All endpoints are under `/api`. Responses are JSON. Interactive documentation (Swagger UI) is
served at **`/docs`**, backed by the OpenAPI spec at `GET /api/openapi.json`.

- `GET /health`, `GET /plugins`, `GET /graph`, `GET /openapi.json`
- `GET|POST /actors`, `GET|PATCH|DELETE /actors/:id`
- `GET|POST /groups`, `GET|PATCH|DELETE /groups/:id`
- `GET|POST /labels`, `GET|PATCH|DELETE /labels/:id`
- `GET /issues` (filters: `state`, `label` = label id, `q`, `assignee`; paging: `limit`, `offset`),
  `POST /issues`, `GET|PATCH|DELETE /issues/:id`, `GET /issues/:id/events`
- `GET /issues/page` — one page of list rows, cursor-paged; what the issue list reads
- `GET /issues/index` — issues as `{id, title, parent}`, i.e. what it takes to *name* one.
  `?ids=1,2,3` names a known handful, `?q=…` searches titles (or an issue number) for a picker;
  unfiltered it returns every visible issue, which grows with the tracker and is not what any page
  should ask for
- `GET /issues/:id/ancestors` — the containment path above an issue, root first
- `POST /issues/:id/artifacts`, `DELETE /artifacts/:id`
- `GET|POST /issues/:id/checks`, `POST /checks/:id/run`, `DELETE /checks/:id`
- `GET|POST /issues/:id/comments`, `PATCH|DELETE /comments/:id`
- `GET|POST /me/tokens`, `DELETE /me/tokens/:id`, `GET|POST /actors/:id/tokens` (admin)
- `POST /import/github`, `POST /import/gdoc`
- Auth: `GET /auth/google/login`, `GET /auth/google/callback`, `GET /auth/github/login`,
  `GET /auth/github/callback`, `POST /auth/logout`, `POST /auth/dev-login`,
  `POST /auth/password-login`, `GET /me`, `GET /session` (the current actor — `null` when signed
  out — plus which sign-in methods are configured; one request for what the top bar needs)

## MCP

`POST /mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io) (Streamable
HTTP transport, JSON-RPC 2.0) — the same tools available in `taxis-plugin/` (list/create/update/
delete issues, comments, events, labels, actors), backed by the same handlers as the REST API
above, not a separate implementation. It's part of this server, not a standalone process: running
`lake exe taxis` or the Docker image serves it automatically on whatever host/port already serves
`/api`, so it's reachable remotely wherever the rest of the server is (no extra container, port,
or startup step needed). Authentication is the same `Authorization: Bearer <token>` as the REST
API; reads work without one in open mode, writes always need one once any login method is
configured. See `taxis-plugin/README.md` for the tool list and example client configs.

## Tests

```bash
lake test
```

Runs JSON round-trip, database, plugin-registry, and visibility tests.

## Design notes

- **Visibility** — an issue is visible if it has no visibility groups (public) or the viewer
  shares one of its groups. Visibility is **not** inherited from parent issues in this version.
- **Full-text search** is `LIKE`-based, because the bundled SQLite is built without FTS5.
