import type {
  Actor,
  ApiToken,
  ApiTokenCreated,
  Check,
  Comment,
  Event,
  GraphData,
  Group,
  Issue,
  IssueDetail,
  IssueIndexEntry,
  IssuePage,
  IssueState,
  Label,
  Notification,
  Plugins,
  RepoGraphData,
  Session,
  ReviewRequest,
  ReviewState,
} from "./types";
import { invalidateCache } from "./cache";
import { isNetworkError, isQueuedLocally, isOffline, noteReachable, noteUnreachable, queueWrite } from "./offline";

const BASE = "/api";

/**
 * Every request the application makes goes through here, which is what makes this the one place
 * offline editing has to be taught about.
 *
 * A *mutating* request that cannot be sent is handed to the offline queue and resolves as though
 * it had been sent — the change is stored, it will go out on reconnect, and there is nothing for
 * the caller to show an error about. Two things are deliberately narrow about that:
 *
 *   - Only writes. A read that fails keeps failing exactly as it did: the stale-while-revalidate
 *     cache already has the last answer on screen, and queueing a question to ask later is not a
 *     way of answering it now.
 *   - Only a failure to reach the network. A 403, a 409, a 500 — anything the server said — is the
 *     server answering, and goes on being an error.
 *
 * `queueWrite` returns null for a write the queue does not accept (see its comment), in which case
 * nothing here changes and the request fails the way it always has.
 */
async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD";

  if (mutating && isOffline()) {
    const queued = queueWrite(method, path, opts.body);
    if (queued) return queued as T;
  }

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
  } catch (e) {
    if (mutating && isNetworkError(e)) {
      noteUnreachable();
      const queued = queueWrite(method, path, opts.body);
      if (queued) return queued as T;
    }
    throw e;
  }
  // The server answered, so there is a connection — the cheapest evidence there is, since it comes
  // from a request that was being made anyway. This is what sends a queue left over from a dropped
  // connection without anything ever polling to ask whether the connection is back.
  noteReachable();

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.error ?? res.statusText);
  }
  return data as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

/** Server-side issue filters. Every one of these narrows the result set in SQL, so a view that
    can express its filter here transfers only the rows it will actually show. */
export interface IssueFilters {
  state?: string;
  label?: number;
  q?: string;
  assignee?: number;
  /** Direct children of this issue — what the detail view's Children panel lists. */
  parent?: number;
  limit?: number;
  offset?: number;
  /** Drop `description`/`goal` from the rows; see the note on `Issue` in types.ts. */
  summary?: boolean;
}

function issuesPath(f: IssueFilters): string {
  return "/issues" + qs({ ...f, summary: f.summary ? "1" : undefined });
}

/** How many children the detail view shows at once. The panel is a place to see what is filed
    under an issue and jump into it, not a place to page through a thousand rows — beyond this it
    points at the issue list, which is built for that. */
export const CHILDREN_PAGE_SIZE = 100;

/** The children query the issue detail view lists with. Shared with the startup prefetch so both
    derive the same cache key — two hand-written copies would drift, and a key that differs by one
    character is a silent extra request. */
export const childrenQuery = (parent: number): IssuePageQuery =>
  ({ parent, limit: CHILDREN_PAGE_SIZE });

/** The server-side half of the issue list's filters, plus paging. Anything expressible here is
    applied in SQL, so a page carries only rows that will be shown. */
export interface IssuePageQuery {
  state?: string;
  label?: number;
  assignee?: number;
  /** An issue id, or "none" for the roots of the containment tree. */
  parent?: number | "none";
  q?: string;
  sort?: "updated" | "title" | "deadline" | "id";
  limit?: number;
  cursor?: string;
}

export function issuePagePath(query: IssuePageQuery): string {
  return "/issues/page" + qs({ ...query });
}

/** How the naming index is asked for. Never unfiltered from a page: the whole index is 140 KB
 *  gzipped on a ten-thousand-issue tracker, and every page that read it wanted either a handful of
 *  issues it could already name by number or whatever somebody had just typed into a picker. */
export interface IssueIndexQuery {
  /** Name exactly these issues. */
  ids?: number[];
  /** Search titles by substring, or an issue by its number. */
  q?: string;
  limit?: number;
}

export function issueIndexPath(query: IssueIndexQuery = {}): string {
  return "/issues/index" + qs({
    ids: query.ids?.length ? [...query.ids].sort((a, b) => a - b).join(",") : undefined,
    q: query.q,
    limit: query.limit,
  });
}

/** Request paths, doubling as cache keys for `useResource`. */
export const paths = {
  issues: issuesPath,
  issueIndex: issueIndexPath,
  ancestors: (id: number) => `/issues/${id}/ancestors`,
  session: "/session",
  issue: (id: number) => `/issues/${id}`,
  labels: "/labels",
  actors: "/actors",
  groups: "/groups",
  plugins: "/plugins",
  graph: "/graph",
  repoGraph: (external: boolean) => "/repo-graph" + (external ? "?external=1" : ""),
};

