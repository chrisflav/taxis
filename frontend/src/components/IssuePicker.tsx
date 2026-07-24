import { useMemo, useState } from "react";
import type { IssueIndexEntry } from "../types";
import { issueLabel } from "../breadcrumbs";
import { useIssueNames, useIssueSearch } from "../issueNames";
import { MultiSelect, type Option } from "./MultiSelect";
import { SearchableSelect } from "./SearchableSelect";

// Choosing an issue — as a parent, as a dependency, as a filter — by searching for it.
//
// Every one of these used to be handed an array of every issue in the tracker and filter it in the
// browser, which is the reason that array was fetched at all. Now the query goes to the server and
// comes back bounded, so opening a picker costs a few hundred bytes and finding an issue works
// however large the tracker is, rather than only for the part of it that had been downloaded.
//
// An option is named `#id title`, not by its full ancestor path: the path needed every issue's
// parent chain, which is exactly what is no longer held, and the number is what disambiguates two
// issues with the same title anyway.

/** The options to offer: the current search results, plus anything already chosen so its chip has
    a name even when the search has moved on. */
function useOptions(selected: number[], results: IssueIndexEntry[], exclude?: (id: number) => boolean): Option[] {
  const names = useIssueNames(selected);
  return useMemo(() => {
    const entries = results.filter((e) => !exclude?.(e.id));
    const seen = new Set(entries.map((e) => e.id));
    for (const id of selected) {
      if (seen.has(id)) continue;
      entries.push(names.get(id) ?? { id, title: "", parent: null });
    }
    return entries.map((e) => {
      const label = e.title ? issueLabel(e) : `#${e.id}`;
      return { value: e.id, label, chipLabel: label };
    });
  }, [results, selected, names, exclude]);
}

/** Choose any number of issues. */
export function IssueMultiPicker({
  selected, onChange, placeholder = "Search issues…", exclude,
}: {
  selected: number[];
  onChange: (next: number[]) => void;
  placeholder?: string;
  /** Issues that must not be offered — an issue cannot be its own parent or dependency. */
  exclude?: (id: number) => boolean;
}) {
  const [query, setQuery] = useState("");
  // Only while the menu is showing. A picker that searched on mount would put a request on every
  // page that has a filter bar, for a menu nobody has opened — which is the shape of problem this
  // whole change is about.
  const [open, setOpen] = useState(false);
  const { options: results, loading } = useIssueSearch(query, open);
  const options = useOptions(selected, results, exclude);
  return (
    <MultiSelect
      options={options}
      selected={selected}
      onChange={onChange}
      placeholder={placeholder}
      onQueryChange={setQuery}
      onOpenChange={setOpen}
      loading={loading}
      emptyLabel="No matching issues"
    />
  );
}

/** Choose one issue, or none. */
export function IssueSelectPicker({
  value, onChange, placeholder = "— none —", exclude,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  exclude?: (id: number) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const { options: results, loading } = useIssueSearch(query, open);
  const selected = useMemo(() => (value != null ? [value] : []), [value]);
  const options = useOptions(selected, results, exclude);
  return (
    <SearchableSelect
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      onQueryChange={setQuery}
      onOpenChange={setOpen}
      loading={loading}
    />
  );
}
