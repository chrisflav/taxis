import { describe, expect, it } from "vitest";
import { containsMath, linkify, refsIn } from "./linkify";
import type { RepoRef } from "./types";

const repo: RepoRef = {
  host: "github.com",
  owner: "leanprover",
  name: "lean4",
};

const names = new Map([[12, { title: "Fix the parser" }]]);

describe("issue references", () => {
  it("links a bare reference and names it where the title is known", () => {
    expect(linkify("see #12", { names })).toBe("see [#12 Fix the parser](#/issues/12)");
  });

  it("links one whose title is not known yet", () => {
    expect(linkify("see #99")).toBe("see [#99](#/issues/99)");
  });

  // `# Heading` is markdown, and `##123` is not a reference anybody wrote deliberately.
  it("leaves heading syntax alone", () => {
    expect(linkify("# Heading\n\n## 2 things")).toBe("# Heading\n\n## 2 things");
  });

  it("leaves code alone", () => {
    expect(linkify("`#12` and\n```\n#12\n```")).toBe("`#12` and\n```\n#12\n```");
  });

  // A blank line in a title ended the whole link and dropped what followed into the surrounding
  // document as markdown of its own — a heading, a rule, a quote, in every document that merely
  // mentioned the issue. Inherited from the code this replaced; closed here because this is now
  // the one place every reference kind writes its text.
  it("cannot be broken out of by a blank line in a title", () => {
    const hostile = new Map([[12, { title: "T\n\n# Heading" }]]);
    expect(linkify("see #12", { names: hostile })).toBe("see [#12 T # Heading](#/issues/12)");
  });

  it("leaves the spacing of an ordinary title alone", () => {
    const spaced = new Map([[12, { title: "Fix the parser" }]]);
    expect(linkify("#12", { names: spaced })).toBe("[#12 Fix the parser](#/issues/12)");
  });

  it("strips brackets out of a title, which would close the link", () => {
    const bracketed = new Map([[12, { title: "[wip] parser" }]]);
    expect(linkify("#12", { names: bracketed })).toBe("[#12 wip parser](#/issues/12)");
  });
});

describe("pull-request references", () => {
  // The `title` is not decoration: on an issue that inherited its repository from an ancestor,
  // nothing else on the page says which repository `PR#7` is in.
  it("links to the repository the issue is about, saying which one", () => {
    expect(linkify("fixed by PR#7", { repo })).toBe(
      'fixed by [PR#7](https://github.com/leanprover/lean4/pull/7 "leanprover/lean4#7")');
  });

  it("keeps the author's casing", () => {
    expect(linkify("pr#7", { repo })).toContain("[pr#7]");
  });

  // The reference is real, but nothing here can say where it points, and a link that guesses is
  // worse than the text somebody wrote.
  // A repository name is whatever somebody typed into an artifact payload, and `RepoRef.parse?`
  // takes nearly any path segment. Unescaped, a `)` in one closed the link and spilled the rest
  // of the name into the reader's prose as markup — on every issue under the one it was attached
  // to. The link is wrong either way; it must not be able to stop being a link.
  it("cannot be broken out of by a repository name", () => {
    const hostile: RepoRef = {
      host: "github.com",
      owner: "o)<img src=x onerror=alert(1)>**pwned**z",
      name: "r",
    };
    const out = linkify("fixed by PR#7", { repo: hostile });
    // One link, and everything the name contains is inside its destination.
    expect(out).toBe(
      "fixed by [PR#7](https://github.com/o%29%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E**pwned**z/r/pull/7"
      + ' "o)<img src=x onerror=alert(1)>**pwned**z/r#7")');
    // The destination in particular carries nothing that could end it early. (The title may:
    // it is delimited by quotes, and only a quote closes it.)
    const destination = /\]\((\S*)/.exec(out)![1];
    expect(destination).not.toMatch(/[()\s<>"]/);
  });

  // A blank line is the other way out, and the subtler one: it does not close the title, it ends
  // the whole inline link — quotes and all — so everything after it lands in the reader's prose as
  // markdown of its own. `RepoRef.parse?` trims only the ends of a URL, so a newline in the middle
  // of a repository name reaches here intact.
  it("cannot be broken out of by a blank line in the title", () => {
    const hostile: RepoRef = { host: "github.com", owner: "a\n\n![](https:", name: "evil.example" };
    const out = linkify("fixed by PR#7", { repo: hostile });
    expect(out).toBe(
      "fixed by [PR#7](https://github.com/a%0A%0A!%5B%5D%28https%3A/evil.example/pull/7"
      + ' "a ![](https:/evil.example#7")');
    // One line, so there is no blank line left for the link to end at.
    expect(out).not.toMatch(/\n/);
  });

  it("encodes a space, which would otherwise end the destination", () => {
    const spaced: RepoRef = { host: "github.com", owner: "o x", name: "r" };
    expect(linkify("PR#7", { repo: spaced })).toContain("https://github.com/o%20x/r/pull/7");
  });

  // The title sits between quotes, so only a quote can end it early.
  it("drops a quote out of the title", () => {
    const quoted: RepoRef = { host: "github.com", owner: 'o"x', name: "r" };
    expect(linkify("PR#7", { repo: quoted })).toContain('"ox/r#7")');
  });

  it("leaves it as text when no repository is known", () => {
    expect(linkify("fixed by PR#7")).toBe("fixed by PR#7");
    expect(linkify("fixed by PR#7", { repo: null })).toBe("fixed by PR#7");
  });

  it("leaves it as text on a forge that does not spell pull requests that way", () => {
    const gitlab: RepoRef = { host: "gitlab.com", owner: "g", name: "p" };
    expect(linkify("fixed by PR#7", { repo: gitlab })).toBe("fixed by PR#7");
  });

  // The whole reason `#123` requires a non-word character in front of it.
  it("is one reference rather than an issue reference with PR in front of it", () => {
    expect(linkify("PR#7", { names, repo })).toBe(
      '[PR#7](https://github.com/leanprover/lean4/pull/7 "leanprover/lean4#7")');
    expect([...refsIn("PR#7").keys()]).toEqual(["pr"]);
  });

  it("does not link one written inside a word", () => {
    expect(linkify("SUPR#7", { repo })).toBe("SUPR#7");
  });
});

describe("refsIn", () => {
  it("collects each kind separately, without duplicates", () => {
    const refs = refsIn("#12 and PR#7 and #12 again, plus PR#8");
    expect(refs.get("issue")).toEqual([12]);
    expect(refs.get("pr")).toEqual([7, 8]);
  });

  it("ignores references inside code, which is what the renderer does with them", () => {
    expect(refsIn("`#12`\n```\nPR#7\n```").size).toBe(0);
  });

  it("finds nothing in ordinary prose, so nothing is fetched for it", () => {
    expect(refsIn("A title with no references in it").size).toBe(0);
  });
});

describe("containsMath", () => {
  it("sees real math", () => {
    expect(containsMath("the bound $x^2$ holds")).toBe(true);
  });

  // Loading KaTeX to typeset a shell variable is the failure this guards against.
  it("does not see shell variables in code spans", () => {
    expect(containsMath("`$XDG_CONFIG_HOME` and `$PATH`")).toBe(false);
  });
});
