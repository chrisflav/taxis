// Bare `#123` issue references in markdown text.
//
// Deliberately requires the `#` to be preceded by a non-word character (or the start of the
// string) and followed immediately by digits — this is what tells it apart from markdown heading
// syntax (`# Heading` always has a space after the `#`). Fenced code blocks and inline code spans
// are left alone so code samples aren't rewritten.
const REF = /(^|[^\w#])#(\d+)\b/g;

/** Apply `f` to the parts of `text` that are not code, leaving the code parts untouched. */
function overProse(text: string, f: (part: string) => string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part; // fenced code block
      return part
        .split(/(`[^`]*`)/g)
        .map((sp, j) => (j % 2 === 1 ? sp : f(sp))) // inline code span
        .join("");
    })
    .join("");
}

/** The issue numbers `text` refers to. What a renderer needs looked up before it can name them —
    a handful of ids, rather than the index of every issue this used to be handed. */
export function issueRefIds(text: string): number[] {
  const ids = new Set<number>();
  overProse(text, (part) => {
    for (const m of part.matchAll(REF)) ids.add(Number(m[2]));
    return part;
  });
  return [...ids];
}

// The delimiters `marked-katex-extension` recognises. Only ever tested against *prose*: a tracker
// for a software project is full of `$XDG_CONFIG_HOME` and `$PATH` in code spans, and a pair of
// those on one line looks exactly like `$x^2$` to this pattern. Getting it wrong is not a cosmetic
// matter — it downloads KaTeX, which is 71 KB compressed and eleven seconds on a 50 kbit/s link,
// to typeset a shell variable.
const MATH = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\\\(|\\\[/;

/** Whether `text` contains something worth loading a maths typesetter for, ignoring code. */
export function containsMath(text: string): boolean {
  let found = false;
  overProse(text, (part) => {
    if (!found && MATH.test(part)) found = true;
    return part;
  });
  return found;
}

/** Turn bare `#123` references into markdown links: `[#123 Some title](#/issues/123)` where the
    title is known, and a plain `[#123](#/issues/123)` where it is not — which is what shows while
    the names are still on their way, and what stays if the issue is gone or not visible. */
export function linkifyIssueRefs(text: string, names?: Map<number, { title: string }>): string {
  const linkText = (num: string) => {
    const title = names?.get(Number(num))?.title;
    // Square brackets in the title would break the markdown link syntax being built here.
    return title ? `#${num} ${title.replace(/[[\]]/g, "")}` : `#${num}`;
  };
  return overProse(text, (part) =>
    part.replace(REF, (_m, pre, num) => `${pre}[${linkText(num)}](#/issues/${num})`));
}
