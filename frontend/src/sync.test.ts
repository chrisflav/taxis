import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangesPage, IssueListRow, IssuePage } from "./types";

/**
 * Keeping the copy true.
 *
 * The tracker is *followed*, not re-read: the first sync walks the issue list, and every one after
 * it asks `/api/changes` what moved. Most of what follows is about the seams of that arrangement —
 * the join between the first read and the first follow, a cursor the server can no longer answer,
 * an account change that invalidates the premise — because those are where "one request" turns
 * from an optimisation into missing data.
 */

const SERVER = "https://taxis.example.org";

const row = (id: number, updatedAt: number, over: Partial<IssueListRow> = {}): IssueListRow => ({
  id,
  title: `Issue ${id}`,
  state: "open",
  locked: false,
  parent: null,
  deadline: null,
  updatedAt,
  labels: [],
  assignees: [],
  dependencies: [],
  artifactCount: 0,
  checkCount: 0,
  childCount: 0,
  ...over,
});

/**
 * A taxis with a change log, behaving as the Lean one does: `/issues/page` walks
 * `updated_at DESC, id DESC` behind an opaque cursor, and `/changes` coalesces the log window to
 * one entry per issue, resolving each to its current row or to null when it is gone.
 */
function fakeTaxis(initial: IssueListRow[], pageSize = 10) {
  let rows = initial.slice();
  let seq = 0;
  let log: { seq: number; id: number }[] = [];
  const calls = { page: 0, changes: 0, head: 0 };
  /** Whatever a test does to the tracker goes through here, so the log is written like the real
      one — by the write, not by the test remembering to. */
  const record = (id: number) => { seq += 1; log.push({ seq, id }); };

  const api = {
    calls,
    upsert(r: IssueListRow) {
      rows = rows.filter((x) => x.id !== r.id).concat([r]);
      record(r.id);
    },
    remove(id: number) {
      rows = rows.filter((x) => x.id !== id);
      record(id);
    },
    /** Drop log rows, as retention does on the server: cursors below the oldest kept get `reset`. */
    prune(keep: number) { log = log.slice(-keep); },
    /** Seed without recording, for the state a tracker was already in. */
    seed(rs: IssueListRow[]) { rows = rows.concat(rs); },

    changesHead(): Promise<ChangesPage> {
      calls.head += 1;
      return Promise.resolve({ changes: [], upTo: seq, reset: false, more: false });
    },

    changes(since: number, limit: number): Promise<ChangesPage> {
      calls.changes += 1;
      const minSeq = log.length ? log[0].seq : 0;
      if (minSeq > 0 && since < minSeq - 1) {
        return Promise.resolve({ changes: [], upTo: seq, reset: true, more: false });
      }
      const window = log.filter((e) => e.seq > since);
      const taken = window.slice(0, limit);
      const more = window.length > limit;
      const upTo = taken.length ? taken[taken.length - 1].seq : seq;
      const seen = new Set<number>();
      const changes = [];
      for (const e of taken) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        changes.push({ seq: e.seq, id: e.id, issue: rows.find((r) => r.id === e.id) ?? null });
      }
      return Promise.resolve({ changes, upTo, reset: false, more });
    },

    issuePage(query: { cursor?: string }): Promise<IssuePage> {
      calls.page += 1;
      const all = rows.slice().sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
      let remaining = all;
      if (query.cursor) {
        const [, u, i] = query.cursor.split(".");
        remaining = all.filter((r) => r.updatedAt < Number(u) || (r.updatedAt === Number(u) && r.id < Number(i)));
      }
      const issues = remaining.slice(0, pageSize);
      const last = issues[issues.length - 1];
      return Promise.resolve({
        issues,
        nextCursor: issues.length < pageSize || !last ? null : `u.${last.updatedAt}.${last.id}`,
        total: query.cursor ? null : all.length,
        stateCounts: null,
      });
    },
  };
  return api;
}

type Taxis = ReturnType<typeof fakeTaxis>;

/** Every `EventSource` the app opened, so a test can act as the server pushing to it. */
const streams: { url: string; handlers: Record<string, (() => void)[]>; onopen?: () => void; onerror?: () => void }[] = [];

class FakeEventSource {
  handlers: Record<string, (() => void)[]> = {};
  onopen?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    streams.push(this as never);
  }
  addEventListener(name: string, fn: () => void) {
    (this.handlers[name] ??= []).push(fn);
  }
  close() { /* nothing to tear down */ }
}

/** Start the app, packaged and connected to `SERVER`, talking to `taxis`. Fresh module state, so
 *  this is also what relaunching the app is — with whatever was stored last time still on disk. */
