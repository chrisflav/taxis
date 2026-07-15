import DOMPurify from "dompurify";
import { marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";

// Configure marked with GitHub-flavoured markdown (built-in) and math via KaTeX
marked.use(markedKatex({ throwOnError: false }));

export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  // Parse markdown
  const rawHtml = inline ? marked.parseInline(text) : marked.parse(text);

  // Sanitize the output HTML. We allow MathML tags which KaTeX generates.
  const cleanHtml = DOMPurify.sanitize(rawHtml as string, {
    ADD_TAGS: ['math', 'annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'mspace', 'msqrt', 'mfrac'],
    ADD_ATTR: ['target', 'display', 'xmlns'],
  });

  return inline
    ? <span className="md md-inline" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
    : <div className="md" dangerouslySetInnerHTML={{ __html: cleanHtml }} />;
}
