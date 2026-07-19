import DOMPurify from "dompurify";
import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";
import type { Issue } from "../types";
import { linkifyIssueRefs } from "../issueLinks";

// Configure marked with GitHub-flavoured markdown (built-in) and math via KaTeX
marked.use(markedKatex({ throwOnError: false }));

// `issues`, when passed, is used to render "#123" references as "#123 <title>" instead of a bare
// number — omit it where the referenced issue's title isn't worth the lookup (e.g. list rows,
// which already show the issue's own title next to its number).
export function Markdown({ text, inline = false, issues = [] }: { text: string; inline?: boolean; issues?: Issue[] }) {
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
}
