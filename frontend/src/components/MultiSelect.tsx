import { useEffect, useRef, useState } from "react";
import { fuzzyMatch } from "../fuzzy";

export interface Option {
  value: number;
  label: string;
  /** Shorter stand-in for the chip left behind once the option is chosen. The open menu has room
      to disambiguate (an issue picker names every ancestor); the chip is a one-line slot, and
      giving it the full label is what used to wrap a chosen parent over six lines. */
  chipLabel?: string;
}

// A compact multi-select: shows selected values as removable chips and a checklist popover with a
// search box (auto-focused on open) for narrowing long option lists.
//
// Two modes. Given a fixed `options` array (labels, actors, groups — reference data small enough to
// hold), it filters that array itself, fuzzily. Given `onQueryChange` it does not filter at all:
// the options *are* the answer to the current query, which is how the issue pickers search a
// tracker they no longer hold a copy of.
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Select…",
  onQueryChange,
  onOpenChange,
  loading = false,
  emptyLabel,
}: {
  options: Option[];
  selected: number[];
  onChange: (next: number[]) => void;
  placeholder?: string;
  /** Set for a searched list: the caller answers the query and this stops filtering locally. */
  onQueryChange?: (q: string) => void;
  /** Whether the menu is showing. A searched list uses this to search only while it is open —
      otherwise every picker on the page queries the server for a menu nobody has looked at. */
  onOpenChange?: (open: boolean) => void;
  loading?: boolean;
  /** What an empty option list means, when the caller knows better than "No options". */
  emptyLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searched = onQueryChange != null;

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    onOpenChange?.(open);
    if (open) { setQuery(""); onQueryChange?.(""); searchRef.current?.focus(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setSearch = (q: string) => { setQuery(q); onQueryChange?.(q); };
  const toggle = (v: number) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const optionOf = (v: number) => options.find((o) => o.value === v);
  const labelOf = (v: number) => optionOf(v)?.label ?? `#${v}`;
  const chipLabelOf = (v: number) => optionOf(v)?.chipLabel ?? labelOf(v);
  const visible = searched ? options : options.filter((o) => fuzzyMatch(query, o.label));

  return (
    <div className="multiselect" ref={ref}>
      <div className="ms-control" onClick={() => setOpen((o) => !o)}>
        {selected.length === 0 ? (
          <span className="muted">{placeholder}</span>
        ) : (
          selected.map((v) => (
            <span key={v} className="chip" title={labelOf(v)}>
              <span className="chip-text">{chipLabelOf(v)}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(v);
                }}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      {open && (
        <div className="ms-menu">
          {(searched || options.length > 0) && (
            <input
              ref={searchRef}
              className="ms-search"
              placeholder="Search…"
              value={query}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
            />
          )}
          {visible.map((o) => (
            <label key={o.value} className="ms-item">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
          {loading && visible.length === 0 && <div className="muted small" style={{ padding: 8 }}>Searching…</div>}
          {!loading && visible.length === 0 && (
            <div className="muted small" style={{ padding: 8 }}>
              {emptyLabel ?? (searched || options.length === 0 ? "No options" : "No matches")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
