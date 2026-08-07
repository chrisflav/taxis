import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the packaged app actually puts on the wire.
 *
 * `server.ts` decides this once, at import time, from a build flag — so these tests set the native
 * bridge up *before* importing anything that reads it, and import the modules fresh each time. The
 * three things asserted here are the whole of what the packaging changes, and each of them is
 * invisible in a browser, where the app is served by the server it talks to:
 *
 *   - the request goes to the configured origin, not to the device;
 *   - it carries the API token, because no cookie could reach across origins;
 *   - it does *not* ask for credentials, because a response with `Access-Control-Allow-Origin: *`
 *     is rejected outright when the request was made with them.
 */

interface Captured {
  url: string;
  init: RequestInit;
}

/** Import `api` with the native bridge present, so `isNativeApp` resolves true. */
async function loadPackagedApi(server: string | null, token: string | null) {
  vi.resetModules();
  localStorage.clear();
  (window as unknown as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
  if (server) localStorage.setItem("taxis.serverUrl", server);
  if (token) localStorage.setItem("taxis.apiToken", token);
  return (await import("./api")).api;
}

/** Import `api` as a browser would, with no bridge. */
async function loadWebApi() {
  vi.resetModules();
  localStorage.clear();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  return (await import("./api")).api;
}

function captureFetch(body: unknown = {}): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  });
  return calls;
}

describe("the packaged app's requests", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the configured server for the issue list, at the path the server routes", async () => {
    const api = await loadPackagedApi("https://taxis.example.org", "secret-token");
    const calls = captureFetch({ issues: [], nextCursor: null, total: 0, stateCounts: null });

    await api.issuePage({ state: "open", limit: 40 });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin).toBe("https://taxis.example.org");
    // The exact path matters: `/api/issues/page` is its own route on the server, and anything that
    // does not land on it falls through to `/api/issues/:id` and is rejected as an issue id.
    expect(url.pathname).toBe("/api/issues/page");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("40");
  });

  it("sends the token as a bearer credential and asks for none of its own", async () => {
    const api = await loadPackagedApi("https://taxis.example.org", "secret-token");
    const calls = captureFetch({ actor: null });

    await api.session();

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(calls[0].init.credentials).toBe("omit");
  });

  it("carries no credential at all when no token was given", async () => {
    const api = await loadPackagedApi("https://taxis.example.org", null);
    const calls = captureFetch({ actor: null });

    await api.session();

    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("keeps a server that lives under a path prefix", async () => {
    const api = await loadPackagedApi("https://example.org/taxis", null);
    const calls = captureFetch({ issues: [] });

    await api.issuePage({ state: "open" });

    expect(new URL(calls[0].url).pathname).toBe("/taxis/api/issues/page");
  });

  it("changes nothing for a browser: same-origin path, cookie, no header", async () => {
    const api = await loadWebApi();
    const calls = captureFetch({ issues: [] });

    await api.issuePage({ state: "open" });

    expect(calls[0].url).toBe("/api/issues/page?state=open");
    expect(calls[0].init.credentials).toBe("include");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
