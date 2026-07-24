export type IssueState = "open" | "closed" | "completed";
export type CheckStatus = "pending" | "passing" | "failing" | "error";
export type ReviewState = "approve" | "request_changes";

export interface Group {
  id: number;
  name: string;
  description: string | null;
}

export interface Label {
  id: number;
  name: string;
  description: string | null;
  color: string;
}

export interface Actor {
  id: number;
  email: string;
  displayName: string;
  groups: number[];
  googleSub: string | null;
  githubId: string | null;
  admin: boolean;
  bot: boolean;
}

export interface Artifact {
  id: number;
  kind: string;
  payload: unknown;
  display: { label: string; url: string | null };
}

export interface Check {
  id: number;
  kind: string;
  config: unknown;
  status: CheckStatus;
  detail: string | null;
  lastRun: number | null;
}

/** An issue reduced to what it takes to name it: returned by `GET /issues/index` and used for
    breadcrumb chains and issue pickers, which would otherwise force a view to hold every issue. */
export interface IssueIndexEntry {
  id: number;
  title: string;
  parent: number | null;
}

export interface Issue {
  id: number;
  // Absent on list rows: `GET /issues?summary=1` omits the two large free-text fields, which no
  // list column renders and which otherwise dominate the payload. Only a single-issue read
  // (`GET /issues/:id`) is guaranteed to carry them.
  description?: string;
  goal?: string;
  title: string;
  state: IssueState;
  locked: boolean;
  labels: number[];
  parent: number | null;
  dependencies: number[];
  assignees: number[];
  artifacts: number[];
  visibility: number[];
  checks: number[];
  creatorId: number | null;
  creatorName: string | null;
  deadline: number | null;
  createdAt: number;
  updatedAt: number;
}

/** One row of the issue list, as `GET /issues/page` returns it.
 *
 *  Deliberately not an `Issue`. A list row carries what the table draws and what its filters narrow
 *  by, and nothing else — no description, goal, creator, creation time or visibility groups, none of
 *  which any column renders. Attachments and children are counts because the only thing drawn is how
 *  many; dependencies keep their ids because the "depends on" filter tests membership. */
export interface IssueListRow {
  id: number;
  title: string;
  state: IssueState;
  locked: boolean;
  parent: number | null;
  deadline: number | null;
  updatedAt: number;
  labels: number[];
  assignees: number[];
  dependencies: number[];
  artifactCount: number;
  checkCount: number;
  /** How many issues are filed under this one, so the tree can offer to unfold a node without
      having read the level below it. */
  childCount: number;
}

/** One page of the issue list. `nextCursor` is null at the end of the result set; `total` is only
 *  computed for the first page of a query. */
export interface IssuePage {
  issues: IssueListRow[];
  nextCursor: string | null;
  total: number | null;
  /** The total broken down by state. Lets a caller show how much of a set is finished without
      holding all of it — the children panel counts progress over every child while displaying one
      page of them. */
  stateCounts: { open: number; closed: number; completed: number } | null;
}

export interface Comment {
  id: number;
  issueId: number;
  authorId: number | null;
  authorName: string | null;
  body: string;
  review: ReviewState | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReviewRequest {
  id: number;
  issueId: number;
  actorId: number;
  actorName: string | null;
  requestedBy: number | null;
  requestedByName: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface Notification {
  id: number;
  actorId: number;
  issueId: number;
  issueTitle: string;
  kind: string;
  data: Record<string, unknown>;
  read: boolean;
  done: boolean;
  createdAt: number;
}

// A recorded change to an issue. `data` shape depends on `kind`:
//   title/description/goal: { from, to }
//   state/parent:           { from, to }
//   locked:                 { to: boolean }
//   dependencies/assignees/visibility/labels: { added: number[], removed: number[] }
//   artifact_added/removed: { kind, label? }
//   check_added/removed:    { kind }
//   comment_edited:         { commentId, from, to }
//   comment_deleted:        { commentId }
export interface Event {
  id: number;
  issueId: number;
  actorId: number | null;
  actorName: string | null;
  actorBot: boolean;
  kind: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ApiToken {
  id: number;
  actorId: number;
  name: string;
  tokenPrefix: string;
  createdAt: number;
  lastUsed: number | null;
}

export interface ApiTokenCreated {
  token: ApiToken;
  secret: string;
}

/** Where an issue sits among the issues sharing its parent, and the two either side of it.
 *  Sent with the issue rather than derived by the client, which is what it used to do — out of a
 *  naming index of the whole tracker, to answer a question about three issues. */
export interface SiblingNav {
  /** 1-based position among the siblings; 0 when the issue has no parent. */
  position: number;
  count: number;
  prev: IssueIndexEntry | null;
  next: IssueIndexEntry | null;
}

export interface IssueDetail {
  issue: Issue;
  assignedActors: Actor[];
  issueLabels: Label[];
  attachedArtifacts: Artifact[];
  attachedChecks: Check[];
  comments: Comment[];
  events: Event[];
  participating: boolean;
  reviewRequests: ReviewRequest[];
  /** The containment path above this issue, root first, excluding the issue itself. */
  ancestors: IssueIndexEntry[];
  siblings: SiblingNav;
}

/** One node of the graph view. Both edge relations ride on the node — `dependencies` are the edges
 *  in dependency mode, `parent` in hierarchy mode — so the graph is one read whichever mode it is
 *  in, and there is no separate edge list saying the same thing a second time. */
export interface GraphNode {
  id: number;
  title: string;
  state: IssueState;
  locked: boolean;
  labels: number[];
  parent: number | null;
  dependencies: number[];
  assignees: number[];
  deadline: number | null;
}

export interface GraphData {
  nodes: GraphNode[];
}

/** Who you are and how you could sign in — one answer to what the top bar needs, where `/me` and
 *  `/health` used to be two requests. `actor` is null when nobody is signed in, which is an answer
 *  and not an error. */
export interface Session {
  actor: Actor | null;
  centralPasswordEnabled: boolean;
  googleEnabled: boolean;
  githubEnabled: boolean;
}

export interface FieldSpec {
  name: string;
  label: string;
  type: string; // "string" | "number" | "boolean" | "text"
  required: boolean;
  placeholder: string | null;
  help: string | null;
}

export interface PluginKind {
  kind: string;
  fields: FieldSpec[];
}

export interface Plugins {
  artifactKinds: PluginKind[];
  checkKinds: PluginKind[];
  // Ecosystems whose dependencies the repository graph can derive, e.g. "lake".
  repoDepsKinds: string[];
}

// One repository in the repository dependency graph. `id` is its canonical
// "host/owner/name", the identity edges refer to.
export interface RepoNode {
  id: string;
  url: string;
  name: string;
  issues: number[];
  // False for a repository that is only depended on, not attached to any issue.
  attached: boolean;
  ecosystem: string | null;
  error: string | null;
}

// `source` depends on `target`; `via` is the provider that derived it.
export interface RepoEdge {
  source: string;
  target: string;
  via: string;
  detail: string | null;
}

export interface RepoGraphData {
  nodes: RepoNode[];
  edges: RepoEdge[];
}
