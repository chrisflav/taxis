// There's no native DOM API for "where is the caret, in pixels" — the standard workaround (used
// by e.g. the textarea-caret-position library) is to mirror the field's text (up to the caret)
// into a hidden, identically-styled div, then measure where a marker span lands inside it.
const MIRRORED_PROPERTIES = [
  "direction", "boxSizing", "width", "height", "overflowX", "overflowY",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "fontFamily",
  "lineHeight", "textAlign", "textTransform", "textIndent", "textDecoration", "letterSpacing", "wordSpacing", "tabSize",
] as const;

// The caret's position in viewport ("fixed"-positioned) coordinates, just below the text line it's
// on — for placing a popover right where the user is typing instead of at a fixed spot on the field.
export function caretClientCoords(el: HTMLInputElement | HTMLTextAreaElement, caret: number): { x: number; y: number } {
  const isInput = el.tagName === "INPUT";
  const computed = window.getComputedStyle(el);

  const mirror = document.createElement("div");
  const style = mirror.style;
  style.position = "fixed";
  style.visibility = "hidden";
  style.top = "0";
  style.left = "0";
  style.whiteSpace = isInput ? "pre" : "pre-wrap";
  if (!isInput) style.wordWrap = "break-word";
  for (const prop of MIRRORED_PROPERTIES) style[prop] = computed[prop];

  const before = el.value.slice(0, caret);
  mirror.textContent = isInput ? before.replace(/\s/g, " ") : before;
  const marker = document.createElement("span");
  marker.textContent = el.value.slice(caret) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const rect = el.getBoundingClientRect();
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;
  const x = rect.left + marker.offsetLeft - el.scrollLeft;
  const y = rect.top + marker.offsetTop - el.scrollTop + lineHeight;

  document.body.removeChild(mirror);
  return { x, y };
}
