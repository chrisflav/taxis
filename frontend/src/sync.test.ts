import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueListRow, IssuePage } from "./types";

/**
 * Keeping the copy true.
 *
 * The claim this module makes is that a whole tracker can be kept current on a phone for about one
 * request, and the way it earns that is the incremental walk: `sort=updated` returns issues
 * newest-changed first, so the first issue older than the last sync's newest one is proof that
 * everything behind it is unchanged. Most of what follows is about the edges of that argument —
 * the second where two issues were touched at once, the deletion that no walk can ever show, the
 * account change that invalidates the whole premise — because those are where "it stopped early"
 * turns from an optimisation into missing data.
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
 * A taxis that pages the way the real one does: `updated_at DESC, id DESC`, resumed by an opaque
 * `(updatedAt, id)` cursor, with the total on the first page only. Its page size is its own —
 * a server may answer with fewer rows than were asked for — which is what lets a walk of thirty
 * issues here take the several requests a walk of ten thousand takes there.
 */
function fakeTaxis(initial: IssueListRow[], pageSize = 10) {
  let rows = initial;
  const calls: { cursor?: string }[] = [];
  return {
    get calls() { return calls; },
    /** Change what the server holds, as somebody else editing the tracker would. */
    set(next: IssueListRow[]) { rows = next; },
    issuePage(query: { cursor?: string }): Promise<IssuePage> {
      calls.push({ cursor: query.cursor });
      const all = rows.slice().sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
      let remaining = all;
      if (query.cursor) {
        const [, u, i] = query.cursor.split(".");
        const cu = Number(u);
        const ci = Number(i);
        remaining = all.filter((r) => r.updatedAt < cu || (r.updatedAt === cu && r.id < ci));
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
}

/** Start the app, packaged and connected to `SERVER`, talking to `taxis`. Fresh module state, so
 *  this is also what relaunching the app is — with whatever was stored last time still on disk. */
async function launch(taxis: ReturnType<typeof fakeTaxis>) {
  vi.resetModules();
  (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  localStorage.setItem(
    "taxis.servers",
    JSON.stringify({ v: 2, servers: [{ url: SERVER, label: "T", token: null }], active: SERVER }),
  );
  vi.doMock("./api", () => ({ api: { issuePage: taxis.issuePage } }));
  const mirror = await import("./mirror");
  const sync = await import("./sync");
  return { mirror, sync };
}

/** Sign in and let the first sync finish. Signing in is what starts one: what a reader may see is
 *  a property of who they are, so there is nothing to mirror before the session lands. */
async function signIn(sync: { setSyncActor: (id: number | null) => void; syncNow: (f?: boolean) => Promise<void> }, id: number) {
  sync.setSyncActor(id);
  await sync.syncNow(true);
}

const ids = (rows: IssueListRow[]) => rows.map((r) => r.id).sort((a, b) => a - b);

beforeEach(() => {
  localStorage.clear();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("the first sync", () => {
  it("walks the whole tracker and stores every issue", async () => {
    const taxis = fakeTaxis(Array.from({ length: 25 }, (_, i) => row(i + 1, 1_000 + i)));
    const { mirror, sync } = await launch(taxis);
    await signIn(sync, 1);

    expect(ids(await mirror.allRows())).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(taxis.calls.length).toBeGreaterThan(1); // Paged, not read in one response.
    expect(sync.syncSnapshot()).toMatchObject({ stored: 25, complete: true, syncing: false });
  });

  it("records where it got to, so the next one has somewhere to stop", async () => {
    const taxis = fakeTaxis([row(1, 500), row(2, 900)]);
    const { mirror, sync } = await launch(taxis);
    await signIn(sync, 1);

    expect(await mirror.readMeta()).toMatchObject({ actorId: 1, highUpdatedAt: 900, highId: 2, count: 2 });
  });

  it("does nothing until it knows who is asking", async () => {
    const taxis = fakeTaxis([row(1, 500)]);
    const { sync } = await launch(taxis);
    // Visibility is per actor, so a walk before the session lands would mirror the wrong tracker.
    await sync.syncNow(true);
    expect(taxis.calls).toHaveLength(0);
  });
});

describe("every sync after that", () => {
  it("stops at the first issue older than the last sync, which is one request", async () => {
    const taxis = fakeTaxis(Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i)));
    let app = await launch(taxis);
    await signIn(app.sync, 1);
    const firstWalk = taxis.calls.length;
    expect(firstWalk).toBeGreaterThan(2);

    // Somebody edits one issue. Everything else is where it was.
    taxis.set([...Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i)).slice(0, 29), row(30, 5_000)]);
    app = await launch(taxis);
    taxis.calls.length = 0;
    await signIn(app.sync, 1);

    expect(taxis.calls).toHaveLength(1);
    expect(ids(await app.mirror.allRows())).toHaveLength(30);
    expect((await app.mirror.allRows()).find((r) => r.id === 30)!.updatedAt).toBe(5_000);
  });

  it("brings back an issue whose title changed", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    taxis.set([row(1, 100), row(2, 300, { title: "Renamed" })]);
    app = await launch(taxis);
    await signIn(app.sync, 1);

    expect((await app.mirror.allRows()).find((r) => r.id === 2)!.title).toBe("Renamed");
  });

  it("re-reads the whole second it stopped in, because updatedAt has no finer resolution", async () => {
    // Two issues touched in the same second, one of them again just after the walk went past.
    const taxis = fakeTaxis([row(1, 100), row(2, 100)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    taxis.set([row(1, 100), row(2, 100, { title: "Edited in the same second" })]);
    app = await launch(taxis);
    await signIn(app.sync, 1);

    // Stopping on `<=` rather than `<` would have skipped this and never come back for it.
    expect((await app.mirror.allRows()).find((r) => r.id === 2)!.title).toBe("Edited in the same second");
  });

  it("catches an issue edited while the walk that would have carried it was still running", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i));
    const taxis = fakeTaxis(rows);
    // Somebody edits issue 1 just after the first page goes out. The server stamps it with the
    // current time, so it jumps to the front of `updated_at DESC` — a position this walk has
    // already gone past, which means this walk will never deliver it.
    const racing = {
      ...taxis,
      get calls() { return taxis.calls; },
      issuePage(query: { cursor?: string }) {
        const answer = taxis.issuePage(query);
        if (taxis.calls.length === 1) {
          taxis.set([...rows.filter((r) => r.id !== 1), row(1, 9_999, { title: "Edited mid-walk" })]);
        }
        return answer;
      },
    };
    let app = await launch(racing as ReturnType<typeof fakeTaxis>);
    await signIn(app.sync, 1);
    expect(ids(await app.mirror.allRows())).not.toContain(1);

    // The edit is newer than anything that walk saw, so it sits at or above the mark the walk
    // wrote — and a stop that is strict rather than inclusive reaches it.
    app = await launch(taxis);
    await signIn(app.sync, 1);
    expect((await app.mirror.allRows()).find((r) => r.id === 1)!.title).toBe("Edited mid-walk");
  });

  it("asks for nothing at all when the mark is where it left it — beyond the one request that says so", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    app = await launch(taxis);
    taxis.calls.length = 0;
    await signIn(app.sync, 1);
    expect(taxis.calls).toHaveLength(1);
    expect(ids(await app.mirror.allRows())).toEqual([1, 2]);
  });
});

