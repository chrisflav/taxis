// Bare references in markdown text, turned into links: `#123` for an issue in this tracker,
// `PR#123` for a pull request on the repository the issue is about.
//
// Adding a kind of reference is adding an entry to `LINKIFIERS` — a pattern and a rule for turning
// a match into a link — and teaching `LinkContext` about whatever that rule resolves against. The
// scanning, the code-span exemption and the pass over prose are shared, so a new kind cannot
// disagree with the existing ones about where a reference may start or what counts as code.

import type { RepoRef } from "./types";

/** A reference as it was found in the text. */
export interface Ref {
  /** The reference exactly as written, e.g. `"PR#123"` — so the link keeps the author's casing. */
  text: string;
  /** The number it names. */
  num: number;
}

/** What references are resolved against. Every field is optional: a linkifier that cannot resolve
    a reference declines it, and the text stays as it was written. */
export interface LinkContext {
  /** Titles of the issues referred to, where they are known yet. */
  names?: Map<number, { title: string }>;
  /** The repository the text belongs to — the issue's own, or the nearest ancestor's. `null` once
      we know there is none; `undefined` while the answer is still on its way. */
  repo?: RepoRef | null;
}

/** Where a reference points, and what to show for it. */
export interface Link {
  href: string;
  /** Link text. Written into markdown, so square brackets are stripped from it. */
  text: string;
  /** Optional `title` attribute — for a reference whose target isn't obvious from its text. */
  title?: string;
}

/** One kind of bare reference. */
export interface Linkifier {
  /** Names the kind. Doubles as the capture-group name in the combined pattern, so it has to be a
      valid identifier and unique among the linkifiers. */
  kind: string;
  /** Pattern for one reference, as regular-expression source, matched case-insensitively and
      containing no capture groups of its own. It starts at the marker: the guard against matching
      mid-word is `BOUNDARY`, and is shared, so no linkifier has to restate it. Exactly one run of
      digits, which is the reference's number. */
  ref: string;
  /** Where the reference points, or `null` to leave the text alone — which is the right answer for
      a reference that cannot be resolved, and is what an unattached issue does with `PR#123`. */
  link: (ref: Ref, ctx: LinkContext) => Link | null;
}

/** Every reference has to start at a non-word character (or the start of the text).
 *
 *  This is what tells `#123` apart from markdown heading syntax (`# Heading` always has a space
 *  after the `#`, and `##` is excluded outright), and it is why `PR#123` is one reference rather
 *  than an issue reference with a stray `PR` in front of it: the `R` is a word character, so the
 *  issue pattern cannot start there. */
const BOUNDARY = "(^|[^\\w#])";

/** A reference to an issue in this tracker. Always links, titled or not: the title is a nicety and
    the number is the reference. */
const issueLinkifier: Linkifier = {
  kind: "issue",
  ref: "#\\d+\\b",
  link: ({ text, num }, ctx) => {
    const title = ctx.names?.get(num)?.title;
    return { href: `#/issues/${num}`, text: title ? `${text} ${title}` : text };
  },
};

/** A reference to a pull request on the repository the issue is about.
 *
 *  Declined — left as plain text — when there is no repository to resolve it against, and when the
 *  repository is not on GitHub: `/pull/<n>` is GitHub's spelling, and another forge's is not it
 *  (GitLab's merge requests, for one), so guessing would produce a link that goes nowhere. */
const prLinkifier: Linkifier = {
  kind: "pr",
  ref: "PR#\\d+\\b",
  link: ({ text, num }, ctx) => {
    const repo = ctx.repo;
    if (!repo || repo.host !== "github.com") return null;
    return {
      href: `https://github.com/${repo.owner}/${repo.name}/pull/${num}`,
      text,
      // The text says which pull request but not which repository, and on a child issue that
      // inherited its repository from an ancestor there is nothing else on the page that does.
      title: `${repo.owner}/${repo.name}#${num}`,
    };
  },
};

/** The registered linkifiers, in the order they are offered a match. */
export const LINKIFIERS: Linkifier[] = [issueLinkifier, prLinkifier];

/** One pass finds every kind of reference. Alternation rather than a pass per linkifier, so that
    a longer reference wins over a shorter one that is a suffix of it, and so that no linkifier
    ever runs over markdown a previous one has already generated. Which alternative matched is read
    off the named groups. */
const PATTERN = new RegExp(
  `${BOUNDARY}(?:${LINKIFIERS.map((l) => `(?<${l.kind}>${l.ref})`).join("|")})`,
  "gi",
);

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

/** The linkifier that matched, and the reference it matched, out of a `PATTERN` match. */
function matched(groups: Record<string, string | undefined>): [Linkifier, Ref] | null {
  for (const l of LINKIFIERS) {
    const text = groups[l.kind];
    if (text === undefined) continue;
    return [l, { text, num: Number(/\d+/.exec(text)![0]) }];
  }
  return null;
}

/** The references `text` contains, by linkifier kind — what a renderer needs looked up before it
    can resolve them. A handful of numbers, rather than the index of every issue in the tracker and
    the repository of every issue that has one. */
export function refsIn(text: string): Map<string, number[]> {
  const found = new Map<string, number[]>();
  overProse(text, (part) => {
    for (const m of part.matchAll(PATTERN)) {
      const hit = matched(m.groups ?? {});
      if (!hit) continue;
      const [{ kind }, ref] = hit;
      const nums = found.get(kind);
      if (!nums) found.set(kind, [ref.num]);
      else if (!nums.includes(ref.num)) nums.push(ref.num);
    }
    return part;
  });
  return found;
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

/** Square brackets in link text would close the markdown link being built around it. */
const linkText = (s: string) => s.replace(/[[\]]/g, "");

/** Turn the bare references in `text` into markdown links — `[#123 Some title](#/issues/123)`,
    `[PR#7](https://github.com/owner/repo/pull/7 "owner/repo#7")` — leaving code spans and fenced
    blocks alone, so code samples aren't rewritten.

    A reference nothing can resolve is left exactly as it was written: an issue reference still
    links while its title is on its way (and if the issue is gone or hidden, it keeps the bare
    number it had), and a `PR#123` on an issue with no repository anywhere above it stays text. */
export function linkify(text: string, ctx: LinkContext = {}): string {
  return overProse(text, (part) =>
    part.replace(PATTERN, (...args) => {
      const whole = args[0] as string;
      const pre = args[1] as string;
      const hit = matched(args[args.length - 1] as Record<string, string | undefined>);
      if (!hit) return whole;
      const link = hit[0].link(hit[1], ctx);
      if (!link) return whole;
      const title = link.title ? ` "${link.title.replace(/"/g, "")}"` : "";
      return `${pre}[${linkText(link.text)}](${link.href}${title})`;
    }));
}
