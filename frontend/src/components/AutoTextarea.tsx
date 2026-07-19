import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

// A textarea that grows to fit its content instead of showing an internal scrollbar, up to
// `maxHeight`, beyond which it scrolls like a normal textarea. Forwards its ref to the underlying
// DOM node (e.g. for the issue-reference autocomplete, which needs to read/set the caret).
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { maxHeight?: number }
>(function AutoTextarea({ maxHeight = 480, style, ...rest }, forwardedRef) {
  const innerRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(forwardedRef, () => innerRef.current!, []);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, maxHeight) + "px";
  }, [rest.value, maxHeight]);

  return <textarea ref={innerRef} style={{ ...style, maxHeight, overflowY: "auto" }} {...rest} />;
});
