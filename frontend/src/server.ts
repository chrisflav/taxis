/**
 * Where the API is, and how this build proves who it is.
 *
 * The web app and the packaged app are the same application — same components, same views, same
 * offline queue. Exactly two things differ between them, and both are answered here:
 *
 *   - **Where the server is.** In a browser the app is served *by* the server, so the API is at
 *     `/api` on its own origin and there is nothing to configure. Packaged, the app is served from
 *     the device, so it has to be told which taxis it belongs to.
 *   - **How it authenticates.** In a browser that is the session cookie the server set, and it
 *     rides along on its own. Packaged, requests are cross-origin: the server answers with
 *     `Access-Control-Allow-Origin: *`, which the fetch spec forbids combining with credentials,
 *     and a `SameSite=Lax` cookie would not be sent cross-site anyway. So the packaged app carries
 *     an API token — the same personal access token a bot uses, minted under **Tokens** in the web
 *     UI — as `Authorization: Bearer`.
 *
 * Everything above `api.ts` is unaware of the distinction, which is the point.
 */

declare global {
  interface Window {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }
}

/**
 * Whether this is the packaged app rather than a page served by a taxis server.
 *
 * Two signals, because neither alone is enough. The build flag is set by `npm run build:app` and is
 * true for every packaged build whether or not the native bridge has finished setting itself up;
 * the runtime check catches a Capacitor shell running a bundle that was not built for it (`cap run`
 * against a plain `npm run build`), which would otherwise look like a browser and go looking for an
 * API on the device.
 */
export const isNativeApp: boolean =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_TAXIS_PACKAGED === "1" ||
  (typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true);

const SERVER_KEY = "taxis.serverUrl";
const TOKEN_KEY = "taxis.apiToken";

/** Reading `localStorage` throws in a few configurations; a missing value is the right answer. */
function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* Storage is unavailable — the setting simply does not persist. */
  }
}

/**
 * The origin the app talks to: empty in a browser, meaning "wherever this page came from".
 *
 * Empty is also what the packaged app returns before it has been pointed at a server, which is why
 * `isConfigured` exists rather than callers testing this for emptiness — on the web an empty base
 * is the normal, working state.
 */
export function serverOrigin(): string {
  if (!isNativeApp) return "";
  return read(SERVER_KEY) ?? "";
}

/** The base every API path is appended to. */
export function apiBase(): string {
  return serverOrigin() + "/api";
}

/** Whether the app knows which server it belongs to. Always true in a browser. */
export function isConfigured(): boolean {
  return !isNativeApp || serverOrigin() !== "";
}

export function apiToken(): string | null {
  return isNativeApp ? read(TOKEN_KEY) : null;
}

/** The credential the packaged app carries, if any; a browser sends its cookie instead. */
export function authHeaders(): Record<string, string> {
  const token = apiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * A browser sends the session cookie; the packaged app must not ask to, because a response with
 * `Access-Control-Allow-Origin: *` is rejected outright when the request was made with credentials.
 */
export function requestCredentials(): RequestCredentials {
  return isNativeApp ? "omit" : "include";
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
 * Point the app at a server, or at none.
 *
 * Everything the app is holding belongs to the server it was read from — the response cache, the
 * naming index, and the offline queue of writes that have not been sent yet. None of that means
 * anything against a different server, and a queued write must never be replayed to one. So this
 * does not try to reconcile: it stores the new setting and reloads, which is the one operation that
 * is guaranteed to leave no state behind from the previous server.
 */
export function connectTo(serverUrl: string | null, token: string | null): void {
  const changed = serverUrl !== (read(SERVER_KEY) ?? null);
  write(SERVER_KEY, serverUrl);
  write(TOKEN_KEY, token && token.trim() ? token.trim() : null);
  // Only when the *server* changed. Replacing an expired token on the same server leaves any queued
  // work pointing exactly where it was made, and that work should still go out.
  if (changed) for (const hook of serverChangeHooks) hook();
  window.location.hash = "#/issues";
  window.location.reload();
}

/**
 * Run `fn` when the app is pointed at a *different* server, before the reload.
 *
 * This module deliberately knows nothing about what is stored against a server — that would make
 * the one piece of configuration every other module reads depend on all of them. Instead each
 * module that holds server-scoped state says so from its own side: `offline.ts` registers the
 * discard of its queue here, because a queued write belongs to the tracker it was made against and
 * replaying it elsewhere would edit an unrelated issue that happens to share a number.
 */
export function onServerChange(fn: () => void): void {
  serverChangeHooks.push(fn);
}

const serverChangeHooks: Array<() => void> = [];
