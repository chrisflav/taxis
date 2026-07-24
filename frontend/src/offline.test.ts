import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What is worth testing here is not the interface but the decisions underneath it: whether a write
// is sent, sent twice, sent as the wrong person, or kept aside. None of that is visible by looking
// at the screen, and all of it only happens on a connection that has already gone away.
//
// The module reads `localStorage` and installs its listeners at import time, so each test imports
// it fresh (`resetModules` + dynamic import) against a clean store. `fetch` is stubbed per test and
// its calls are the assertion: what the queue *did* is the whole subject.

type Offline = typeof import("./offline");
type Cache = typeof import("./cache");

interface Call { method: string; path: string; body: string | null }

/** A stub `fetch` that answers from `routes`, recording every call in order. A route may be a
    function, so a test can answer differently the second time the same path is asked for. */
function stubFetch(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  const impl = vi.fn((url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.replace(/^\/api/, "");
    const call: Call = { method, path, body: (init.body as string) ?? null };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    if (route === undefined) return Promise.reject(new TypeError("Failed to fetch"));
    const answer = typeof route === "function" ? (route as (c: Call) => unknown)(call) : route;
    const { status = 200, data = {} } = answer as { status?: number; data?: unknown };
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(data)),
    } as Response);
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

/** The queue drains asynchronously off events; this waits for it to settle rather than guessing. */
const settle = () => new Promise((r) => setTimeout(r, 0));

async function load(): Promise<{ offline: Offline; cache: Cache }> {
  vi.resetModules();
  const cache = await import("./cache");
  const offline = await import("./offline");
  // Every drain is gated on the page having loaded and on the session being known — both true in a
  // running application by the time anything is queued.
  window.dispatchEvent(new Event("load"));
  offline.setCurrentActor(1);
  // Naming the actor releases a queue restored from storage, so let that drain finish before the
  // test starts making assertions about what was sent.
  await settle();
  return { offline, cache };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queueing", () => {
  it("accepts issue and comment writes and refuses everything else", async () => {
    const { offline } = await load();
    expect(offline.queueWrite("POST", "/issues", "{}")).not.toBeNull();
    expect(offline.queueWrite("PATCH", "/issues/7", '{"title":"x"}')).not.toBeNull();
    expect(offline.queueWrite("DELETE", "/issues/7", null)).not.toBeNull();
    expect(offline.queueWrite("POST", "/issues/7/comments", '{"body":"hi"}')).not.toBeNull();
    // A request whose answer is the point is not something a stand-in can stand in for.
    expect(offline.queueWrite("POST", "/auth/dev-login", "{}")).toBeNull();
    expect(offline.queueWrite("POST", "/tokens", "{}")).toBeNull();
    expect(offline.queueWrite("POST", "/issues/7/artifacts", "{}")).toBeNull();
  });

  it("marks a patch's pending fields and folds it over the issue on screen", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"title":"local","state":"closed"}');
    const { queue } = offline.offlineSnapshot();
    expect(offline.pendingFieldsFor(7, queue)).toEqual(new Set(["title", "state"]));

    const server = { id: 7, title: "server", state: "open", updatedAt: 100 } as never;
    const shown = offline.applyPendingEdits(server, queue);
    expect(shown).toMatchObject({ title: "local", state: "closed" });
    // The baseline a collision is detected against belongs to the server's version, so the overlay
    // must not touch it.
    expect(shown.updatedAt).toBe(100);
  });

  it("leaves an issue with nothing queued identically alone", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"title":"local"}');
    const other = { id: 8, title: "untouched" } as never;
    expect(offline.applyPendingEdits(other, offline.offlineSnapshot().queue)).toBe(other);
  });

  it("survives a reload, and drops entries it cannot understand", async () => {
    const first = await load();
    first.offline.queueWrite("PATCH", "/issues/7", '{"title":"kept"}');
    expect(first.offline.offlineSnapshot().queue).toHaveLength(1);

    const stored: unknown[] = JSON.parse(localStorage.getItem("taxis:offline-queue:v2")!);
    localStorage.setItem("taxis:offline-queue:v2", JSON.stringify([...stored, { opId: "junk" }]));

    const second = await load();
    expect(second.offline.offlineSnapshot().queue).toHaveLength(1);
    expect(second.offline.offlineSnapshot().queue[0].path).toBe("/issues/7");
  });
});

