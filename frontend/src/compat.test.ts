import { describe, expect, it } from "vitest";
import { explainServerError, missingEndpoint, outdatedServerMessage } from "./compat";

/**
 * The packaged app can be older or newer than the server it is pointed at — a state a browser can
 * never be in, since the tracker serves its own frontend. These pin down the one thing that state
 * looks like from the client: a request that fell through to `/api/issues/:id` because the server
 * has never heard of the route, and answered by rejecting `page` as an issue id.
 *
 * The important half of this is the negative case. Rewriting a genuine bad-reference error into
 * "update your server" would send a reader to fix something that is not broken.
 */
describe("missingEndpoint", () => {
  it("recognises a sub-resource that fell through to the issue-id route", () => {
    expect(missingEndpoint("invalid id: page")).toBe("the paged issue list");
    expect(missingEndpoint("invalid id: index")).toBe("the issue naming index");
    expect(missingEndpoint("  invalid id: page  ")).toBe("the paged issue list");
  });

  it("leaves a reader's own bad issue reference alone", () => {
    expect(missingEndpoint("invalid id: 12x")).toBeNull();
    expect(missingEndpoint("invalid id: abc")).toBeNull();
    expect(missingEndpoint("invalid id: ")).toBeNull();
  });

  it("leaves every other server error alone", () => {
    for (const message of ["not found", "authentication required", "admin privileges required", ""]) {
      expect(missingEndpoint(message)).toBeNull();
    }
  });
});

describe("explainServerError", () => {
  it("replaces the routing accident with the cause and the fix", () => {
    expect(explainServerError("invalid id: page")).toBe(
      outdatedServerMessage("the paged issue list"),
    );
    expect(explainServerError("invalid id: page")).toContain("Update the taxis server");
  });

  it("passes everything else through unchanged", () => {
    for (const message of ["not found", "invalid id: 12x", "authentication required"]) {
      expect(explainServerError(message)).toBe(message);
    }
  });
});
