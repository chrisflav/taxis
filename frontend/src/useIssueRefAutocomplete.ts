import { useEffect, useRef, useState } from "react";
import type { Issue } from "./types";
import { fuzzyMatch } from "./fuzzy";
import { caretClientCoords } from "./caretCoords";

// Drives a "#123"-style issue-reference autocomplete on a plain `<input>` or `<textarea>`: typing
// `#` followed by text opens a fuzzy-matched popover of issues to insert, replacing the partial
// token with `#<id> ` at the caret. `T` pins the hook to the concrete element type so its `elRef`
// can be attached directly (input vs textarea aren't assignable to one shared ref type).
export function useIssueRefAutocomplete<T extends HTMLInputElement | HTMLTextAreaElement>(
  issues: Issue[],
  value: string,
  onChange: (v: string) => void,
) {
  const [query, setQuery] = useState<string | null>(null);
  // Where the popover should render — right at the caret, not at a fixed spot on the field.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const elRef = useRef<T>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const checkTrigger = (text: string, caret: number) => {
    const m = text.slice(0, caret).match(/#([\w-]*)$/);
    if (m && elRef.current) {
      setQuery(m[1]);
      setMenuPos(caretClientCoords(elRef.current, caret));
    } else {
      setQuery(null);
    }
  };

  const onChangeWrapped = (e: React.ChangeEvent<T>) => {
    onChange(e.target.value);
    checkTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setQuery(null);
  };

  // A click anywhere outside the field and the popover itself closes it — otherwise it stays open
  // (e.g. floating over unrelated content) until the field loses focus some other way.
  useEffect(() => {
    if (query == null) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (elRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setQuery(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [query]);

  const options = query == null ? [] : issues.filter((i) => fuzzyMatch(query, `${i.id} ${i.title}`)).slice(0, 8);

  const choose = (issue: Issue) => {
    const el = elRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const m = value.slice(0, caret).match(/#([\w-]*)$/);
    if (!m) return;
    const start = caret - m[0].length;
    const insertion = `#${issue.id} `;
    onChange(value.slice(0, start) + insertion + value.slice(caret));
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insertion.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return { elRef, menuRef, menuPos, query, options, onChangeWrapped, onKeyDown, choose, close: () => setQuery(null) };
}
