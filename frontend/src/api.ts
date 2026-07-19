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
  IssueState,
  Label,
  Notification,
  Plugins,
  ReviewRequest,
  ReviewState,
} from "./types";

const BASE = "/api";

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.error ?? res.statusText);
  }
  return data as T;
}

function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
}

export interface IssueFilters {
  state?: string;
  label?: string;
  q?: string;
  assignee?: string;
}

export const api = {
  health: () => req<{ status: string; version: string; centralPasswordEnabled?: boolean; googleEnabled?: boolean; githubEnabled?: boolean }>("/health"),
  googleLoginUrl: BASE + "/auth/google/login",
  githubLoginUrl: BASE + "/auth/github/login",

  me: () => req<Actor>("/me"),
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

  listIssues: (filters: IssueFilters = {}) =>
    req<Issue[]>("/issues" + qs(filters as Record<string, string | undefined>)),
  getIssue: (id: number) => req<IssueDetail>(`/issues/${id}`),
  createIssue: (body: Partial<Issue>) =>
    req<Issue>("/issues", { method: "POST", body: JSON.stringify(body) }),
  updateIssue: (id: number, body: Record<string, unknown>) =>
    req<Issue>(`/issues/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteIssue: (id: number) => req<unknown>(`/issues/${id}`, { method: "DELETE" }),

  addArtifact: (issueId: number, kind: string, payload: unknown) =>
    req<unknown>(`/issues/${issueId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ kind, payload }),
    }),
  deleteArtifact: (id: number) => req<unknown>(`/artifacts/${id}`, { method: "DELETE" }),

  addCheck: (issueId: number, kind: string, config: unknown) =>
    req<Check>(`/issues/${issueId}/checks`, {
      method: "POST",
      body: JSON.stringify({ kind, config }),
    }),
  runCheck: (id: number) => req<Check>(`/checks/${id}/run`, { method: "POST" }),
  deleteCheck: (id: number) => req<unknown>(`/checks/${id}`, { method: "DELETE" }),

  addComment: (issueId: number, body: string, review?: ReviewState) =>
    req<Comment>(`/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body, review }),
    }),
  updateComment: (id: number, body: string) =>
    req<Comment>(`/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),
  deleteComment: (id: number) => req<unknown>(`/comments/${id}`, { method: "DELETE" }),

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

  listActors: () => req<Actor[]>("/actors"),
  createActor: (body: Record<string, unknown>) =>
    req<Actor>("/actors", { method: "POST", body: JSON.stringify(body) }),
  updateActor: (id: number, body: Record<string, unknown>) =>
    req<Actor>(`/actors/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteActor: (id: number) => req<unknown>(`/actors/${id}`, { method: "DELETE" }),
  listGroups: () => req<Group[]>("/groups"),
  createGroup: (body: Record<string, unknown>) =>
    req<Group>("/groups", { method: "POST", body: JSON.stringify(body) }),
  updateGroup: (id: number, body: Record<string, unknown>) =>
    req<Group>(`/groups/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteGroup: (id: number) => req<unknown>(`/groups/${id}`, { method: "DELETE" }),

  listLabels: () => req<Label[]>("/labels"),
  createLabel: (body: Record<string, unknown>) =>
    req<Label>("/labels", { method: "POST", body: JSON.stringify(body) }),
  updateLabel: (id: number, body: Record<string, unknown>) =>
    req<Label>(`/labels/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLabel: (id: number) => req<unknown>(`/labels/${id}`, { method: "DELETE" }),

  graph: () => req<GraphData>("/graph"),

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