describe("issues that were deleted", () => {
  it("removes one, even though no walk will ever mention it", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200), row(3, 300)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);
    expect(ids(await app.mirror.allRows())).toEqual([1, 2, 3]);

    // Issue 2 is deleted. It appears in no page of any order — the count is the only evidence.
    taxis.set([row(1, 100), row(3, 300)]);
    app = await launch(taxis);
    await signIn(app.sync, 1);

    expect(ids(await app.mirror.allRows())).toEqual([1, 3]);
    expect(await app.mirror.storedCount()).toBe(2);
  });

  it("leaves the mirror alone when the count agrees, rather than re-walking on every sync", async () => {
    const taxis = fakeTaxis(Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i)));
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    app = await launch(taxis);
    taxis.calls.length = 0;
    await signIn(app.sync, 1);
    // One request, not a full re-walk: the total the server sent matches what is stored.
    expect(taxis.calls).toHaveLength(1);
  });
});

describe("whose tracker it is a copy of", () => {
  it("rebuilds for a different account instead of adding to the last one's copy", async () => {
    const taxis = fakeTaxis([row(1, 100), row(2, 200)]);
    let app = await launch(taxis);
    await signIn(app.sync, 1);

    // A different reader signs in, and sees a different set of issues.
    taxis.set([row(7, 700), row(8, 800)]);
    app = await launch(taxis);
    await signIn(app.sync, 2);

    // Not [1, 2, 7, 8]: issues 1 and 2 are somebody else's visibility, not this reader's.
    expect(ids(await app.mirror.allRows())).toEqual([7, 8]);
    expect(await app.mirror.readMeta()).toMatchObject({ actorId: 2 });
  });
});

