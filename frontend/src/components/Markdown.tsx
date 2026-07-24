import { memo, useEffect, useMemo, useState } from "react";
import { containsMath, issueRefIds, linkifyIssueRefs } from "../issueLinks";
import { plainTitle } from "../breadcrumbs";
import { useIssueNames } from "../issueNames";

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

/** Run `fn` once the page has fired its `load` event, and never a moment before it.
 *
 *  "Never before" is the whole point, and it is subtle. Every import in this file is a module
 *  fetch, and Firefox counts a module fetch that is *in flight when the page would otherwise fire
 *  `load`* against the load event: the tab keeps saying it is loading until that fetch resolves.
 *  Start `import("marked")` a second before load on a link where marked takes forty seconds to
 *  arrive, and the browser sits on the load event — and its throbber — for those forty seconds,
 *  over a page that has been finished and readable the whole time. (Chromium does not do this,
 *  which is why it only showed up in one browser.)
 *
 *  So this waits for `load` and then starts the fetch strictly after it, where it cannot be
 *  counted against it. There is deliberately no timeout fallback: an earlier version fell back to
 *  fetching after five seconds if `load` had not fired, which is exactly the thing that must not
 *  happen — it started the import *before* load and pinned the event open. If `load` genuinely
 *  never fires, the parser genuinely never loads, and the text stays as its own readable source,
 *  which is the fallback the rest of this file is built around anyway. */
function afterPageLoad(fn: () => void): void {
  if (document.readyState === "complete") fn();
  else window.addEventListener("load", fn, { once: true });
}

/** Start fetching the parser without waiting for something to render.
 *
 *  Called from `main.tsx` once the application has mounted. Left to the first `Markdown` to mount,
 *  the fetch began only after the current view's own chunk had arrived and rendered — on the issue
 *  detail that was half a second late, and the description sat there as unparsed text for all of
 *  it. Deliberately not started before mount: it would then be competing for bandwidth with the
 *  bundle that has to arrive for anything at all to appear. */
export function preloadMarkdown(): void {
  afterPageLoad(loadRenderer);
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

/** Subscribe to whichever loads this text needs, and re-render as each arrives. */
function useRendered(needsMath: boolean): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    afterPageLoad(loadRenderer);
    if (needsMath) afterPageLoad(loadMath);
    if (renderer && (!needsMath || mathLoaded)) return;
    const wake = () => bump((n) => n + 1);
    waiters.add(wake);
    return () => { waiters.delete(wake); };
  }, [needsMath]);
  return renderer != null;
}

// "#123" references are rendered as "#123 <title>" once the title is known. Which issues those are
// is read out of the text itself, and their names are asked for by id — a page's whole prose costs
// one small request, where this used to be handed an index of every issue in the tracker.
//
// Memoised: parsing and sanitising is the most expensive thing a list row does, and the filter bar
// re-renders every row on each keystroke.
export const Markdown = memo(function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  const ready = useRendered(containsMath(text));
  // Nothing is fetched for text with no references in it, which is nearly every title.
  const refs = useMemo(() => issueRefIds(text), [text]);
  const names = useIssueNames(refs);

  if (!ready) {
    // The document's own source, as text. `plainTitle` drops the syntax that reads worst in a
    // one-line slot — link and image brackets, code ticks, emphasis markers — which is exactly the
    // case where the unrendered form would otherwise be conspicuous.
    return inline
      ? <span className="md md-inline">{plainTitle(text)}</span>
      : <div className="md md-plain">{text}</div>;
  }

  // Turn bare `#123` issue references into links, then parse markdown.
  const linked = linkifyIssueRefs(text, names);
  const cleanHtml = renderer!.sanitize(inline ? renderer!.parseInline(linked) : renderer!.parse(linked));

  return inline
    ? <span className="md md-inline" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
    : <div className="md" dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
});
