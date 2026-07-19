export interface SortState<K extends string> {
  key: K;
  dir: "asc" | "desc";
}

// A clickable column header that sorts by `k` and shows the active direction — shared by any
// sortable table (issue list, notifications, …).
export function SortHeader<K extends string>({
  label, k, sort, onSort, style,
}: {
  label: string;
  k: K;
  sort: SortState<K>;
  onSort: (k: K) => void;
  style?: React.CSSProperties;
}) {
  const active = sort.key === k;
  return (
    <th
      className={`sortable${active ? " active" : ""}`}
      style={style}
      onClick={() => onSort(k)}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}<span className="sort-arrow">{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
    </th>
  );
}