describe("when the connection goes and comes back", () => {
  it("keeps the pages that did arrive, and says nothing — that is the offline indicator's line", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i));
    const taxis = fakeTaxis(rows);
    const failing = {
      ...taxis,
      get calls() { return taxis.calls; },
      issuePage(query: { cursor?: string }): Promise<IssuePage> {
        // The first page lands; the tunnel starts immediately after it.
        if (taxis.calls.length >= 1) return Promise.reject(new TypeError("Failed to fetch"));
        return taxis.issuePage(query);
      },
    };
    const { mirror, sync } = await launch(failing as ReturnType<typeof fakeTaxis>);
    await signIn(sync, 1);

    // Ten issues are better than none, and the mark was not written, so the next walk redoes this.
    expect(await mirror.storedCount()).toBe(10);
    expect(await mirror.readMeta()).toBeNull();
    expect(sync.syncSnapshot().error).toBeNull();
  });

  it("syncs as soon as the connection is back, without being asked", async () => {
    const taxis = fakeTaxis([row(1, 100)]);
    const { sync } = await launch(taxis);
    await signIn(sync, 1);
    taxis.calls.length = 0;

    // The events `offline.ts` already listens to are the whole trigger — nothing here polls.
    window.dispatchEvent(new Event("offline"));
    window.dispatchEvent(new Event("online"));
    await sync.syncNow(true);

    expect(taxis.calls.length).toBeGreaterThan(0);
  });

  it("does not re-walk on every request that happens to succeed", async () => {
    const taxis = fakeTaxis([row(1, 100)]);
    const { sync } = await launch(taxis);
    await signIn(sync, 1);
    taxis.calls.length = 0;

    // An ordinary sync, moments after the last one: evidence of a connection is not news about one.
    await sync.syncNow();
    expect(taxis.calls).toHaveLength(0);
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
    const stored = ids(await mirror.allRows());
    expect(stored[0]).toBe(51);
    expect(sync.syncSnapshot().complete).toBe(false);
  });

  it("re-walks a capped mirror in full rather than resuming from a mark that describes a slice", async () => {
    // Thirty issues over pages of ten, so a full walk and an incremental one are different
    // numbers of requests rather than both being one.
    const taxis = fakeTaxis(Array.from({ length: 30 }, (_, i) => row(i + 1, 1_000 + i)));
    let app = await launch(taxis);
    await signIn(app.sync, 1);
    // As a walk cut short by the cap would have left it: a mark that describes the newest slice
    // it kept, not the tracker.
    await app.mirror.writeMeta({ ...(await app.mirror.readMeta())!, complete: false });

    app = await launch(taxis);
    taxis.calls.length = 0;
    await signIn(app.sync, 1);
    // Several requests, not the one an incremental walk would have taken.
    expect(taxis.calls.length).toBeGreaterThan(1);
    expect(taxis.calls[0].cursor).toBeUndefined();
  });
});
