import { useEffect, useRef, useState } from "react";

export interface Option {
  value: number;
  label: string;
}

// A compact multi-select: shows selected values as removable chips and a checklist popover.
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "Select…",
}: {
  options: Option[];
  selected: number[];
  onChange: (next: number[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const toggle = (v: number) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const labelOf = (v: number) => options.find((o) => o.value === v)?.label ?? String(v);

  return (
    <div className="multiselect" ref={ref}>
      <div className="ms-control" onClick={() => setOpen((o) => !o)}>
        {selected.length === 0 ? (
          <span className="muted">{placeholder}</span>
        ) : (
          selected.map((v) => (
            <span key={v} className="chip">
              {labelOf(v)}
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
          {options.map((o) => (
            <label key={o.value} className="ms-item">
              <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
              {o.label}
            </label>
          ))}
          {options.length === 0 && <div className="muted small" style={{ padding: 8 }}>No options</div>}
        </div>
      )}
    </div>
  );
}
