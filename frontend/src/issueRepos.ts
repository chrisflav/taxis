import { useEffect, useState } from "react";
import type { RepoRef } from "./types";
import { api, issueReposPath } from "./api";
import { REFERENCE_MAX_AGE, cachedGet, onInvalidate } from "./cache";

/**
 * Which repository an issue is about, learned as it is needed.
 *
 * An issue is about a repository because it carries one, or because something it is filed under
 * does; the server walks that chain (`GET /issues/repos`). Here that answer is cached for the life
 * of the tab and asked for by id, batched into one request per tick — the same arrangement as
 * `issueNames`, and for the same reason: a rail with a dozen rows asks once.
 *
 * Nothing is fetched ahead of a question. Only text that actually contains a `PR#123` asks, which
 * is nearly no text at all, so the ordinary page pays nothing for this.
 */

/** Answers held, including `null` for "there is no repository above this issue" — which is an
    answer, and worth remembering so a page carrying `PR#123` on an unattached issue doesn't ask
    again on every render. */
const known = new Map<number, RepoRef | null>();
const subscribers = new Set<() => void>();

let pending = new Set<number>();
let flushing = false;
/** Bumped whenever what has been learned is thrown away. A response that was in flight across
    that moment answers a question about the tracker as it was before the write, so it is dropped
    rather than written back over a map that has just been told it is out of date. */
let generation = 0;

/** How many issues to resolve in one request. Each costs the server a walk up a parent chain, so
    this is smaller than the naming index's batch. */
const BATCH = 50;

function notify(): void {
  subscribers.forEach((f) => f());
}

function flush(): void {
  flushing = false;
  const ids = [...pending];
  pending = new Set();
  if (ids.length === 0) return;
  const asked = generation;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    // The generation is part of the key, not merely checked when the answer lands. `cachedGet`
    // dedupes on the key, so a request made *after* a write would otherwise be handed the
    // pre-write request still in flight for the same path — and that answer would sail through
    // the check below, because it arrives under the current generation. A new generation is a
    // new question and gets a key of its own. The path is still the prefix, so one invalidation
    // still drops every one of them.
    const key = `${issueReposPath(chunk)}#g${asked}`;
    cachedGet(key, () => api.issueRepos(chunk), REFERENCE_MAX_AGE)
      .then((entries) => {
        // The other half: this one *was* in flight across the write, and is about a tracker that
        // has since changed.
        if (asked !== generation) return;
        // Everything asked for is settled, then the answers are written over it: an id the server
        // did not return names an issue that is gone or not visible, which has no repository just
        // as surely as one that came back without a repository.
        chunk.forEach((id) => known.set(id, null));
        for (const e of entries) known.set(e.issue, e.repo);
        notify();
      })
      .catch(() => { /* the references stay as the plain text they were written as */ });
  }
}


/** The path these answers are read from, and the prefix a write has to drop to make them stale. */
const PATH = "/issues/repos";

// Attaching a repository to an issue is precisely the write that should make a `PR#123` under it
// start linking, and every write that touches an issue drops the `/issues` cache. Without this the
// answers here — derived from those responses, not copies of them — outlived what they were
// derived from, and the reference stayed plain text until somebody reloaded the tab.
//
// The condition leans on every such write dropping the bare `"/issues"` — which is what `api`
// does, and narrowing it to one issue would quietly stop this firing, because what an issue is
// about can change from a write to an ancestor.
onInvalidate((prefix) => {
  if (prefix != null && !PATH.startsWith(prefix) && !prefix.startsWith(PATH)) return;
  generation += 1;
  pending = new Set();
  known.clear();
  // Unconditional, and deliberately so even when nothing was held: a request in flight right now
  // has just been disowned, and this is what makes whoever was waiting on it ask again. With
  // nothing mounted there is nobody subscribed and it costs nothing.
  notify();
});

/** Ask which repository each of `ids` is about, collapsing everything requested in the same tick
    into one request. */
export function requestIssueRepos(ids: Iterable<number>): void {
  let queued = false;
  for (const id of ids) {
    if (!Number.isFinite(id) || known.has(id) || pending.has(id)) continue;
    pending.add(id);
    queued = true;
  }
  if (!queued || flushing) return;
  flushing = true;
  setTimeout(flush, 0);
}

/** The repository `id` is about, fetching it if it is not held yet.
 *
 *  Three states, and they are not the same: `undefined` while the answer is still on its way (a
 *  `PR#123` renders as the text it is, and becomes a link when the answer lands), and `null` once
 *  we know nothing above the issue names a repository (it stays text). Passing no id — which is
 *  what text with no pull-request reference in it does — asks for nothing. */
export function useIssueRepo(id: number | null | undefined): RepoRef | null | undefined {
  const [version, bump] = useState(0);
  const active = id != null;
  useEffect(() => {
    if (!active) return;
    const wake = () => bump((n) => n + 1);
    subscribers.add(wake);
    return () => { subscribers.delete(wake); };
  }, [active]);
  // `version` is a dependency and not noise: a write that invalidates the store clears what was
  // learned, and this is what asks again — otherwise the reference stays unresolved until the
  // component happens to remount. Asking for an id already held is a no-op, so the extra runs in
  // the ordinary case cost nothing.
  useEffect(() => { if (id != null) requestIssueRepos([id]); }, [id, version]);
  return id == null ? undefined : known.get(id);
}
