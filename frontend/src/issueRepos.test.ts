import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What an issue is about, across a write that changes the answer.
 *
 * The interesting case is not the steady state — it is a write landing while the *first* request
 * for an id is still in flight, which is exactly what happens when somebody attaches a repository
 * to an issue whose prose is on screen and already asking. Both halves of that were wrong once:
 * the store held its answer past the invalidation that dropped the response it came from, and then
 * — with the answer discarded — the re-request was still handed the pre-write request, because the
 * shared cache dedupes on the path and the path had not changed.
 *
 * Driven through the real modules rather than a mock of them: the bug lived in how these three
 * fit together, so testing them apart would have missed it. Preact, because that is what ships.
 */

let fetches = 0;
let hasRepo = false;
/** Long enough that a write can be timed inside it, short enough not to pad the suite. */
const FETCH_MS = 40;

vi.stubGlobal("fetch", () => new Promise((res) => {
  fetches++;
  const repo = hasRepo ? { host: "github.com", owner: "o", name: "r" } : null;
  setTimeout(() => res(new Response(JSON.stringify([{ issue: 900, repo }]),
    { status: 200, headers: { "Content-Type": "application/json" } })), FETCH_MS);
}));

beforeEach(() => { fetches = 0; hasRepo = false; vi.resetModules(); });
afterEach(() => { document.body.innerHTML = ""; });

/** Mount something that asks about issue 900, attach a repository `writeAt` ms later, and report
    what the component is left showing. */
async function probe(writeAt: number) {
  const { render, h } = await import("preact");
  const { useIssueRepo } = await import("./issueRepos");
  const { invalidateCache } = await import("./cache");
  let last: unknown;
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(h(() => { last = useIssueRepo(900); return null; }, {}), host);
  await new Promise((r) => setTimeout(r, writeAt));
  hasRepo = true;
  // What `api` does after any write that touches an issue, `addArtifact` included.
  invalidateCache("/issues");
  await new Promise((r) => setTimeout(r, FETCH_MS * 5));
  return { last, fetches };
}

describe("the repository an issue is about", () => {
  it("is learned once, and asked for once", async () => {
    const { render, h } = await import("preact");
    const { useIssueRepo } = await import("./issueRepos");
    const host = document.createElement("div");
    document.body.appendChild(host);
    hasRepo = true;
    render(h(() => { useIssueRepo(900); useIssueRepo(900); return null; }, {}), host);
    await new Promise((r) => setTimeout(r, FETCH_MS * 4));
    expect(fetches).toBe(1);
  });

  // Attaching a repository is precisely the write that should make a `PR#123` under it start
  // linking, and it must not matter whether the first request had come back yet.
  it("catches up with a write that lands while the first request is in flight", async () => {
    const { last } = await probe(FETCH_MS / 2);
    expect(last).toMatchObject({ owner: "o", name: "r" });
  });

  it("catches up with a write that lands after it", async () => {
    const { last } = await probe(FETCH_MS * 2);
    expect(last).toMatchObject({ owner: "o", name: "r" });
  });

  it("ignores an invalidation of something else", async () => {
    const { render, h } = await import("preact");
    const { useIssueRepo } = await import("./issueRepos");
    const { invalidateCache } = await import("./cache");
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(() => { useIssueRepo(900); return null; }, {}), host);
    await new Promise((r) => setTimeout(r, FETCH_MS * 3));
    invalidateCache("/labels");
    await new Promise((r) => setTimeout(r, FETCH_MS * 3));
    expect(fetches).toBe(1);
  });
});
