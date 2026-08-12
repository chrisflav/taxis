/**
 * What to do when the app is newer than the server it is pointed at.
 *
 * In a browser this cannot happen: the tracker serves its own frontend, so the two are always the
 * same build. The packaged app is the first taxis client that ships separately from the server, and
 * a phone keeps the version it was installed with until somebody updates it. So "your server is
 * older than this app" is now an ordinary state, and it has to be *said* — the alternative is what
 * the app does otherwise, which is to send a request to an endpoint the server has never heard of
 * and report back whatever the server made of the accident.
 *
 * The concrete accident: `GET /api/issues/page` on a server that predates the paged issue list
 * falls through to `GET /api/issues/:id`, which rejects `page` as an issue id. The reader is shown
 * "invalid id: page" over an empty list, which names neither the cause nor the fix.
 */

/** The sub-resources under `/issues/` that an old server mistakes for an issue id, described the
 *  way they should be *read* rather than the way they are spelled. */
const SUBRESOURCES: Record<string, string> = {
  page: "the paged issue list",
  index: "the issue naming index",
};

/**
 * Recognise the one error shape that means "this endpoint is newer than this server".
 *
 * Deliberately narrow. `invalid id: page` is only ever a routing accident, because nothing in the
 * app can ask for an issue called `page`; `invalid id: 12x` is a reader following a broken
 * reference, and must go on saying exactly that. Anything not in `SUBRESOURCES` is left alone.
 */
export function missingEndpoint(message: string): string | null {
  const match = /^invalid id: (.+)$/.exec(message.trim());
  return match ? SUBRESOURCES[match[1]] ?? null : null;
}

/** The sentence shown in place of a routing accident, wherever one surfaces. */
export function outdatedServerMessage(what: string): string {
  return `this server does not have ${what} — it is older than the app. Update the taxis server.`;
}

/**
 * Rewrite a server error into one a reader can act on, or leave it exactly as it was.
 *
 * Applied in the one place every request passes through, so every view that shows a server error
 * gets the better sentence without knowing this module exists.
 */
export function explainServerError(message: string): string {
  const what = missingEndpoint(message);
  return what ? outdatedServerMessage(what) : message;
}

/** One endpoint the app needs, and how to find out whether a server has it. */
interface Requirement {
  /** Path and query, appended to the server's `/api`. */
  probe: string;
  /** What it is, for the message. */
  what: string;
  /** The commit that introduced it, so the answer names a version rather than just "newer". */
  since: string;
}

/**
 * The floor: not every endpoint the app calls, but the ones a server old enough to matter lacks.
 *
 * Ordered oldest first, which is what lets the verdict name a single commit to get past.
 */
const REQUIREMENTS: Requirement[] = [
  { probe: "/session", what: "the session endpoint", since: "5a21b11" },
  { probe: "/issues/page?limit=1", what: "the paged issue list", since: "5a21b11" },
  { probe: "/issues/index?limit=1", what: "the issue naming index", since: "971fc7d" },
];

export interface Compatibility {
  /** Empty when the server has everything the app needs. */
  missing: string[];
  /** The newest commit named by anything missing — what the server has to be updated past. */
  needs: string | null;
}

/**
 * Ask a server whether it has what this app is built against.
 *
 * Three small requests, only on the connect screen and only when somebody presses the button — the
 * app does not re-litigate this on every launch. A `401` or `403` counts as *present*: the server
 * knew the route and objected to who was asking, which is a different problem and one the token
 * field is already about. So does a network failure — reporting an unreachable server as an
 * outdated one would send somebody to fix the wrong thing, and the address check already covers it.
 */
export async function checkCompatibility(
  base: string,
  token: string | null,
): Promise<Compatibility> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const results = await Promise.all(
    REQUIREMENTS.map(async (requirement) => {
      try {
        const res = await fetch(base + "/api" + requirement.probe, { headers });
        if (res.ok || res.status === 401 || res.status === 403) return null;
        return requirement;
      } catch {
        return null;
      }
    }),
  );

  const absent = results.filter((r): r is Requirement => r != null);
  return {
    missing: absent.map((r) => r.what),
    needs: absent.length ? absent[absent.length - 1].since : null,
  };
}
