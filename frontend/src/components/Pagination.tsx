import { useMemo, useState } from "react";

const SIZES = [10, 25, 50, 100];

// Client-side pagination over an already-filtered list, with a configurable page size. Paging
// state clamps itself when the underlying list shrinks (e.g. after filtering), so the current
// page is always valid.
export function usePagination<T>(items: T[], defaultSize = 25) {
  const [size, setSize] = useState(defaultSize);
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const clamped = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => items.slice(clamped * size, clamped * size + size),
    [items, clamped, size],
  );

  return {
    pageItems,
    page: clamped,
    setPage,
    size,
    setSize,
    pageCount,
    total: items.length,
  };
}

export function Pagination({
  page,
  pageCount,
  size,
  total,
  setPage,
  setSize,
}: {
  page: number;
  pageCount: number;
  size: number;
  total: number;
  setPage: (p: number) => void;
  setSize: (s: number) => void;
}) {
  if (total === 0) return null;
  const from = page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return (
    <div className="pagination row">
      <span className="muted small">{from}–{to} of {total}</span>
      <div className="spacer" />
      <label className="row small" style={{ margin: 0, gap: 6 }}>
        Per page
        <select
          value={size}
          onChange={(e) => { setSize(Number(e.target.value)); setPage(0); }}
          style={{ width: "auto" }}
        >
          {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <button disabled={page <= 0} onClick={() => setPage(page - 1)}>‹ Prev</button>
      <span className="small">Page {page + 1} / {pageCount}</span>
      <button disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>Next ›</button>
    </div>
  );
}
