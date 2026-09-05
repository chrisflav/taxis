import { describe, expect, it } from "vitest";
import { containsMath, linkify, refsIn } from "./linkify";
import type { RepoRef } from "./types";

const repo: RepoRef = {
  host: "github.com",
  owner: "leanprover",
  name: "lean4",
  url: "https://github.com/leanprover/lean4",
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
  it("leaves it as text when no repository is known", () => {
    expect(linkify("fixed by PR#7")).toBe("fixed by PR#7");
    expect(linkify("fixed by PR#7", { repo: null })).toBe("fixed by PR#7");
  });

  it("leaves it as text on a forge that does not spell pull requests that way", () => {
    const gitlab: RepoRef = { host: "gitlab.com", owner: "g", name: "p", url: "https://gitlab.com/g/p" };
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
