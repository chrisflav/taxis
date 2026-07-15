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
  Plugins,
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
  health: () => req<{ status: string; version: string; centralPasswordEnabled?: boolean }>("/health"),
  googleLoginUrl: BASE + "/auth/google/login",

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

  addComment: (issueId: number, body: string) =>
    req<Comment>(`/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),
  updateComment: (id: number, body: string) =>
    req<Comment>(`/comments/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),
  deleteComment: (id: number) => req<unknown>(`/comments/${id}`, { method: "DELETE" }),

  listEvents: (issueId: number) => req<Event[]>(`/issues/${issueId}/events`),

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

  importGithub: (owner: string, repo: string, state: string) =>
    req<{ imported: number }>("/import/github", {
      method: "POST",
      body: JSON.stringify({ owner, repo, state }),
    }),
  importGdoc: (text: string) =>
    req<{ imported: number }>("/import/gdoc", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
};

export const STATES: IssueState[] = ["open", "closed", "completed"];
