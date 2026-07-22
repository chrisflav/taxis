import type { Issue } from "./types";
import { fuzzyMatch } from "./fuzzy";

export interface IssueFilterState {
  q: string;
  state: string;
  labels: number[];
  assignees: number[];
  // "has one of these as its parent" (OR).
  parents: number[];
  // "depends on all of these" (AND).
  dependsOn: number[];
  // Past its deadline and still open. Kept here with the rest rather than as a checkbox floating
  // beside the filter bar, so it lives in the URL and the stored view like every other filter.
  overdue: boolean;
}

export const emptyFilters: IssueFilterState = {
  q: "", state: "", labels: [], assignees: [], parents: [], dependsOn: [], overdue: false,
};

/** Open, has a deadline, and that deadline has passed. */
export function isOverdue(i: Issue, now = Date.now()): boolean {
  return i.deadline != null && i.state === "open" && i.deadline * 1000 < now;
}

// Labels and dependsOn use AND (must match every selected value); assignees and parents use OR
// (match any selected value).
export function matchesFilters(i: Issue, f: IssueFilterState): boolean {
  return (
    (f.state === "" || i.state === f.state) &&
    f.labels.every((l) => i.labels.includes(l)) &&
    (f.assignees.length === 0 || f.assignees.some((a) => i.assignees.includes(a))) &&
    (f.parents.length === 0 || (i.parent != null && f.parents.includes(i.parent))) &&
    f.dependsOn.every((d) => i.dependencies.includes(d)) &&
    (!f.overdue || isOverdue(i)) &&
    // List rows arrive without a description (see `Issue` in types.ts), so there the query matches
    // titles; where a full issue is on hand the description is searched too, as before.
    fuzzyMatch(f.q, `${i.title} ${i.description ?? ""}`)
  );
}

const numList = (params: URLSearchParams, key: string): number[] =>
  (params.get(key) ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .filter((n) => !Number.isNaN(n));

export function filtersFromParams(params: URLSearchParams): IssueFilterState {
  return {
    q: params.get("q") ?? "",
    state: params.get("state") ?? "",
    labels: numList(params, "labels"),
    assignees: numList(params, "assignees"),
    parents: numList(params, "parents"),
    dependsOn: numList(params, "dependsOn"),
    overdue: params.get("overdue") === "1",
  };
}

export function filtersToParams(f: IssueFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.state) params.set("state", f.state);
  if (f.labels.length) params.set("labels", f.labels.join(","));
  if (f.assignees.length) params.set("assignees", f.assignees.join(","));
  if (f.parents.length) params.set("parents", f.parents.join(","));
  if (f.dependsOn.length) params.set("dependsOn", f.dependsOn.join(","));
  if (f.overdue) params.set("overdue", "1");
  return params;
}

export interface IssueListViewState {
  filters: IssueFilterState;
  view: "list" | "tree";
}

// IssueList mirrors its current filters/view to localStorage (in addition to the URL) so a bare
// "#/issues" link — the top-nav tab, unlike an explicit "?state=..." link — restores the last-used
// view instead of resetting to the hardcoded default every time.
export const VIEW_STATE_STORAGE_KEY = "taxis:issue-list-view";

export function loadStoredViewState(): IssueListViewState | null {
  try {
    const raw = localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { filters: { ...emptyFilters, ...parsed.filters }, view: parsed.view === "tree" ? "tree" : "list" };
  } catch {
    return null;
  }
}