async function launch(taxis: Taxis) {
  vi.resetModules();
  (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  localStorage.setItem(
    "taxis.servers",
    JSON.stringify({ v: 2, servers: [{ url: SERVER, label: "T", token: null }], active: SERVER }),
  );
  vi.doMock("./api", () => ({
    api: {
      issuePage: taxis.issuePage,
      changesHead: taxis.changesHead,
      changes: taxis.changes,
    },
  }));
  const mirror = await import("./mirror");
  const sync = await import("./sync");
  return { mirror, sync };
}

async function signIn(sync: { setSyncActor: (id: number | null) => void; syncNow: (f?: boolean) => Promise<void> }, id: number) {
  sync.setSyncActor(id);
  await sync.syncNow(true);
}

const ids = (rows: IssueListRow[]) => rows.map((r) => r.id).sort((a, b) => a - b);
const titleOf = (rows: IssueListRow[], id: number) => rows.find((r) => r.id === id)?.title;

beforeEach(() => {
  localStorage.clear();
  streams.length = 0;
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});

describe("the first read", () => {
  it("walks the issue list and stores every issue", async () => {
    const taxis = fakeTaxis(Array.from({ length: 25 }, (_, i) => row(i + 1, 1_000 + i)));
    const { mirror, sync } = await launch(taxis);
    await signIn(sync, 1);

    expect(ids(await mirror.allRows())).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(taxis.calls.page).toBeGreaterThan(1); // Paged, not read in one response.
    expect(sync.syncSnapshot()).toMatchObject({ stored: 25, complete: true, syncing: false });
  });

  it("records a cursor to follow from", async () => {
    const taxis = fakeTaxis([row(1, 500)]);
    const { mirror, sync } = await launch(taxis);
    await signIn(sync, 1);
    expect(await mirror.readMeta()).toMatchObject({ actorId: 1, cursor: expect.any(Number) });
  });

  it("does nothing until it knows who is asking", async () => {
    const taxis = fakeTaxis([row(1, 500)]);
    const { sync } = await launch(taxis);
    // Visibility is per actor, so a read before the session lands mirrors the wrong tracker.
    await sync.syncNow(true);
    expect(taxis.calls.page).toBe(0);
  });

  it("takes its cursor before walking, so a change made during the walk is not lost", async () => {
    // The join between reading and following, and the only place a gap could hide. Issue 1 is
    // edited after the first page has gone out — it moves to a position the walk has passed, so
    // that walk will never deliver it.
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i));
    const taxis = fakeTaxis(rows);
    const walking = {
      ...taxis,
      issuePage(query: { cursor?: string }) {
        const answer = taxis.issuePage(query);
        if (taxis.calls.page === 1) taxis.upsert(row(1, 9_999, { title: "Edited mid-read" }));
        return answer;
      },
    };
    let app = await launch(walking as Taxis);
    await signIn(app.sync, 1);
    expect(titleOf(await app.mirror.allRows(), 1)).not.toBe("Edited mid-read");

    // The cursor was taken before the walk began, so the edit is still ahead of it.
    app = await launch(taxis);
    await signIn(app.sync, 1);
    expect(titleOf(await app.mirror.allRows(), 1)).toBe("Edited mid-read");
  });
});

describe("every sync after that", () => {
  it("asks what changed instead of reading the tracker again", async () => {
    const taxis = fakeTaxis(Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i)));
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    taxis.upsert(row(30, 5_000, { title: "Renamed" }));
    app = await launch(taxis);
    taxis.calls.page = 0;
    taxis.calls.changes = 0;
    await signIn(app.sync, 1);

    expect(taxis.calls.changes).toBe(1);
    expect(taxis.calls.page).toBe(0);
    expect(titleOf(await app.mirror.allRows(), 30)).toBe("Renamed");
    expect(ids(await app.mirror.allRows())).toHaveLength(30);
  });

  it("removes an issue the feed says is gone, without re-reading anything", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200), row(3, 300)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);
    expect(ids(await app.mirror.allRows())).toEqual([1, 2, 3]);

    taxis.remove(2);
    app = await launch(taxis);
    taxis.calls.page = 0;
    await signIn(app.sync, 1);

    expect(ids(await app.mirror.allRows())).toEqual([1, 3]);
    expect(taxis.calls.page).toBe(0);
  });

  it("asks for nothing when nothing moved, and moves its cursor on anyway", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);
    const first = (await app.mirror.readMeta())!.cursor;

    app = await launch(taxis);
    await signIn(app.sync, 1);
    expect((await app.mirror.readMeta())!.cursor).toBe(first);
    expect(ids(await app.mirror.allRows())).toEqual([1, 2]);
  });

  it("pages a long backlog rather than dropping the tail of it", async () => {
    const taxis = fakeTaxis([row(1, 100)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    // More changes than one follow request resolves.
    for (let i = 2; i <= 1_200; i++) taxis.upsert(row(i, 1_000 + i));
    app = await launch(taxis);
    taxis.calls.changes = 0;
    await signIn(app.sync, 1);

    expect(taxis.calls.changes).toBeGreaterThan(1);
    expect(ids(await app.mirror.allRows())).toHaveLength(1_200);
  });
});

describe("when the server cannot answer incrementally", () => {
  it("reads the tracker again on reset, rather than carrying on with a gap", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    // Things happen, and the log is trimmed past this client's cursor.
    taxis.upsert(row(3, 300));
    taxis.upsert(row(4, 400));
    taxis.prune(1);

    app = await launch(taxis);
    taxis.calls.page = 0;
    await signIn(app.sync, 1);

    expect(taxis.calls.page).toBeGreaterThan(0);
    expect(ids(await app.mirror.allRows())).toEqual([1, 2, 3, 4]);
  });
});

