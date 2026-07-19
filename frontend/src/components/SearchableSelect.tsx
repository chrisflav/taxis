import { useEffect, useRef, useState } from "react";
import { fuzzyMatch } from "../fuzzy";
import type { Option } from "./MultiSelect";

// A single-value combobox with a fuzzy search box, for choosing among long option lists (e.g. a
// parent issue) where a native <select> offers no way to search.
export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "— none —",
  allowNone = true,
}: {
  options: Option[];
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
  allowNone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (open) { setQuery(""); searchRef.current?.focus(); }
  }, [open]);

  const current = options.find((o) => o.value === value);
  const visible = options.filter((o) => fuzzyMatch(query, o.label));
  const choose = (v: number | null) => { onChange(v); setOpen(false); };

  return (
    <div className="multiselect" ref={ref}>
      <div className="ms-control" onClick={() => setOpen((o) => !o)}>
        {current ? <span className="chip">{current.label}</span> : <span className="muted">{placeholder}</span>}
      </div>
      {open && (
        <div className="ms-menu">
          <input
            ref={searchRef}
            className="ms-search"
            placeholder="Search…"
            value={query}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          />
          {allowNone && (
            <div className="ms-item" onClick={() => choose(null)}>— none —</div>
          )}
          {visible.map((o) => (
            <div
              key={o.value}
              className={`ms-item${o.value === value ? " ms-item-selected" : ""}`}
              onClick={() => choose(o.value)}
            >
              {o.label}
            </div>
          ))}
          {visible.length === 0 && <div className="muted small" style={{ padding: 8 }}>No matches</div>}
        </div>
      )}
    </div>
  );
}