describe("replay", () => {
  it("sends the queue in order and clears it", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"title":"a"}');
    offline.queueWrite("POST", "/issues/7/comments", '{"body":"b"}');

    const calls = stubFetch({
      "PATCH /issues/7": { data: { id: 7, updatedAt: 200 } },
      "POST /issues/7/comments": { data: { id: 1 } },
    });
    await offline.drainQueue();

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /issues/7", "POST /issues/7/comments",
    ]);
    expect(offline.offlineSnapshot().queue).toHaveLength(0);
  });

  it("checks a patch against the version it was written from, and keeps it aside when that moved",
    async () => {
      const { offline, cache } = await load();
      // The page the edit was made from had read the issue: that read is the baseline.
      cache.writeCached("/issues/7", { issue: { id: 7, updatedAt: 100 } });
      offline.queueWrite("PATCH", "/issues/7", '{"title":"mine"}');

      const calls = stubFetch({ "GET /issues/7": { data: { issue: { id: 7, updatedAt: 999 } } } });
      await offline.drainQueue();

      // Read, and then deliberately not written.
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
      const { conflicts, queue } = offline.offlineSnapshot();
      expect(queue).toHaveLength(0);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ issueId: 7, reason: "stale", local: { title: "mine" } });
    });

  it("applies a patch whose baseline still matches", async () => {
    const { offline, cache } = await load();
    cache.writeCached("/issues/7", { issue: { id: 7, updatedAt: 100 } });
    offline.queueWrite("PATCH", "/issues/7", '{"title":"mine"}');

    const calls = stubFetch({
      "GET /issues/7": { data: { issue: { id: 7, updatedAt: 100 } } },
      "PATCH /issues/7": { data: { id: 7, updatedAt: 101 } },
    });
    await offline.drainQueue();

    expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(offline.offlineSnapshot().conflicts).toHaveLength(0);
  });

  it("folds a second collision on the same issue into one local version", async () => {
    const { offline, cache } = await load();
    cache.writeCached("/issues/7", { issue: { id: 7, updatedAt: 100 } });
    offline.queueWrite("PATCH", "/issues/7", '{"title":"first","goal":"g"}');
    offline.queueWrite("PATCH", "/issues/7", '{"title":"second"}');

    stubFetch({ "GET /issues/7": { data: { issue: { id: 7, updatedAt: 999 } } } });
    await offline.drainQueue();

    const { conflicts } = offline.offlineSnapshot();
    expect(conflicts).toHaveLength(1);
    // Later writes win, exactly as they would have in order — and the earlier field is not lost.
    expect(conflicts[0].local).toEqual({ title: "second", goal: "g" });
  });

  it("treats a delete whose target is already gone as done", async () => {
    const { offline } = await load();
    offline.queueWrite("DELETE", "/issues/7", null);
    stubFetch({ "DELETE /issues/7": { status: 404, data: {} } });
    await offline.drainQueue();
    expect(offline.offlineSnapshot().queue).toHaveLength(0);
    expect(offline.offlineSnapshot().conflicts).toHaveLength(0);
  });

  it("keeps a refused write with what the server said rather than retrying it forever", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"state":"completed"}');
    stubFetch({ "PATCH /issues/7": { status: 409, data: { error: "checks are not passing" } } });
    await offline.drainQueue();

    const { conflicts, queue } = offline.offlineSnapshot();
    expect(queue).toHaveLength(0);
    expect(conflicts[0]).toMatchObject({ reason: "rejected", message: "checks are not passing" });
  });

  it("stops on an expired session and keeps the whole queue", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"title":"a"}');
    offline.queueWrite("PATCH", "/issues/8", '{"title":"b"}');
    const calls = stubFetch({ "PATCH /issues/7": { status: 401, data: {} } });
    await offline.drainQueue();

    expect(calls).toHaveLength(1);
    expect(offline.offlineSnapshot().queue).toHaveLength(2);
  });

  it("stops and keeps everything when nothing answers", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"title":"a"}');
    stubFetch({});
    await offline.drainQueue();
    expect(offline.offlineSnapshot().queue).toHaveLength(1);
    expect(offline.isOffline()).toBe(true);
  });
});

