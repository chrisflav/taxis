import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueListRow } from "./types";

/**
 * The copy of the tracker on the device.
 *
 * Two things are being tested, and they fail differently. The **query** half has to answer a list
 * query the way the server would — same filters, same four orders, same cursors — because the feed
 * pages through the two interchangeably: a connection dropping mid-scroll means page four comes off
 * the device after page three came off the server, and if the orders disagree the reader silently
 * loses rows or sees them twice. So the cases here are mostly about the boundary: what a cursor
 * resumes after, and what falls on either side of it.
 *
 * The **storage** half has to survive the app being killed, keep one tracker's issues out of
 * another's, and go away with the tracker it belongs to.
 */

const SERVER = "https://taxis.example.org";
const OTHER = "https://other.example.org";

const row = (id: number, over: Partial<IssueListRow> = {}): IssueListRow => ({
  id,
  title: `Issue ${id}`,
  state: "open",
  locked: false,
  parent: null,
  deadline: null,
  updatedAt: 1_000 + id,
  labels: [],
  assignees: [],
  dependencies: [],
  artifactCount: 0,
  checkCount: 0,
  childCount: 0,
  ...over,
});

/** Import the mirror as the packaged app connected to `url` would, with fresh module state —
 *  which is what a relaunch is, so it doubles as "close the app and open it again". */
