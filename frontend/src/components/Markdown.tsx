import { memo, useEffect, useState } from "react";
import type { IssueIndexEntry } from "../types";
import { linkifyIssueRefs } from "../issueLinks";
import { plainTitle } from "../breadcrumbs";

// Markdown rendering, loaded on demand.
//
// `marked` and `dompurify` together are 21 KB compressed — a quarter of everything the application
// downloads before it can draw anything — and until they arrive there is still something honest to
// show, because the source of a markdown document is text. So the text goes up immediately and the
// rendered form replaces it when the parser lands. Nothing waits on a parser to display a title.
//
// KaTeX loads the same way underneath, for the same reason, and is a further 78 KB — which is why
// it is only fetched for text that actually contains math.

type Renderer = {
  parse: (src: string) => string;
  parseInline: (src: string) => string;
  /** Registers the math extension once KaTeX is on hand. */
  use: (ext: unknown) => void;
  sanitize: (html: string) => string;
};

let renderer: Renderer | null = null;
let mathLoaded = false;
// One shared set of subscribers for both loads: either arriving means every mounted `Markdown`
// has something new to show, and re-rendering them is what makes the upgrade appear.
const waiters = new Set<() => void>();
const notify = () => { waiters.forEach((f) => f()); };

const SANITIZE_OPTIONS = {
  // KaTeX emits MathML, which the default profile strips.
  ADD_TAGS: ["math", "annotation", "semantics", "mrow", "mi", "mo", "mn", "msup", "mspace", "msqrt", "mfrac"],
  ADD_ATTR: ["target", "display", "xmlns"],
};

let rendererLoading = false;

/** Start fetching the parser without waiting for something to render.
 *
 *  Called from `main.tsx` once the application has mounted. Left to the first `Markdown` to mount,
 *  the fetch began only after the current view's own chunk had arrived and rendered — on the issue
 *  detail that was half a second late, and the description sat there as unparsed text for all of
 *  it. Deliberately not started before mount: it would then be competing for bandwidth with the
 *  bundle that has to arrive for anything at all to appear. */
export function preloadMarkdown(): void {
  loadRenderer();
}

function loadRenderer(): void {
  if (renderer || rendererLoading) return;
  rendererLoading = true;
  Promise.all([import("marked"), import("dompurify")])
    .then(([{ marked }, dompurify]) => {
      const purify = dompurify.default;
      renderer = {
        parse: (src) => marked.parse(src) as string,
        parseInline: (src) => marked.parseInline(src) as string,
        use: (ext) => marked.use(ext as Parameters<typeof marked.use>[0]),
        sanitize: (html) => purify.sanitize(html, SANITIZE_OPTIONS),
      };
      notify();
    })
    .catch(() => {
      // Leave the plain text in place. Unrendered markdown is readable; a blank panel is not.
      rendererLoading = false;
    });
}

let mathLoading = false;
function loadMath(): void {
  if (mathLoaded || mathLoading) return;
  mathLoading = true;
  Promise.all([
    import("marked-katex-extension"),
    // Side-effect import: KaTeX ships the layout rules and fonts its markup depends on.
    import("katex/dist/katex.min.css"),
  ])
    .then(([katexExtension]) => {
      // The extension attaches to `marked`, so it is useless until the renderer exists. Waiting
      // here rather than ordering the two loads keeps them concurrent.
      const attach = () => {
        if (!renderer) return false;
        renderer.use(katexExtension.default({ throwOnError: false }));
        mathLoaded = true;
        notify();
        return true;
      };
      if (!attach()) {
        const retry = () => { if (attach()) waiters.delete(retry); };
        waiters.add(retry);
      }
    })
    .catch(() => { /* text renders without math rather than not at all */ });
}

// Cheap pre-check for the delimiters `marked-katex-extension` recognises. A wrong guess is
// harmless — an unnecessary import, or math that stays plain until something else on the page
// triggers the load — so this errs against downloading 270 KB for prose that mentions a dollar.
const MATH_PATTERN = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\(|\\\[/;

/** Subscribe to whichever loads this text needs, and re-render as each arrives. */
function useRendered(needsMath: boolean): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    loadRenderer();
    if (needsMath) loadMath();
    if (renderer && (!needsMath || mathLoaded)) return;
    const wake = () => bump((n) => n + 1);
    waiters.add(wake);
    return () => { waiters.delete(wake); };
  }, [needsMath]);
  return renderer != null;
}

// `issues`, when passed, is used to render "#123" references as "#123 <title>" instead of a bare
// number — omit it where the referenced issue's title isn't worth the lookup (e.g. list rows,
// which already show the issue's own title next to its number).
//
// Memoised: parsing and sanitising is the most expensive thing a list row does, and the filter bar
// re-renders every row on each keystroke.
export const Markdown = memo(function Markdown({ text, inline = false, issues = [] }: { text: string; inline?: boolean; issues?: IssueIndexEntry[] }) {
  const ready = useRendered(MATH_PATTERN.test(text));

  if (!ready) {
    // The document's own source, as text. `plainTitle` drops the syntax that reads worst in a
    // one-line slot — link and image brackets, code ticks, emphasis markers — which is exactly the
    // case where the unrendered form would otherwise be conspicuous.
    return inline
      ? <span className="md md-inline">{plainTitle(text)}</span>
      : <div className="md md-plain">{text}</div>;
  }

  // Turn bare `#123` issue references into links, then parse markdown.
  const linked = linkifyIssueRefs(text, issues);
  const cleanHtml = renderer!.sanitize(inline ? renderer!.parseInline(linked) : renderer!.parse(linked));

  return inline
    ? <span className="md md-inline" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
    : <div className="md" dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
});
