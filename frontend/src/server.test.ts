import { describe, expect, it } from "vitest";
import { isPrivateHost, normalizeServerUrl } from "./server";

/**
 * `normalizeServerUrl` is the packaged app's front door: everything it reads and writes goes to
 * whatever this returns, and the person typing into it is on a phone keyboard, often reading an
 * address off another screen. So the cases worth pinning down are the sloppy ones — a missing
 * scheme, a trailing slash, the `/api` suffix that is in the clipboard of anyone who was just
 * looking at the API — and the ones that must be *rejected* rather than half-understood.
 */
describe("normalizeServerUrl", () => {
  it("keeps a well-formed URL as it is", () => {
    expect(normalizeServerUrl("https://taxis.example.org")).toBe("https://taxis.example.org");
    expect(normalizeServerUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("trims whitespace and trailing slashes", () => {
    expect(normalizeServerUrl("  https://taxis.example.org/  ")).toBe("https://taxis.example.org");
    expect(normalizeServerUrl("https://taxis.example.org///")).toBe("https://taxis.example.org");
  });

  it("defaults a public host to https and a private one to http", () => {
    expect(normalizeServerUrl("taxis.example.org")).toBe("https://taxis.example.org");
    expect(normalizeServerUrl("localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeServerUrl("192.168.1.10:8080")).toBe("http://192.168.1.10:8080");
    expect(normalizeServerUrl("10.0.0.2")).toBe("http://10.0.0.2");
    expect(normalizeServerUrl("172.20.3.4:8080")).toBe("http://172.20.3.4:8080");
    // …but 172.32 is public: the private block stops at 172.31.
    expect(normalizeServerUrl("172.32.3.4")).toBe("https://172.32.3.4");
  });

  it("does not override a scheme that was given", () => {
    expect(normalizeServerUrl("http://taxis.example.org")).toBe("http://taxis.example.org");
    expect(normalizeServerUrl("https://localhost:8080")).toBe("https://localhost:8080");
  });

  it("keeps a path prefix, for a tracker that is not at the root of its host", () => {
    expect(normalizeServerUrl("https://example.org/taxis")).toBe("https://example.org/taxis");
    expect(normalizeServerUrl("https://example.org/taxis/")).toBe("https://example.org/taxis");
  });

  it("drops a trailing /api — the URL you have when you were looking at the API", () => {
    expect(normalizeServerUrl("https://taxis.example.org/api")).toBe("https://taxis.example.org");
    expect(normalizeServerUrl("https://example.org/taxis/api/")).toBe("https://example.org/taxis");
  });

  it("rejects what cannot be a base", () => {
    expect(normalizeServerUrl("")).toBeNull();
    expect(normalizeServerUrl("   ")).toBeNull();
    expect(normalizeServerUrl("ftp://example.org")).toBeNull();
    expect(normalizeServerUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeServerUrl("https://")).toBeNull();
  });

  it("drops a query or fragment rather than appending paths after them", () => {
    expect(normalizeServerUrl("https://example.org/#/issues/3")).toBe("https://example.org");
    expect(normalizeServerUrl("https://example.org/?x=1")).toBe("https://example.org");
  });
});

describe("isPrivateHost", () => {
  it("recognises this device and the private ranges", () => {
    for (const host of [
      "localhost", "127.0.0.1", "::1", "0.0.0.0",
      "nas.local", "taxis.home.arpa",
      "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.254",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("does not mistake a public host for a private one", () => {
    for (const host of ["example.org", "8.8.8.8", "172.15.0.1", "172.32.0.1", "1.192.168.1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});