/** Anything that changes an issue invalidates every cached issue read: list variants are keyed by
    their filters, and a detail response embeds labels, actors and events.

    A write that only reached the offline queue changes nothing on the server, so there is nothing
    to re-read — and dropping the cache would throw away the last copy of data that cannot be
    fetched again until the connection returns. The queue invalidates these same prefixes itself,
    once the write has actually been applied. */
function issuesChanged<T>(result: T): T {
  if (isQueuedLocally(result)) return result;
  invalidateCache("/issues");
  invalidateCache("/graph");
  return result;
}

/** Drop one cached path after a write to it, so the next read goes back to the server. */
const refreshed = (prefix: string) => <T,>(result: T): T => {
  if (isQueuedLocally(result)) return result;
  invalidateCache(prefix);
  return result;
};

export const api = {
  googleLoginUrl: BASE + "/auth/google/login",
  githubLoginUrl: BASE + "/auth/github/login",

  me: () => req<Actor>("/me"),
  /** Who's signed in and which sign-in methods exist, in one request. Succeeds signed out, with a
      null actor — which is what the sign-in buttons are drawn from. */
  session: () => req<Session>(paths.session),
  devLogin: (email: string, displayName: string) =>
    req<{ token: string; actor: Actor }>("/auth/dev-login", {
      method: "POST",
      body: JSON.stringify({ email, displayName }),
    }),
  passwordLogin: (email: string, password: string) =>
    req<{ token: string; actor: Actor }>("/auth/password-login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => req<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  plugins: () => req<Plugins>("/plugins"),

  listIssues: (filters: IssueFilters = {}) => req<Issue[]>(issuesPath(filters)),
  /** One page of the issue list. See `IssueListRow` for why this is not `listIssues`. */
  issuePage: (query: IssuePageQuery) => req<IssuePage>(issuePagePath(query)),
  /** Issues reduced to `{id, title, parent}` — enough to name one in a breadcrumb, a picker or a
      `#123` reference. Always asked a question (`ids` or `q`): see `IssueIndexQuery`. */
  issueIndex: (query: IssueIndexQuery = {}) => req<IssueIndexEntry[]>(issueIndexPath(query)),
  /** The containment path above an issue, root first, excluding the issue itself. The detail
      response carries its own; this is for a view that needs one for an issue it is not reading. */
  issueAncestors: (id: number) => req<IssueIndexEntry[]>(paths.ancestors(id)),
  getIssue: (id: number) => req<IssueDetail>(`/issues/${id}`),
  createIssue: (body: Partial<Issue>) =>
    req<Issue>("/issues", { method: "POST", body: JSON.stringify(body) }).then(issuesChanged),
  updateIssue: (id: number, body: Record<string, unknown>) =>
    req<Issue>(`/issues/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(issuesChanged),
  deleteIssue: (id: number) => req<unknown>(`/issues/${id}`, { method: "DELETE" }).then(issuesChanged),

  addArtifact: (issueId: number, kind: string, payload: unknown) =>
    req<unknown>(`/issues/${issueId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ kind, payload }),
    }).then(issuesChanged),
  /** Replace an artifact's payload. Its kind is fixed — that is what gives the payload its shape,
      so switching kind means removing this artifact and attaching another. */
  updateArtifact: (id: number, payload: unknown) =>
    req<unknown>(`/artifacts/${id}`, { method: "PATCH", body: JSON.stringify({ payload }) }).then(issuesChanged),
  deleteArtifact: (id: number) =>
    req<unknown>(`/artifacts/${id}`, { method: "DELETE" }).then(issuesChanged),

  addCheck: (issueId: number, kind: string, config: unknown) =>
    req<Check>(`/issues/${issueId}/checks`, {
      method: "POST",
      body: JSON.stringify({ kind, config }),
    }).then(issuesChanged),
  /** Replace a check's config. Like an artifact its kind is fixed, and the server puts the check
      back to `pending` — the old result described the old config. */
  updateCheck: (id: number, config: unknown) =>
    req<Check>(`/checks/${id}`, { method: "PATCH", body: JSON.stringify({ config }) }).then(issuesChanged),
  runCheck: (id: number) => req<Check>(`/checks/${id}/run`, { method: "POST" }).then(issuesChanged),
  deleteCheck: (id: number) => req<unknown>(`/checks/${id}`, { method: "DELETE" }).then(issuesChanged),

  addComment: (issueId: number, body: string, review?: ReviewState) =>
    req<Comment>(`/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, review }),
    }).then(issuesChanged),
  updateComment: (id: number, body: string) =>
    req<Comment>(`/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }).then(issuesChanged),
  deleteComment: (id: number) =>
    req<unknown>(`/comments/${id}`, { method: "DELETE" }).then(issuesChanged),

  listEvents: (issueId: number) => req<Event[]>(`/issues/${issueId}/events`),

  subscribe: (issueId: number) => req<{ participating: boolean }>(`/issues/${issueId}/subscribe`, { method: "POST" }),
  unsubscribe: (issueId: number) => req<{ participating: boolean }>(`/issues/${issueId}/unsubscribe`, { method: "POST" }),

  requestReview: (issueId: number, actorId: number) =>
    req<ReviewRequest>(`/issues/${issueId}/review-requests`, { method: "POST", body: JSON.stringify({ actorId }) }),
  cancelReviewRequest: (id: number) => req<{ deleted: boolean }>(`/review-requests/${id}`, { method: "DELETE" }),

  listNotifications: (opts: {
    read?: boolean; kind?: string; done?: boolean; parent?: number; label?: number; q?: string;
    sort?: "created_asc" | "created_desc"; limit?: number; offset?: number;
  } = {}) =>
    req<Notification[]>("/me/notifications" + qs({
      read: opts.read == null ? undefined : opts.read ? "true" : "false",
      kind: opts.kind,
      done: opts.done == null ? undefined : opts.done ? "true" : "false",
      parent: opts.parent?.toString(),
      label: opts.label?.toString(),
      q: opts.q,
      sort: opts.sort,
      limit: opts.limit?.toString(),
      offset: opts.offset?.toString(),
    })),
  unreadNotificationCount: () => req<{ count: number }>("/me/notifications/unread-count"),
  markNotificationRead: (id: number) => req<{ read: boolean }>(`/me/notifications/${id}/read`, { method: "POST" }),
  markNotificationDone: (id: number) => req<{ done: boolean }>(`/me/notifications/${id}/done`, { method: "POST" }),
  markAllNotificationsRead: () => req<{ ok: boolean }>("/me/notifications/read-all", { method: "POST" }),

  listTokens: () => req<ApiToken[]>("/me/tokens"),
  createToken: (name: string) =>
    req<ApiTokenCreated>("/me/tokens", { method: "POST", body: JSON.stringify({ name }) }),
  deleteToken: (id: number) => req<unknown>(`/me/tokens/${id}`, { method: "DELETE" }),

  // Admin: manage another actor's tokens (e.g. mint a token for a bot).
  listActorTokens: (actorId: number) => req<ApiToken[]>(`/actors/${actorId}/tokens`),
  createActorToken: (actorId: number, name: string) =>
    req<ApiTokenCreated>(`/actors/${actorId}/tokens`, { method: "POST", body: JSON.stringify({ name }) }),

  listActors: () => req<Actor[]>(paths.actors),
  createActor: (body: Record<string, unknown>) =>
    req<Actor>("/actors", { method: "POST", body: JSON.stringify(body) }).then(refreshed("/actors")),
  updateActor: (id: number, body: Record<string, unknown>) =>
    req<Actor>(`/actors/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(refreshed("/actors")),
  deleteActor: (id: number) =>
    req<unknown>(`/actors/${id}`, { method: "DELETE" }).then(refreshed("/actors")),
  listGroups: () => req<Group[]>(paths.groups),
  createGroup: (body: Record<string, unknown>) =>
    req<Group>("/groups", { method: "POST", body: JSON.stringify(body) }).then(refreshed("/groups")),
  updateGroup: (id: number, body: Record<string, unknown>) =>
    req<Group>(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(refreshed("/groups")),
  deleteGroup: (id: number) =>
    req<unknown>(`/groups/${id}`, { method: "DELETE" }).then(refreshed("/groups")),

  listLabels: () => req<Label[]>(paths.labels),
  createLabel: (body: Record<string, unknown>) =>
    req<Label>("/labels", { method: "POST", body: JSON.stringify(body) }).then(refreshed("/labels")),
  updateLabel: (id: number, body: Record<string, unknown>) =>
    req<Label>(`/labels/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then(refreshed("/labels")),
  deleteLabel: (id: number) =>
    req<unknown>(`/labels/${id}`, { method: "DELETE" }).then(refreshed("/labels")),

  graph: () => req<GraphData>(paths.graph),
  repoGraph: (external = false) => req<RepoGraphData>("/repo-graph" + (external ? "?external=1" : "")),
  refreshRepoGraph: () =>
    req<{ refreshed: boolean }>("/repo-graph/refresh", { method: "POST" }).then(refreshed("/repo-graph")),

  importGithub: (owner: string, repo: string, state: string, parent?: number) =>
    req<{ imported: number; updated: number }>("/import/github", {
      method: "POST",
      body: JSON.stringify({ owner, repo, state, parent }),
    }),
  importGdoc: (text: string) =>
    req<{ imported: number }>("/import/gdoc", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
};

export const STATES: IssueState[] = ["open", "closed", "completed"];