async function relaunch(url = SERVER) {
  vi.resetModules();
  (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  localStorage.setItem(
    "taxis.servers",
    JSON.stringify({ v: 2, servers: [{ url, label: "T", token: null }], active: url }),
  );
  return await import("./mirror");
}

async function loadWeb() {
  vi.resetModules();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  return await import("./mirror");
}

beforeEach(() => {
  localStorage.clear();
  // A fresh IndexedDB, which is what a device that has never run this app has.
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("which issues a query selects", () => {
  it("narrows by state, label, assignee and parent the way the server does", async () => {
    const { matches } = await relaunch();
    const r = row(1, { state: "closed", labels: [4, 7], assignees: [9], parent: 3 });

    expect(matches(r, { state: "closed" })).toBe(true);
    expect(matches(r, { state: "open" })).toBe(false);
    expect(matches(r, { label: 7 })).toBe(true);
    expect(matches(r, { label: 8 })).toBe(false);
    expect(matches(r, { assignee: 9 })).toBe(true);
    expect(matches(r, { assignee: 1 })).toBe(false);
    expect(matches(r, { parent: 3 })).toBe(true);
    expect(matches(r, { parent: 4 })).toBe(false);
    // Every filter has to hold at once, not any of them.
    expect(matches(r, { state: "closed", label: 7, assignee: 9 })).toBe(true);
    expect(matches(r, { state: "closed", label: 8, assignee: 9 })).toBe(false);
  });

  it("reads parent=none as the roots of the tree, which no issue id can express", async () => {
    const { matches } = await relaunch();
    expect(matches(row(1, { parent: null }), { parent: "none" })).toBe(true);
    expect(matches(row(2, { parent: 1 }), { parent: "none" })).toBe(false);
  });

  it("searches titles, ignoring case — and only titles, which is what a stored row carries", async () => {
    const { matches } = await relaunch();
    const r = row(1, { title: "Flaky CI on macOS" });
    expect(matches(r, { q: "flaky" })).toBe(true);
    expect(matches(r, { q: "MACOS" })).toBe(true);
    expect(matches(r, { q: "  ci  " })).toBe(true);
    expect(matches(r, { q: "windows" })).toBe(false);
  });
});

describe("the order rows come back in", () => {
  it("puts the most recently updated first, breaking ties by id — the default order", async () => {
    const { sortRows } = await relaunch();
    const rows = [
      row(1, { updatedAt: 50 }),
      row(2, { updatedAt: 90 }),
      row(3, { updatedAt: 90 }),
    ];
    expect(sortRows(rows, "updated").map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("orders titles case-insensitively, as COLLATE NOCASE does", async () => {
    const { sortRows } = await relaunch();
    const rows = [row(1, { title: "beta" }), row(2, { title: "Alpha" }), row(3, { title: "gamma" })];
    expect(sortRows(rows, "title").map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("puts issues with no deadline last, not first", async () => {
    const { sortRows } = await relaunch();
    const rows = [
      row(1, { deadline: null }),
      row(2, { deadline: 500 }),
      row(3, { deadline: 100 }),
    ];
    expect(sortRows(rows, "deadline").map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("orders by id descending", async () => {
    const { sortRows } = await relaunch();
    expect(sortRows([row(1), row(9), row(4)], "id").map((r) => r.id)).toEqual([9, 4, 1]);
  });
});

describe("paging the mirror the way the server pages", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));

  it("delivers every row exactly once across pages, in order", async () => {
    const { pageOf } = await relaunch();
    const rows = many(25);
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = pageOf(rows, { limit: 10, cursor });
      pages++;
      seen.push(...page.issues.map((r) => r.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
      expect(pages).toBeLessThan(10); // A cursor that does not advance would loop for ever.
    }
    expect(pages).toBe(3);
    // Newest first: ids 25 down to 1, each once.
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => 25 - i));
  });

  it("ends the walk on a short page, so a caller knows there is no more", async () => {
    const { pageOf } = await relaunch();
    expect(pageOf(many(4), { limit: 10 }).nextCursor).toBeNull();
  });

  it("counts the whole result set on the first page only, as the server does", async () => {
    const { pageOf } = await relaunch();
    const rows = [row(1), row(2, { state: "closed" }), row(3, { state: "completed" }), row(4)];
    const first = pageOf(rows, { limit: 2 });
    expect(first.total).toBe(4);
    expect(first.stateCounts).toEqual({ open: 2, closed: 1, completed: 1 });
    // The second page's count would be a second pass over an answer that cannot have changed.
    expect(pageOf(rows, { limit: 2, cursor: first.nextCursor! }).total).toBeNull();
  });

  it("counts what matches the filters, not what is stored", async () => {
    const { pageOf } = await relaunch();
    const rows = [row(1), row(2, { state: "closed" }), row(3, { state: "closed" })];
    expect(pageOf(rows, { state: "closed", limit: 10 }).total).toBe(2);
  });

  it("resumes each order from its own kind of cursor", async () => {
    const { pageOf } = await relaunch();
    const rows = many(6);
    expect(pageOf(rows, { limit: 2 }).nextCursor).toBe("u.1005.5");
    expect(pageOf(rows, { sort: "id", limit: 2 }).nextCursor).toBe("i.5");
    expect(pageOf(rows, { sort: "title", limit: 2 }).nextCursor).toBe("o.2");
  });

  it("resumes a tie on updatedAt by id, so neither row is dropped or repeated", async () => {
    const { pageOf } = await relaunch();
    // Three issues touched in the same second: the id is the only thing separating them.
    const rows = [
      row(1, { updatedAt: 900 }),
      row(2, { updatedAt: 900 }),
      row(3, { updatedAt: 900 }),
    ];
    const first = pageOf(rows, { limit: 2 });
    expect(first.issues.map((r) => r.id)).toEqual([3, 2]);
    expect(pageOf(rows, { limit: 2, cursor: first.nextCursor! }).issues.map((r) => r.id)).toEqual([1]);
  });

  it("ignores a cursor belonging to a different order rather than trusting it", async () => {
    const { pageOf } = await relaunch();
    const rows = many(4);
    // An "updated" cursor arriving with a sort=id query: start the order over, which is harmless,
    // rather than filter by a key that means nothing here.
    const page = pageOf(rows, { sort: "id", limit: 10, cursor: "u.1002.2" });
    expect(page.issues.map((r) => r.id)).toEqual([4, 3, 2, 1]);
  });

  it("ignores a cursor it cannot parse", async () => {
    const { decodeCursor } = await relaunch();
    expect(decodeCursor("nonsense")).toBeNull();
    expect(decodeCursor("u.x.2")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe("what survives the app being killed", () => {
  it("has the issues it stored on the next launch", async () => {
    let mirror = await relaunch();
    await mirror.putRows([row(1), row(2)]);

    mirror = await relaunch();
    const rows = await mirror.allRows();
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("answers a list query from what it stored, with no server at all", async () => {
    let mirror = await relaunch();
    await mirror.putRows([row(1, { state: "open" }), row(2, { state: "closed" }), row(3)]);

    mirror = await relaunch();
    const page = await mirror.mirrorPage({ state: "open", limit: 10 });
    expect(page!.issues.map((r) => r.id)).toEqual([3, 1]);
    expect(page!.total).toBe(2);
  });

  it("replaces a stored row rather than keeping both copies", async () => {
    const mirror = await relaunch();
    await mirror.putRows([row(1, { title: "before" })]);
    await mirror.putRows([row(1, { title: "after" })]);
    const rows = await mirror.allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("after");
  });

  it("says nothing rather than nothing-found when it holds no copy", async () => {
    const mirror = await relaunch();
    // The distinction the caller needs: "this tracker has no open issues" is an answer to show a
    // reader; "this device has no copy of the tracker" is not.
    expect(await mirror.mirrorPage({ limit: 10 })).toBeNull();
  });

  it("drops what a full walk did not find, which is the only way a deletion shows up", async () => {
    const mirror = await relaunch();
    await mirror.putRows([row(1), row(2), row(3)]);
    await mirror.retainOnly([1, 3]);
    expect((await mirror.allRows()).map((r) => r.id).sort()).toEqual([1, 3]);
    expect(await mirror.storedCount()).toBe(2);
  });

  it("keeps one tracker's issues out of another's", async () => {
    let mirror = await relaunch(SERVER);
    await mirror.putRows([row(1), row(2)]);

    mirror = await relaunch(OTHER);
    await mirror.putRows([row(9)]);
    expect((await mirror.allRows()).map((r) => r.id)).toEqual([9]);

    mirror = await relaunch(SERVER);
    expect((await mirror.allRows()).map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("remembers where the last sync got to", async () => {
    let mirror = await relaunch();
    await mirror.writeMeta({
      scope: `:${SERVER}`,
      actorId: 7,
      highUpdatedAt: 1_700,
      highId: 42,
      count: 3,
      complete: true,
      syncedAt: 123,
    });

    mirror = await relaunch();
    expect(await mirror.readMeta()).toMatchObject({ actorId: 7, highUpdatedAt: 1_700, count: 3 });
  });

  it("takes a tracker's copy with it when the tracker is forgotten", async () => {
    const mirror = await relaunch();
    await mirror.putRows([row(1), row(2)]);
    await mirror.writeMeta({
      scope: `:${SERVER}`, actorId: null, highUpdatedAt: 1, highId: 1, count: 2,
      complete: true, syncedAt: 1,
    });

    await mirror.forgetScope(`:${SERVER}`);
    expect(await mirror.allRows()).toEqual([]);
    expect(await mirror.readMeta()).toBeNull();
  });
});

describe("the web build", () => {
  it("keeps no copy at all — the tracker serves the page, so there is no launch without it", async () => {
    const mirror = await loadWeb();
    expect(mirror.mirrorAvailable).toBe(false);
    await mirror.putRows([row(1)]);
    expect(await mirror.allRows()).toEqual([]);
    expect(await mirror.mirrorPage({ limit: 10 })).toBeNull();
  });
});
