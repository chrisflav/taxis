import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeReadFailure } from "./netError";

/**
 * Reading the tracker with no connection.
 *
 * Two things have to hold for that to work in the packaged app, and neither did at first:
 *
 *   - What was read survives the app being closed. On the web a cold load is somebody asking for a
 *     page; on a phone it is the system having reclaimed the WebView, and it happens constantly. An
 *     in-memory cache starts empty every launch, which offline means a connection error over a
 *     blank list for issues that have been read a dozen times.
 *   - A read that fails because *nothing answered* falls back to the last answer. A read that fails
 *     because the *server said no* does not — that is the server talking, and the reader must see
 *     it. Same rule the write queue uses, in the other direction.
 */

const SERVER = "https://taxis.example.org";
const SCOPE = `:${SERVER}`;

/** Import the cache as the packaged app connected to `SERVER` would, with fresh module state —
 *  which is also what a relaunch is, so it doubles as "close the app and open it again". */
async function relaunchPackaged() {
  vi.resetModules();
  (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  localStorage.setItem(
    "taxis.servers",
    JSON.stringify({ v: 2, servers: [{ url: SERVER, label: "T", token: null }], active: SERVER }),
  );
  return await import("./cache");
}

async function loadWeb() {
  vi.resetModules();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  return await import("./cache");
}

/** A `fetch` rejection is a `TypeError`; anything else is the server having answered. */
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const refused = () => Promise.reject(new Error("admin privileges required"));

beforeEach(() => localStorage.clear());

describe("what the app holds between launches", () => {
  it("keeps a response, and has it before the first request of the next launch", async () => {
    let cache = await relaunchPackaged();
    await cache.cachedGet("/issues/page?state=open", () => Promise.resolve({ issues: [{ id: 1 }] }));

    cache = await relaunchPackaged();
    expect(cache.peekCached("/issues/page?state=open")).toEqual({ issues: [{ id: 1 }] });
  });

  it("paints that response when the network is gone", async () => {
    let cache = await relaunchPackaged();
    await cache.cachedGet("/issues/1", () => Promise.resolve({ title: "Read me offline" }));

    cache = await relaunchPackaged();
    await expect(cache.cachedGet("/issues/1", offline)).resolves.toEqual({
      title: "Read me offline",
    });
  });

  it("still fails when there is nothing held — that is the honest answer", async () => {
    const cache = await relaunchPackaged();
    await expect(cache.cachedGet("/issues/99", offline)).rejects.toThrow("Failed to fetch");
  });

  it("does not hide what the server said, cached copy or not", async () => {
    const cache = await relaunchPackaged();
    await cache.cachedGet("/issues/2", () => Promise.resolve({ title: "old" }));
    // The server answering "no" is news, and outranks anything held locally.
    await expect(cache.cachedGet("/issues/2", refused)).rejects.toThrow("admin privileges required");
  });

  it("restores the write time, not the launch time — so age still decides revalidation", async () => {
    // An entry stored ten minutes ago, i.e. older than the reference-data max age.
    localStorage.setItem(
      `taxis:read:${SCOPE}|/labels`,
      JSON.stringify({ data: [{ id: 1, name: "bug" }], at: Date.now() - 10 * 60_000 }),
    );
    const cache = await relaunchPackaged();

    // On screen before anything is requested…
    expect(cache.peekCached("/labels")).toEqual([{ id: 1, name: "bug" }]);
    // …and revalidated anyway, because it is ten minutes old and not newly minted. Were hydration
    // to stamp entries with the launch time, this would silently serve stale reference data for
    // the whole session.
    const fetcher = vi.fn(() => Promise.resolve([{ id: 1, name: "renamed" }]));
    await cache.cachedGet("/labels", fetcher, 5 * 60_000);
    expect(fetcher).toHaveBeenCalled();
  });

  it("does not re-request something restored that is genuinely still fresh", async () => {
    localStorage.setItem(
      `taxis:read:${SCOPE}|/actors`,
      JSON.stringify({ data: [{ id: 1 }], at: Date.now() - 1_000 }),
    );
    const cache = await relaunchPackaged();

    const fetcher = vi.fn(() => Promise.resolve([{ id: 2 }]));
    await expect(cache.cachedGet("/actors", fetcher, 5 * 60_000)).resolves.toEqual([{ id: 1 }]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forgets what is invalidated, so it does not come back next launch", async () => {
    let cache = await relaunchPackaged();
    await cache.cachedGet("/issues/page?state=open", () => Promise.resolve({ issues: [] }));
    await cache.cachedGet("/labels", () => Promise.resolve([]));
    cache.invalidateCache("/issues");

    cache = await relaunchPackaged();
    expect(cache.peekCached("/issues/page?state=open")).toBeUndefined();
    expect(cache.peekCached("/labels")).toEqual([]);
  });

  it("scopes what it keeps to the server it came from", async () => {
    const cache = await relaunchPackaged();
    await cache.cachedGet("/issues/1", () => Promise.resolve({ title: "on this tracker" }));

    const keys = Object.keys(localStorage).filter((k) => k.startsWith("taxis:read:"));
    expect(keys).toEqual([`taxis:read:${SCOPE}|/issues/1`]);
  });

  it("refuses to spend the storage the unsent-work queue needs on one huge response", async () => {
    const cache = await relaunchPackaged();
    const huge = { blob: "x".repeat(300 * 1024) };
    await cache.cachedGet("/repo-graph", () => Promise.resolve(huge));
    // Held for this session, but not at the cost of the queue's room to persist.
    expect(cache.peekCached("/repo-graph")).toEqual(huge);
    expect(Object.keys(localStorage).some((k) => k.startsWith("taxis:read:"))).toBe(false);
  });
});

describe("a browser", () => {
  it("keeps nothing on disk: a page load there means fetch what this page needs", async () => {
    const cache = await loadWeb();
    await cache.cachedGet("/issues/1", () => Promise.resolve({ title: "x" }));
    expect(Object.keys(localStorage).some((k) => k.startsWith("taxis:read:"))).toBe(false);
  });

  it("still falls back to the last answer when nothing answers — that rule is not app-only", async () => {
    const cache = await loadWeb();
    await cache.cachedGet("/issues/1", () => Promise.resolve({ title: "still here" }));
    await expect(cache.cachedGet("/issues/1", offline)).resolves.toEqual({ title: "still here" });
  });
});

describe("what a failed read says on screen", () => {
  it("does not put a JavaScript class name in front of the reader", () => {
    const message = describeReadFailure(new TypeError("Failed to fetch"));
    expect(message).not.toMatch(/TypeError|fetch/i);
    // Both halves of why the screen is empty: no connection, and nothing held locally either.
    expect(message).toMatch(/no connection/i);
    expect(message).toMatch(/device/i);
  });

  it("passes the server's own sentence through, without an `Error:` bolted onto it", () => {
    expect(describeReadFailure(new Error("admin privileges required")))
      .toBe("admin privileges required");
    // The outdated-server explanation reaches the reader whole, which was the point of writing it.
    expect(describeReadFailure(new Error("this server does not have the paged issue list")))
      .toBe("this server does not have the paged issue list");
  });

  it("copes with something thrown that is not an Error at all", () => {
    expect(describeReadFailure("just a string")).toBe("just a string");
  });
});