describe("whose tracker it is a copy of", () => {
  it("reads again for a different account instead of extending the last one's copy", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    // A different reader signs in, and sees a different set of issues.
    taxis.remove(1);
    taxis.remove(2);
    taxis.upsert(row(7, 700));
    taxis.upsert(row(8, 800));
    app = await launch(taxis);
    await signIn(app.sync, 2);

    expect(ids(await app.mirror.allRows())).toEqual([7, 8]);
    expect(await app.mirror.readMeta()).toMatchObject({ actorId: 2 });
  });
});

describe("when the connection goes and comes back", () => {
  it("keeps the pages that did arrive, and does not move its cursor past them", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i));
    const taxis = fakeTaxis(rows);
    const failing = {
      ...taxis,
      issuePage(query: { cursor?: string }): Promise<IssuePage> {
        if (taxis.calls.page >= 1) return Promise.reject(new TypeError("Failed to fetch"));
        return taxis.issuePage(query);
      },
    };
    const { mirror, sync } = await launch(failing as Taxis);
    await signIn(sync, 1);

    // Ten issues are better than none, and with no cursor written the next sync reads again.
    expect(await mirror.storedCount()).toBe(10);
    expect(await mirror.readMeta()).toBeNull();
    expect(sync.syncSnapshot().error).toBeNull();
  });

  it("syncs as soon as the connection is back, without being asked", async () => {
    const taxis = fakeTaxis([row(1, 100)]);
    const { sync } = await launch(taxis);
    await signIn(sync, 1);
    taxis.calls.changes = 0;

    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    await sync.syncNow(true);

    expect(taxis.calls.changes).toBeGreaterThan(0);
  });

  it("does not re-sync on every request that happens to succeed", async () => {
    const taxis = fakeTaxis([row(1, 100)]);
    const { sync } = await launch(taxis);
    await signIn(sync, 1);
    taxis.calls.changes = 0;

    await sync.syncNow();
    expect(taxis.calls.changes).toBe(0);
  });
});

describe("the change stream", () => {
  it("opens one, and syncs when the server says something moved", async () => {
    const taxis = fakeTaxis([row(1, 100)]);
    const { mirror, sync } = await launch(taxis);
    await signIn(sync, 1);
    expect(streams).toHaveLength(1);
    expect(streams[0].url).toBe(`${SERVER}/api/changes/stream`);

    taxis.upsert(row(2, 200, { title: "Pushed" }));
    for (const fn of streams[0].handlers["change"] ?? []) fn();
    // The nudge is debounced, then answered by one sync.
    await new Promise((r) => setTimeout(r, 400));
    await sync.syncNow(true);

    expect(titleOf(await mirror.allRows(), 2)).toBe("Pushed");
    expect(ids(await mirror.allRows())).toEqual([1, 2]);
  });

  it("catches up on reconnect, since whatever happened while it was down did not reach it", async () => {
    const taxis = fakeTaxis([row(1, 100)]);
    const { mirror, sync } = await launch(taxis);
    await signIn(sync, 1);

    streams[0].onerror?.();
    expect(sync.syncSnapshot().live).toBe(false);
    taxis.upsert(row(5, 500, { title: "Missed while down" }));
    streams[0].onopen?.();
    await sync.syncNow(true);

    expect(sync.syncSnapshot().live).toBe(true);
    expect(titleOf(await mirror.allRows(), 5)).toBe("Missed while down");
  });
});

describe("a tracker larger than the app keeps", () => {
  it("stores the most recently updated issues and admits it is not all of them", async () => {
    const { MIRROR_CAP } = await import("./mirror");
    const rows = Array.from({ length: MIRROR_CAP + 50 }, (_, i) => row(i + 1, 1_000 + i));
    const taxis = fakeTaxis(rows, 500);
    const { mirror, sync } = await launch(taxis);
    await signIn(sync, 1);

    expect(await mirror.storedCount()).toBe(MIRROR_CAP);
    expect((await mirror.readMeta())!.complete).toBe(false);
    // Newest first, so what was dropped is the far end of the list — the oldest 50.
    expect(ids(await mirror.allRows())[0]).toBe(51);
    expect(sync.syncSnapshot().complete).toBe(false);
  });

  it("holds a capped mirror at the cap as changes arrive, rather than creeping past it", async () => {
    const { MIRROR_CAP } = await import("./mirror");
    const rows = Array.from({ length: MIRROR_CAP + 50 }, (_, i) => row(i + 1, 1_000 + i));
    const taxis = fakeTaxis(rows, 500);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    for (let i = 1; i <= 20; i++) taxis.upsert(row(MIRROR_CAP + 100 + i, 90_000 + i));
    app = await launch(taxis);
    await signIn(app.sync, 1);

    expect(await app.mirror.storedCount()).toBe(MIRROR_CAP);
    // The new ones are here; the oldest gave way for them.
    expect(ids(await app.mirror.allRows())).toContain(MIRROR_CAP + 101);
  });
});
