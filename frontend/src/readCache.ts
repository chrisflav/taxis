/**
 * The read cache, on disk, for the packaged app only.
 *
 * `cache.ts` keeps responses in memory and says why that is right on the web: a page load should
 * fetch what the page needs, not come up holding every issue the tab has ever opened. That reasoning
 * depends on what a page load *means* there — a reload is a person asking for this page, fresh.
 *
 * On a phone it means something else entirely. The system kills the WebView whenever it wants the
 * memory back, so opening the app is a cold page load almost every time, and it is not a request for
 * anything: it is the same person returning to the same screen. With the cache in memory only, every
 * launch started empty, which offline meant a connection error over a blank list — for issues that
 * had been read a dozen times.
 *
 * So the app writes what it reads to `localStorage` and hydrates from it at startup, and the web
 * build does neither. `isNativeApp` is a build-time constant, so on the web every function here
 * folds to nothing and the bundler removes it.
 *
 * What this is *not* is a second source of truth. Restored entries keep the timestamp they were
 * written with, so the staleness rules in `cache.ts` see them exactly as they would see an old
 * in-memory entry: something to paint immediately and revalidate at once. It changes when the data
 * is thrown away, not whether it is trusted.
 */

import { isNativeApp, onServerForgotten, serverScope } from "./server";

export interface StoredEntry {
  data: unknown;
  /** When the entry was written — the freshness clock, preserved across launches. */
  at: number;
}

const PREFIX = "taxis:read:";

/**
 * A single response big enough to be worth skipping. The dependency graph over a large tracker is
 * the one that gets here; caching it would spend most of the budget on the view least likely to be
 * opened offline, and it is derived data the server can rebuild.
 */
const MAX_ENTRY_BYTES = 192 * 1024;

/**
 * What the whole cache may occupy. `localStorage` gives an origin about 5 MB, and the *write* queue
 * shares it — that queue is the only copy of somebody's unsent work, and a read cache filling the
 * quota until the queue cannot be persisted would trade something replaceable for something that is
 * not. Hence a budget with room left over, and eviction that gives way rather than pushing back.
 */
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/** `taxis:read:<scope>|<cache key>` — the scope keeps one tracker's answers out of another's. */
function storageKey(key: string, scope: string = serverScope()): string {
  return `${PREFIX}${scope}|${key}`;
}

function isOurs(storageName: string, scope: string): boolean {
  return storageName.startsWith(`${PREFIX}${scope}|`);
}

function cacheKeyOf(storageName: string, scope: string): string {
  return storageName.slice(PREFIX.length + scope.length + 1);
}

/** Every stored entry for a scope, newest first, with the bytes each one costs. */
function inventory(scope: string): { name: string; at: number; bytes: number }[] {
  const out: { name: string; at: number; bytes: number }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (!name || !isOurs(name, scope)) continue;
    const raw = localStorage.getItem(name);
    if (raw == null) continue;
    let at = 0;
    try {
      at = (JSON.parse(raw) as StoredEntry).at ?? 0;
    } catch {
      at = 0; // Unreadable: treat as oldest, so it is the first thing evicted.
    }
    out.push({ name, at, bytes: raw.length + name.length });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Drop the oldest entries of a scope until `keepBytes` remain. Returns how many went. */
function evict(scope: string, keepBytes: number): number {
  const items = inventory(scope);
  let total = 0;
  let dropped = 0;
  for (const item of items) {
    total += item.bytes;
    if (total > keepBytes) {
      localStorage.removeItem(item.name);
      dropped++;
    }
  }
  return dropped;
}

/**
 * Everything stored for the current server, as the map `cache.ts` starts from.
 *
 * Also where the budget is enforced: a launch is the one moment the whole cache can be looked at
 * without doing it on the critical path of a write.
 */
export function hydrate(): Map<string, StoredEntry> {
  const entries = new Map<string, StoredEntry>();
  if (!isNativeApp || typeof window === "undefined") return entries;
  const scope = serverScope();
  if (!scope) return entries;
  try {
    evict(scope, MAX_TOTAL_BYTES);
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (!name || !isOurs(name, scope)) continue;
      const raw = localStorage.getItem(name);
      if (raw == null) continue;
      try {
        const parsed = JSON.parse(raw) as StoredEntry;
        if (parsed && typeof parsed.at === "number") {
          entries.set(cacheKeyOf(name, scope), parsed);
        }
      } catch {
        localStorage.removeItem(name); // Written by a build that shaped it differently.
      }
    }
  } catch {
    /* Storage unavailable: the app runs exactly as it did before any of this, in memory only. */
  }
  return entries;
}

/** Keep one response across launches. Silently does nothing when it cannot, which is correct — a
 *  read cache that fails to persist costs a request later and nothing else. */
export function remember(key: string, entry: StoredEntry): void {
  if (!isNativeApp || typeof window === "undefined") return;
  const scope = serverScope();
  if (!scope) return;
  let payload: string;
  try {
    payload = JSON.stringify(entry);
  } catch {
    return; // Not serialisable; nothing to store.
  }
  if (payload.length > MAX_ENTRY_BYTES) return;
  const name = storageKey(key, scope);
  try {
    localStorage.setItem(name, payload);
  } catch {
    // Out of quota. Give way — halve this scope's cache and try once more; if that still fails,
    // stop trying. Never at the expense of the write queue, which shares this storage.
    try {
      evict(scope, MAX_TOTAL_BYTES / 2);
      localStorage.setItem(name, payload);
    } catch {
      /* Leave it in memory only. */
    }
  }
}

/** Forget exactly one key, mirroring `dropCached`. */
export function forget(key: string): void {
  if (!isNativeApp || typeof window === "undefined") return;
  const scope = serverScope();
  if (!scope) return;
  try {
    localStorage.removeItem(storageKey(key, scope));
  } catch {
    /* Nothing stored to remove. */
  }
}

/** Forget every key under a prefix, or all of them, mirroring `invalidateCache`. */
export function forgetPrefix(prefix?: string): void {
  if (!isNativeApp || typeof window === "undefined") return;
  const scope = serverScope();
  if (!scope) return;
  try {
    for (const item of inventory(scope)) {
      if (prefix == null || cacheKeyOf(item.name, scope).startsWith(prefix)) {
        localStorage.removeItem(item.name);
      }
    }
  } catch {
    /* Nothing stored to remove. */
  }
}

/** Drop a server's cached reads because the server itself has been forgotten. */
function clearScope(scope: string): void {
  if (typeof window === "undefined") return;
  try {
    for (const item of inventory(scope)) localStorage.removeItem(item.name);
  } catch {
    /* Nothing stored to remove. */
  }
}

if (isNativeApp && typeof window !== "undefined") {
  // Removing a server takes its answers with it, the same way it takes its queue.
  onServerForgotten(clearScope);
}
