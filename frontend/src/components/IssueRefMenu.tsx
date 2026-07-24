import type { RefObject } from "react";
import type { IssueIndexEntry } from "../types";
import { issueLabel } from "../breadcrumbs";

// The issue popover shown by `useIssueRefAutocomplete`, positioned (via `pos`, in viewport
// coordinates) right at the caret rather than at a fixed spot on the field.
//
// Each match is named `#id title`, not by its ancestor path: the path needed every issue's parent
// chain, which is precisely what the application no longer downloads to show eight rows.
export function IssueRefMenu({
  options, onChoose, pos, menuRef,
}: {
  options: IssueIndexEntry[];
  onChoose: (issue: IssueIndexEntry) => void;
  pos: { x: number; y: number } | null;
  menuRef?: RefObject<HTMLDivElement>;
}) {
  if (options.length === 0 || !pos) return null;
  return (
    <div ref={menuRef} className="issue-ref-menu" style={{ left: pos.x, top: pos.y }}>
      {options.map((i) => (
        // onMouseDown (not onClick) fires before the field's blur, so the field never loses focus.
        <div key={i.id} className="ms-item" onMouseDown={(e) => { e.preventDefault(); onChoose(i); }}>
          {issueLabel(i)}
        </div>
      ))}
    </div>
  );
}
