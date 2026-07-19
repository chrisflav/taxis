import type { Label } from "../types";

// Pick a readable text colour (black or white) for a given hex background.
function contrastColor(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length < 6) return "#111";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111" : "#fff";
}

export function LabelChip({ label }: { label: Pick<Label, "name" | "color" | "description"> }) {
  const color = label.color || "#6b7280";
  return (
    <span
      className="badge label-chip"
      style={{ background: color, borderColor: color, color: contrastColor(color) }}
      title={label.description ?? ""}
    >
      {label.name}
    </span>
  );
}
