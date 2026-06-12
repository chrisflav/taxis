export type IssueState = "open" | "closed" | "completed";
export type CheckStatus = "pending" | "passing" | "failing" | "error";

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
  admin: boolean;
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

export interface Issue {
  id: number;
  title: string;
  description: string;
  state: IssueState;
  locked: boolean;
  labels: number[];
  parent: number | null;
  dependencies: number[];
  assignees: number[];
  artifacts: number[];
  visibility: number[];
  checks: number[];
  createdAt: number;
  updatedAt: number;
}

export interface Comment {
  id: number;
  issueId: number;
  authorId: number | null;
  authorName: string | null;
  body: string;
  createdAt: number;
  updatedAt: number;
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

export interface IssueDetail {
  issue: Issue;
  assignedActors: Actor[];
  issueLabels: Label[];
  attachedArtifacts: Artifact[];
  attachedChecks: Check[];
  comments: Comment[];
}

export interface GraphData {
  nodes: { id: number; title: string; state: IssueState; labels: number[] }[];
  edges: { issue: number; dependsOn: number }[];
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
}
