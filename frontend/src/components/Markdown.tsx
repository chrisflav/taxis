import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

// GitHub-flavoured markdown + `$…$` / `$$…$$` math via KaTeX. Raw HTML is not enabled, so user
// content cannot inject markup — only markdown/math is interpreted. Invalid LaTeX is shown inline
// in red rather than throwing.
const remarkPlugins = [remarkGfm, remarkMath, remarkBreaks];
const rehypePlugins: any = [[rehypeKatex, { throwOnError: false, strict: false }]];

// Inline variant (titles): unwrap the paragraph and never emit nested links, so a title can sit
// inside a table cell or an existing <a> without producing block elements or invalid nesting.
const inlineComponents = {
  p: (props: { children?: ReactNode }) => <>{props.children}</>,
  a: (props: { children?: ReactNode }) => <span>{props.children}</span>,
};

export function Markdown({ text, inline = false }: { text: string; inline?: boolean }) {
  const content = (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={inline ? inlineComponents : undefined}
    >
      {text}
    </ReactMarkdown>
  );
  return inline ? <span className="md md-inline">{content}</span> : <div className="md">{content}</div>;
}
