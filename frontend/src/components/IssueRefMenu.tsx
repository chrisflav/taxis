import type { RefObject } from "react";
import type { Issue } from "../types";
import { breadcrumbLabel } from "../breadcrumbs";

// The fuzzy-matched issue popover shown by `useIssueRefAutocomplete`, positioned (via `pos`, in
// viewport coordinates) right at the caret rather than at a fixed spot on the field.
export function IssueRefMenu({
  options, issues, onChoose, pos, menuRef,
}: {
  options: Issue[];
  issues: Issue[];
  onChoose: (issue: Issue) => void;
  pos: { x: number; y: number } | null;
  menuRef?: RefObject<HTMLDivElement>;
}) {
  if (options.length === 0 || !pos) return null;
  return (
    <div ref={menuRef} className="issue-ref-menu" style={{ left: pos.x, top: pos.y }}>
      {options.map((i) => (
        // onMouseDown (not onClick) fires before the field's blur, so the field never loses focus.
        <div key={i.id} className="ms-item" onMouseDown={(e) => { e.preventDefault(); onChoose(i); }}>
          {breadcrumbLabel(i, issues)}
        </div>
      ))}
    </div>
  );
}
