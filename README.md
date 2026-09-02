# taxis

taxis is an extensible issue tracker built in Lean 4, with a REST API backend and a TypeScript
(React) frontend.

## Architecture

- **Backend** — a Lean 4 REST API on the in-core [`Std.Http`](https://lean-lang.org) async
  server, persisting to SQLite via [`leansqlite`](https://github.com/leanprover/leansqlite)
  (bundled — no system SQLite needed). JSON (de)serialisation uses `Lean.Data.Json`.
- **Frontend** — a Vite + React + TypeScript single-page app in [`frontend/`](frontend),
  built to static assets and served by the backend. The same build, packaged with Capacitor, is the
  **mobile app** — see [The mobile app](#the-mobile-app).
- **Extensibility** — *artifacts* (things attached to an issue: a GitHub PR, a branch),
  *checks* (conditions like "CI passes on a branch"), and the two halves of the repository
  dependency graph (*forges*, which read files out of repositories on one host, and *dependency
  providers*, which read dependencies out of one ecosystem's manifests) are all plugins. Each
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
  costs network requests, so results are cached (`ISSUES_REPO_DEPS_TTL`) and the view has a
  **Refresh** button. Only repositories on issues you can see enter the graph.
- **Changes** — `GET /api/changes?since=<seq>` is an append-only feed of issues whose list row has
  moved, so a client keeping a local copy follows the tracker instead of re-reading it. Each entry
  carries the issue's current row, or `null` meaning drop it — deleted, or no longer visible to
  you. `upTo` is the next cursor and is exhaustive; `more` means the page was capped; `reset` means
  the cursor predates the retained log and the tracker should be read again. Called without
  `since` it answers only with `upTo`, which is what to take *before* a full read so nothing falls
  between the two. `GET /api/changes/stream` is the same news pushed: an event stream that nudges
  (with no payload — only `/changes` knows which changes are yours) whenever the tracker moves.
  The log is written by database triggers, so no write path can forget to file one, and cascades
  are covered for free; deletions leave a tombstone that outlives the row, which is the one thing
  no ordinary query can report.
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

Then open <http://localhost:8080>.

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
the `${VAR:-default}` placeholders there.

### The mobile app

The app is this same frontend, packaged with [Capacitor](https://capacitorjs.com) — the same
components, the same bundle, the same offline queue, in a WebView. There is no second
implementation to keep in step, and no second set of views to add a feature to twice.

Two things differ between the page a taxis server serves and the app on a phone, and both live in
[`frontend/src/server.ts`](frontend/src/server.ts):

- **Where the server is.** In a browser the app was served *by* the tracker, so the API is at
  `/api` on its own origin. Packaged, it has to be told — and since a phone is one device used
  against several trackers, it keeps a **list** of them with one current. That is the **Servers**
  screen (the account menu, or the tracker's name next to the wordmark), and it is the only screen
  that exists solely in the app. Switching is one tap; each entry keeps its own token and its own
  queue of unsent changes, so moving between two trackers never costs you work on either.
- **How it authenticates.** In a browser, the session cookie the server set. Packaged, requests are
  cross-origin, and the server's `Access-Control-Allow-Origin: *` cannot be combined with
  credentials — so the app carries an **API token** (**Tokens** in the web UI) as
  `Authorization: Bearer`, one per server — a token is issued by one tracker and means nothing to
  another. The OAuth and password sign-ins all end in a cookie on the server's origin, which an app
  running from your device could never send back, so it does not offer them.

With no token the app still works, read-only: taxis lets anyone read.

**Offline.** The app keeps what it has read, per server, and hydrates from it at startup, so opening
it with no connection shows the issues you were last looking at rather than an error over a blank
list. The web build does not do this and should not: there a page load is somebody asking for the
page, whereas on a phone it is usually the system having reclaimed the WebView. What *both* now do
is treat a read that fails because nothing answered as no news — the last answer stays on screen and
the offline indicator says why — while a read the server refused stays an error, which is the same
rule the write queue has always applied in the other direction. Writes made offline queue as they
do on the web, and go out on reconnect. See [`frontend/src/readCache.ts`](frontend/src/readCache.ts).

**Every issue, on the device.** A cache holds what you happened to read; the app also keeps a
**copy of the tracker itself**, so the issue list works offline over *all* of it — every filter,
every sort, and search — rather than over the one page of one filter that was cached. Tapping an
issue you have never opened still needs the server for its description, comments and history: what
is mirrored is the list row, which is what the list, the tree and the pickers draw. See
[`frontend/src/mirror.ts`](frontend/src/mirror.ts) and
[`frontend/src/sync.ts`](frontend/src/sync.ts).

The copy is not a fallback: in the app it is **where the issue list is read from**. Asking the
server for a page it has already handed over is a round trip to learn what is in hand, so the list
appears at once, behaves identically with no connection, and searches the whole tracker rather than
the page that happened to be cached. The network became a background reconciler instead of the
thing the view waits on. Only the very first launch reads the list over the network, because there
is nothing on the device yet.

Keeping the copy true is the [change feed](#concepts) above:

- the **first** sync walks the issue list, five hundred rows a request — ten requests at most, once.
  The change-log cursor is taken *before* that walk starts, so anything that moves while it runs is
  replayed rather than falling between the two reads;
- every sync after that is one call to `/api/changes?since=<cursor>`, which carries the issues that
  moved and — unlike any walk — the ones that were **deleted**;
- and it usually is not asked for at all. `/api/changes/stream` stays open and says when the
  tracker moves, so an edit made by somebody else appears on screen with nothing polling and no
  reload.

The remaining triggers are events that already happen: the app finishing its load, the session
resolving, connectivity returning, the offline write queue draining. **Servers** shows how many
issues are held, when they were last synced and whether the stream is connected, with a *Sync now*
button for the moment before a flight. Issues are visibility-filtered per actor, so the copy
records who it was built for and is read again rather than extended when a different account signs
in. Trackers larger than 5,000 issues keep their most recently updated 5,000 — the same budget the
list holds in memory — and the app says so rather than implying it has everything.

The mirror is IndexedDB rather than `localStorage`: an origin gets about 5 MB of the latter in
total, and its other two tenants there are the read cache and the only copy of your unsent writes,
which is not a quota to compete for. None of this exists in the web build, where the tracker serves
the page and there is no launch without it — `isNativeApp` is a build-time constant, so the whole
thing folds away and the browser bundle carries no part of it.

The app is also the first taxis client that ships **separately from the server** — a phone keeps the
build it was installed with, so it can be newer than the tracker it is pointed at, which a browser
can never be. The connect screen's *Check connection* therefore reports two things: that the address
answers, and that the server has the endpoints this build calls. A server that is too old is named
as such, with the commit to update past — rather than being discovered later as an empty issue list.

```bash
cd frontend
npm install
npm run app:sync     # build the web bundle and copy it into the native project
npm run app:apk      # …and assemble a debug APK (needs an Android SDK)
npm run app:open     # or open the project in Android Studio
```

The APK lands in `frontend/android/app/build/outputs/apk/`. The **Android app** workflow builds one
on every change to `frontend/`, and uploads it as a run artifact; dispatching it with *publish* also
attaches it to the rolling `app-latest` prerelease, which is what to send somebody who just wants to
install it. Set the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD` repository secrets to get a signed release APK — without them the release
build is unsigned and the debug APK is the installable one.

The debug key (`frontend/android/debug.keystore`) is committed on purpose. Android refuses to
install a package over one signed by a different key — reporting it as "App not installed" — and a
CI runner has no keystore, so left to itself Gradle invents one per run and no build can ever
upgrade another. It is not a secret: the credentials are the ones Android's own debug keystore has
always used, and it signs only the debug build type. Release signing still comes from outside the
repository. Changing which key signs a build — debug to release, or a new release key — still needs
one uninstall on each device.

iOS is the same web build: `npx cap add ios` in `frontend/`, then build it on a Mac. The platform
is not committed because nothing in CI can compile it.

## Configuration

All configuration is via environment variables. They may be exported into the shell **or** placed
in a `.env` file in the working directory (real environment variables take precedence). On startup
the server logs whether Google/GitHub OAuth are configured and the redirect URIs it expects.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ISSUES_PORT` | `8080` | Port to listen on |
| `ISSUES_DB` | `issues.sqlite` | SQLite database path |
| `ISSUES_FRONTEND_DIR` | `frontend/dist` | Directory of built frontend assets |
| `ISSUES_BASE_URL` | `http://localhost:<port>` | Public URL (used for the OAuth redirects) |
| `ISSUES_GOOGLE_CLIENT_ID` | — | Google OAuth client id; when set, mutations require auth |
| `ISSUES_GOOGLE_CLIENT_SECRET` | — | Google OAuth client secret |
| `ISSUES_GITHUB_CLIENT_ID` | — | GitHub OAuth App client id; when set, mutations require auth |
| `ISSUES_GITHUB_CLIENT_SECRET` | — | GitHub OAuth App client secret |
| `ISSUES_GITHUB_TOKEN` | — | Token for GitHub API calls (import, CI checks) — unrelated to the OAuth App above; see below |
| `ISSUES_CHECK_INTERVAL` | `0` | Background check-sweep interval in seconds (`0` disables) |
| `ISSUES_REPO_DEPS_TTL` | `3600` | How long resolved repository dependencies stay cached, in seconds (`0` disables caching) |
| `ISSUES_ADMIN_EMAILS` | — | Comma-separated emails granted admin on login (bootstrap) |
| `ISSUES_DEV_LOGIN` | — | If set, enables `POST /api/auth/dev-login` for local use |

`ISSUES_GITHUB_CLIENT_ID`/`_SECRET` and `ISSUES_GITHUB_TOKEN` are easy to conflate but serve
different purposes: the former is a GitHub OAuth App used for **signing in**, the latter is a
personal-access token the server uses to **call the GitHub API** on your behalf (importing issues,
evaluating `github-ci` checks, reading package manifests for the repository graph) — they can be
configured independently of each other.

When neither Google nor GitHub OAuth is configured the API is open (single-user/local mode); when
either is, write operations require an authenticated session, and managing actors, groups, and
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

## Sign-in with GitHub

1. In GitHub, go to **Settings → Developer settings → OAuth Apps → New OAuth App** (a personal
   account or organization both work).
2. Set **Authorization callback URL** to `<ISSUES_BASE_URL>/auth/github/callback` (e.g.
   `http://localhost:8080/auth/github/callback` for local use, or your public URL in production).
3. Generate a client secret, then run the server with both credentials and your public URL set:

   ```bash
   ISSUES_GITHUB_CLIENT_ID=... \
   ISSUES_GITHUB_CLIENT_SECRET=... \
   ISSUES_BASE_URL=https://issues.example.com \
   ISSUES_ADMIN_EMAILS=you@example.com \
   lake exe taxis
   ```

4. Click **Sign in with GitHub**. On the first login the server bootstraps admin for any email
   listed in `ISSUES_ADMIN_EMAILS`.

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
