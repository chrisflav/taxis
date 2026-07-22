import { memo, useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { IssueIndexEntry } from "../types";
import { linkifyIssueRefs } from "../issueLinks";

// KaTeX (and its stylesheet) is around half of the application bundle, but only matters for text
// that actually contains math. It is loaded on demand the first time such text is rendered, and
// anything already on screen re-renders once it arrives.
//
// The flags are module-wide, so a page full of comments does one import and one round of
// re-rendering rather than one per block.
let mathLoaded = false;
let mathLoading = false;
const mathWaiters = new Set<() => void>();

function loadMath(): void {
  if (mathLoaded || mathLoading) return;
  mathLoading = true;
  Promise.all([
    import("marked-katex-extension"),
    // Side-effect import: KaTeX ships the layout rules and fonts its markup depends on.
    import("katex/dist/katex.min.css"),
  ])
    .then(([katexExtension]) => {
      marked.use(katexExtension.default({ throwOnError: false }));
      mathLoaded = true;
      mathWaiters.forEach((notify) => notify());
      mathWaiters.clear();
    })
    .catch(() => {
      // Leave the text rendered without math rather than failing the whole view.
    });
}

// Cheap pre-check for the delimiters `marked-katex-extension` recognises. A wrong guess is
// harmless — an unnecessary import, or math that stays plain until something else on the page
// triggers the load — so this errs against downloading 270 KB for prose that mentions a dollar.
const MATH_PATTERN = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\(|\\\[/;

/** Trigger the KaTeX load for text that needs it, and re-render when it lands. */
function useMathReady(needsMath: boolean): void {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!needsMath || mathLoaded) return;
    loadMath();
    const notify = () => bump((n) => n + 1);
    mathWaiters.add(notify);
    return () => { mathWaiters.delete(notify); };
  }, [needsMath]);
}

// `issues`, when passed, is used to render "#123" references as "#123 <title>" instead of a bare
// number — omit it where the referenced issue's title isn't worth the lookup (e.g. list rows,
// which already show the issue's own title next to its number).
//
// Memoised: parsing and sanitising is the most expensive thing a list row does, and the filter bar
// re-renders every row on each keystroke.
export const Markdown = memo(function Markdown({ text, inline = false, issues = [] }: { text: string; inline?: boolean; issues?: IssueIndexEntry[] }) {
  useMathReady(MATH_PATTERN.test(text));

  // Turn bare `#123` issue references into links, then parse markdown.
  const linked = linkifyIssueRefs(text, issues);
  const rawHtml = inline ? marked.parseInline(linked) : marked.parse(linked);

  // Sanitize the output HTML. We allow MathML tags which KaTeX generates.
  const cleanHtml = DOMPurify.sanitize(rawHtml as string, {
    ADD_TAGS: ['math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'mspace', 'msqrt', 'mfrac'],
    ADD_ATTR: ['target', 'display', 'xmlns'],
  });

  return inline
    ? <span className="md md-inline" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
    : <div className="md" dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
});
