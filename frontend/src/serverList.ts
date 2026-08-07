/**
 * Managing the list of trackers: adding one, naming one, switching, removing.
 *
 * Split from `server.ts` along the line of who needs it. *Which* server is current is asked by
 * every request the app makes, so it lives in the chunk that is always loaded; *changing* the list
 * happens on one screen the packaged app reaches from its own menu, and a browser never reaches at
 * all. Keeping the two apart is what lets the web build ship neither this module nor the screen it
 * backs — the same reason every view but the issue list is loaded on demand.
 */

import {
  isNativeApp,
  labelFor,
  notifyForgotten,
  readStore,
  writeStore,
  type ServerProfile,
} from "./server";

export { labelFor };

/** Every server the app knows about, in the order they were added. */
export function servers(): ServerProfile[] {
  return isNativeApp ? readStore().servers : [];
}

/**
 * Turn whatever somebody typed into an origin, or null if it cannot be one.
 *
 * Two things it does beyond parsing. It picks the scheme when none was given, and picks it by where
 * the host is: `localhost:8080` is the address this project's own README tells you to run, and
 * defaulting that to https would fail every first attempt. Anything not plainly on this device or a
 * private network defaults to https. It also drops a trailing `/api`, because that is the URL in
 * somebody's clipboard when they have been looking at the API rather than at the app.
 */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    const host = s.split("/")[0].split(":")[0];
    s = (isPrivateHost(host) ? "http://" : "https://") + s;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // A base is a scheme, a host and possibly a path prefix — a query or a fragment cannot survive
  // having `/api/issues` appended to it.
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/api")) path = path.slice(0, -4);
  return `${url.protocol}//${url.host}${path}`;
}

/** Whether a host is this device or a private network, and so is expected to be plain HTTP. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return true;
  if (/\.(local|localhost|home\.arpa)$/.test(h)) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

/**
 * Add a server or change one, and make it the current one.
 *
 * `previousUrl` is what the entry was called before, for an edit that moves it — since the URL is
 * the identity, that is a removal and an addition, and saying so lets the entry keep its place in
 * the list instead of jumping to the end.
 */
export function saveServer(profile: ServerProfile, previousUrl?: string): void {
  const store = readStore();
  const entry: ServerProfile = {
    url: profile.url,
    label: profile.label.trim() || labelFor(profile.url),
    token: profile.token?.trim() ? profile.token.trim() : null,
  };
  const replacing = previousUrl ?? entry.url;
  const at = store.servers.findIndex((s) => s.url === replacing);
  const next = [...store.servers];
  if (at >= 0) next[at] = entry;
  else next.push(entry);
  // An edit that moved the address leaves the old identity behind; nothing is scoped to it any
  // more, so its queue of unsent work goes with it.
  if (previousUrl && previousUrl !== entry.url) {
    notifyForgotten(previousUrl);
    const stale = next.findIndex((s, i) => s.url === previousUrl && i !== at);
    if (stale >= 0) next.splice(stale, 1);
  }
  writeStore({ v: 2, servers: next, active: entry.url });
}

/** Make an already-known server the current one. */
export function switchToServer(url: string): void {
  const store = readStore();
  if (!store.servers.some((s) => s.url === url) || store.active === url) return;
  writeStore({ ...store, active: url });
}

/**
 * Forget a server entirely, along with anything scoped to it.
 *
 * If it was the current one, the next in the list takes over — or none, which puts the app back at
 * the connect screen.
 */
export function removeServer(url: string): void {
  const store = readStore();
  const next = store.servers.filter((s) => s.url !== url);
  const active = store.active === url ? next[0]?.url ?? null : store.active;
  notifyForgotten(url);
  writeStore({ v: 2, servers: next, active });
}
