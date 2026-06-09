import type { Issue } from "./types";
import { fuzzyMatch } from "./fuzzy";

export interface IssueFilterState {
  q: string;
  state: string;
  labels: number[];
  assignees: number[];
}

export const emptyFilters: IssueFilterState = { q: "", state: "", labels: [], assignees: [] };

// Labels use AND (must have every selected label); assignees use OR (any selected actor).
export function matchesFilters(i: Issue, f: IssueFilterState): boolean {
  return (
    (f.state === "" || i.state === f.state) &&
    f.labels.every((l) => i.labels.includes(l)) &&
    (f.assignees.length === 0 || f.assignees.some((a) => i.assignees.includes(a))) &&
    fuzzyMatch(f.q, `${i.title} ${i.description}`)
  );
}