describe("whose work it is", () => {
  it("waits rather than sending a queue before the session is known", async () => {
    vi.resetModules();
    const offline = await import("./offline");
    window.dispatchEvent(new Event("load"));
    offline.queueWrite("PATCH", "/issues/7", '{"title":"a"}');
    const calls = stubFetch({ "PATCH /issues/7": { data: { id: 7 } } });

    await offline.drainQueue();
    expect(calls).toHaveLength(0);

    // Signed out is an answer, and still not one that can send anything.
    offline.setCurrentActor(null);
    await offline.drainQueue();
    expect(calls).toHaveLength(0);

    offline.setCurrentActor(1);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("does not replay one account's work under another's", async () => {
    const first = await load();
    first.offline.queueWrite("PATCH", "/issues/7", '{"title":"written by actor 1"}');

    // The tab closes and somebody else signs in on the same browser. Deliberately not via `load`:
    // the point is that actor 1 is never the current actor in this session.
    vi.resetModules();
    const offline = await import("./offline");
    window.dispatchEvent(new Event("load"));
    const calls = stubFetch({ "PATCH /issues/7": { data: { id: 7 } } });
    offline.setCurrentActor(2);
    await settle();

    expect(calls).toHaveLength(0);
    const { conflicts, queue } = offline.offlineSnapshot();
    expect(queue).toHaveLength(0);
    // Not sent — but not thrown away either. It is still somebody's work.
    expect(conflicts[0]).toMatchObject({ reason: "foreign", local: { title: "written by actor 1" } });
  });
});

describe("a write that may already have been sent", () => {
  it("holds back a creation queued from a mid-flight failure, and sends it on request", async () => {
    const { offline } = await load();
    const queued = offline.queueWrite("POST", "/issues", '{"title":"new"}', true)!;
    expect(offline.isOpHeld(queued.opId)).toBe(true);

    const calls = stubFetch({ "POST /issues": { data: { id: 42 } } });
    await offline.drainQueue();
    // Sending it again could file a second issue, and nothing here can tell whether it would.
    expect(calls).toHaveLength(0);
    expect(offline.offlineSnapshot().queue).toHaveLength(1);

    offline.confirmQueued(queued.opId);
    await settle();
    expect(calls.map((c) => c.path)).toEqual(["/issues"]);
    expect(offline.offlineSnapshot().queue).toHaveLength(0);
  });

  it("sends the rest of the queue past a held op", async () => {
    const { offline } = await load();
    offline.queueWrite("POST", "/issues/7/comments", '{"body":"maybe sent"}', true);
    offline.queueWrite("PATCH", "/issues/7", '{"title":"definitely not"}');

    const calls = stubFetch({
      "PATCH /issues/7": { data: { id: 7, updatedAt: 2 } },
      "POST /issues/7/comments": { data: { id: 1 } },
    });
    await offline.drainQueue();

    expect(calls.map((c) => c.method)).toEqual(["PATCH"]);
    expect(offline.offlineSnapshot().queue).toHaveLength(1);
  });

  it("replays an uncertain patch or delete without asking, since neither can duplicate", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"title":"a"}', true);
    offline.queueWrite("DELETE", "/issues/8", null, true);
    const calls = stubFetch({
      "PATCH /issues/7": { data: { id: 7 } },
      "DELETE /issues/8": { data: {} },
    });
    await offline.drainQueue();
    expect(calls).toHaveLength(2);
    expect(offline.offlineSnapshot().queue).toHaveLength(0);
  });
});

describe("discarding", () => {
  it("drops only the discarded op's own cache key, not its prefix neighbours", async () => {
    const { offline, cache } = await load();
    cache.writeCached("/issues/12", { issue: { id: 12, updatedAt: 1 } });
    cache.writeCached("/issues/120", { issue: { id: 120, updatedAt: 1 } });
    cache.writeCached("/issues/12/ancestors", []);

    const queued = offline.queueWrite("PATCH", "/issues/12", '{"title":"x"}')!;
    offline.discardQueued(queued.opId);

    expect(cache.peekCached("/issues/12")).toBeUndefined();
    // Offline these are the only copies in existence; a prefix match would have taken both.
    expect(cache.peekCached("/issues/120")).toBeDefined();
    expect(cache.peekCached("/issues/12/ancestors")).toBeDefined();
  });

  it("forgets a discarded conflict", async () => {
    const { offline } = await load();
    offline.queueWrite("PATCH", "/issues/7", '{"state":"completed"}');
    stubFetch({ "PATCH /issues/7": { status: 409, data: { error: "locked" } } });
    await offline.drainQueue();

    const [conflict] = offline.offlineSnapshot().conflicts;
    offline.discardConflict(conflict.opId);
    expect(offline.offlineSnapshot().conflicts).toHaveLength(0);
  });
});
