/**
 * The difference between "nothing answered" and "the server said no".
 *
 * `fetch` rejects with a `TypeError` when the request never got an answer — no route to the host,
 * the radio is off, the connection dropped mid-flight. Every other outcome is a *response*: a 403,
 * a 409, a 500 are all the server talking, and they are errors the reader has to see.
 *
 * Its own module because both halves of the offline story need it and they cannot import each
 * other: the write queue (`offline.ts`) decides whether an unsent write is held, and the read cache
 * (`cache.ts`) decides whether a failed read falls back to the last answer it had. The rule is the
 * same one in both places, and it should be the same code.
 */
export function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError;
}

/**
 * What to put on screen when a read failed.
 *
 * Two things it fixes about `String(e)`, which is what the views used to show. A `fetch` rejection
 * stringifies to "TypeError: Failed to fetch" — the name of a JavaScript class and a phrase about
 * an internal API, in front of somebody whose actual situation is that they are on a train. And an
 * error the server explained stringifies with an "Error: " prefix glued to the front of a sentence
 * that was written to be read.
 *
 * The message deliberately says both halves of why there is nothing to show: no connection *and* no
 * local copy. Either alone would be survivable — that is what the read cache is for — and it is the
 * combination that leaves the screen empty.
 */
export function describeReadFailure(e: unknown): string {
  if (isNetworkError(e)) {
    return "No connection to the server, and no copy of this on this device yet.";
  }
  return e instanceof Error ? e.message : String(e);
}
