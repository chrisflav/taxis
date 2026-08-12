import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The list of trackers the packaged app knows, and what is scoped to each.
 *
 * Every mutation in `server.ts` ends in a page reload, which jsdom does not implement — so
 * `location.reload` is stubbed and each test asserts against what reached storage, which is what
 * the reload would then read back. That is also the honest thing to test: the reload exists to make
 * storage the single source of truth.
 */

const RELOAD = vi.fn();

async function loadServerModule() {
  vi.resetModules();
  (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  return { ...(await import("./server")), ...(await import("./serverList")) };
}

function stored(): { servers: { url: string; label: string; token: string | null }[]; active: string | null } {
  return JSON.parse(localStorage.getItem("taxis.servers") ?? '{"servers":[],"active":null}');
}

beforeEach(() => {
  localStorage.clear();
  RELOAD.mockClear();
  // jsdom's `location.reload` throws "not implemented"; every mutation calls it.
  Object.defineProperty(window, "location", {
    value: { ...window.location, reload: RELOAD, hash: "" },
    writable: true,
  });
});

describe("the server list", () => {
  it("starts empty, which is what shows the connect screen", async () => {
    const s = await loadServerModule();
    expect(s.servers()).toEqual([]);
    expect(s.activeServer()).toBeNull();
    expect(s.isConfigured()).toBe(false);
  });

  it("adds a server, makes it current, and names it after its host by default", async () => {
    const s = await loadServerModule();
    s.saveServer({ url: "https://taxis.example.org", label: "", token: "tok" });

    expect(stored().servers).toEqual([
      { url: "https://taxis.example.org", label: "taxis.example.org", token: "tok" },
    ]);
    expect(stored().active).toBe("https://taxis.example.org");
    expect(RELOAD).toHaveBeenCalled();
  });

  it("keeps several and switches between them without touching either's token", async () => {
    let s = await loadServerModule();
    s.saveServer({ url: "https://work.example.org", label: "Work", token: "work-token" });
    s = await loadServerModule();
    s.saveServer({ url: "http://192.168.1.10:8080", label: "Desk", token: "desk-token" });

    s = await loadServerModule();
    expect(s.servers().map((x) => x.label)).toEqual(["Work", "Desk"]);
    expect(s.activeServer()?.url).toBe("http://192.168.1.10:8080");
    expect(s.apiBase()).toBe("http://192.168.1.10:8080/api");
    expect(s.authHeaders()).toEqual({ Authorization: "Bearer desk-token" });

    s.switchToServer("https://work.example.org");
    s = await loadServerModule();
    expect(s.apiBase()).toBe("https://work.example.org/api");
    expect(s.authHeaders()).toEqual({ Authorization: "Bearer work-token" });
    // The one it switched away from is untouched, which is the whole point of a list.
    expect(s.servers().find((x) => x.label === "Desk")?.token).toBe("desk-token");
  });

  it("scopes storage by server, so two trackers never share a queue", async () => {
    let s = await loadServerModule();
    s.saveServer({ url: "https://work.example.org", label: "Work", token: null });
    s = await loadServerModule();
    expect(s.serverScope()).toBe(":https://work.example.org");

    s.saveServer({ url: "https://home.example.org", label: "Home", token: null });
    s = await loadServerModule();
    expect(s.serverScope()).toBe(":https://home.example.org");
  });

  it("removing the current server falls back to the next one, or to none", async () => {
    let s = await loadServerModule();
    s.saveServer({ url: "https://a.example.org", label: "A", token: null });
    s = await loadServerModule();
    s.saveServer({ url: "https://b.example.org", label: "B", token: null });

    s = await loadServerModule();
    s.removeServer("https://b.example.org");
    expect(stored().servers.map((x) => x.url)).toEqual(["https://a.example.org"]);
    expect(stored().active).toBe("https://a.example.org");

    s = await loadServerModule();
    s.removeServer("https://a.example.org");
    expect(stored().servers).toEqual([]);
    expect(stored().active).toBeNull();
  });

  it("tells the modules holding server-scoped state when one is forgotten", async () => {
    let s = await loadServerModule();
    const forgotten: string[] = [];
    s.onServerForgotten((scope) => forgotten.push(scope));
    s.saveServer({ url: "https://a.example.org", label: "A", token: null });

    s = await loadServerModule();
    s.onServerForgotten((scope) => forgotten.push(scope));
    s.removeServer("https://a.example.org");
    expect(forgotten).toEqual([":https://a.example.org"]);
  });

  it("editing the address is a move: the old identity is forgotten, the place in the list is not", async () => {
    let s = await loadServerModule();
    s.saveServer({ url: "https://a.example.org", label: "A", token: "t" });
    s = await loadServerModule();
    s.saveServer({ url: "https://z.example.org", label: "Z", token: "t" });

    s = await loadServerModule();
    const forgotten: string[] = [];
    s.onServerForgotten((scope) => forgotten.push(scope));
    s.saveServer({ url: "https://a2.example.org", label: "A", token: "t" }, "https://a.example.org");

    expect(stored().servers.map((x) => x.url)).toEqual(["https://a2.example.org", "https://z.example.org"]);
    expect(forgotten).toEqual([":https://a.example.org"]);
  });

  it("migrates a single-server install from the keys the first build wrote", async () => {
    localStorage.setItem("taxis.serverUrl", "https://old.example.org");
    localStorage.setItem("taxis.apiToken", "old-token");

    const s = await loadServerModule();

    expect(s.servers()).toEqual([
      { url: "https://old.example.org", label: "old.example.org", token: "old-token" },
    ]);
    expect(s.activeServer()?.url).toBe("https://old.example.org");
    // …and the keys it came from are gone, so the migration happens exactly once.
    expect(localStorage.getItem("taxis.serverUrl")).toBeNull();
    expect(localStorage.getItem("taxis.apiToken")).toBeNull();
  });

  it("degrades to the connect screen rather than throwing on storage it cannot read", async () => {
    localStorage.setItem("taxis.servers", "{ not json");
    const s = await loadServerModule();
    expect(s.servers()).toEqual([]);
    expect(s.isConfigured()).toBe(false);
  });

  it("drops an entry an older or newer build wrote that has no address", async () => {
    localStorage.setItem(
      "taxis.servers",
      JSON.stringify({ v: 2, servers: [{ label: "nameless" }, { url: "https://ok.example.org", label: "OK" }], active: "https://ok.example.org" }),
    );
    const s = await loadServerModule();
    expect(s.servers().map((x) => x.url)).toEqual(["https://ok.example.org"]);
  });
});

describe("a browser build", () => {
  it("has no server list at all: it is served by the one it talks to", async () => {
    vi.resetModules();
    delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    const s = { ...(await import("./server")), ...(await import("./serverList")) };
    expect(s.servers()).toEqual([]);
    expect(s.activeServer()).toBeNull();
    expect(s.isConfigured()).toBe(true);
    expect(s.apiBase()).toBe("/api");
    // Empty, so every storage key stays byte-for-byte what it was before any of this existed.
    expect(s.serverScope()).toBe("");
  });
});
