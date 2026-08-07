/**
 * Which taxis this app is talking to, and how it proves who it is.
 *
 * The web app and the packaged app are the same application — same components, same views, same
 * offline queue. Exactly two things differ between them, and both are answered here:
 *
 *   - **Where the server is.** In a browser the app is served *by* the server, so the API is at
 *     `/api` on its own origin and there is nothing to configure. Packaged, the app is served from
 *     the device, so it has to be told which taxis it belongs to — and, since a phone is one device
 *     used against several trackers, it holds a *list* of them and one that is current.
 *   - **How it authenticates.** In a browser that is the session cookie the server set, and it
 *     rides along on its own. Packaged, requests are cross-origin: the server answers with
 *     `Access-Control-Allow-Origin: *`, which the fetch spec forbids combining with credentials,
 *     and a `SameSite=Lax` cookie would not be sent cross-site anyway. So the packaged app carries
 *     an API token — the same personal access token a bot uses, minted under **Tokens** in the web
 *     UI — as `Authorization: Bearer`. Each server has its own, because a token is issued by one
 *     tracker and means nothing to another.
 *
 * Everything above `api.ts` is unaware of all of it, which is the point.
 */

declare global {
  interface Window {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }
}

/**
 * Whether this is the packaged app rather than a page served by a taxis server.
 *
 * Answered at build time in both real builds, and that is the point rather than an optimisation.
 * Vite substitutes the flag as a literal, so each branch below collapses to a constant and the
 * bundler deletes the other side: the web build carries none of the server list, the migration or
 * the switcher — several kilobytes of a chunk every page load waits for, in aid of a screen a
 * browser can never reach. The packaged build likewise carries no "am I packaged" test.
 *
 * The runtime check is the fallback for the one case with no flag: `npm run dev`, or a Capacitor
 * shell running a bundle that was not built for it, which would otherwise look like a browser and
 * go looking for an API on the device. It is also what the tests use to exercise both builds.
 */
const PACKAGED_FLAG = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_TAXIS_PACKAGED;

export const isNativeApp: boolean =
  PACKAGED_FLAG === "1"
    ? true
    : PACKAGED_FLAG === "0"
      ? false
      : typeof window !== "undefined" && window.Capacitor?.isNativePlatform?.() === true;

/**
 * One tracker the app knows about.
 *
 * The **URL is the identity**. Two entries for one origin would be two names for one tracker, and
 * everything scoped to a server — its token, its queue of unsent writes — is scoped by where it is.
 * Editing an entry's address therefore makes it a different server, which is the honest reading:
 * work queued against the old address was queued against a different tracker.
 */
export interface ServerProfile {
  /** Normalised origin, e.g. `https://taxis.example.org` or `http://192.168.1.10:8080`. */
  url: string;
  /** What to call it in the switcher. Defaults to the host. */
  label: string;
  /** The API token used against this server, or null to browse it read-only. */
  token: string | null;
}

export interface ServerStore {
  v: 2;
  servers: ServerProfile[];
  /** The `url` of the current server, or null before one is chosen. */
  active: string | null;
}

const STORE_KEY = "taxis.servers";
/** The single-server keys this replaced; read once, to migrate, then removed. */
const V1_SERVER_KEY = "taxis.serverUrl";
const V1_TOKEN_KEY = "taxis.apiToken";

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

const EMPTY: ServerStore = { v: 2, servers: [], active: null };

function isProfile(value: unknown): value is ServerProfile {
  const p = value as ServerProfile | null;
  return !!p && typeof p.url === "string" && p.url !== "" && typeof p.label === "string";
}

/**
 * Read the store, migrating a single-server install on the way.
 *
 * Parsed defensively rather than trusted: this is storage an older build wrote, and a shape it does
 * not recognise must degrade to "no servers configured" — which shows the connect screen — rather
 * than throwing on every read and leaving the app with no way to be pointed anywhere.
 */
function load(): ServerStore {
  const raw = read(STORE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ServerStore;
      if (parsed && Array.isArray(parsed.servers)) {
        const servers = parsed.servers.filter(isProfile).map((p) => ({ ...p, token: p.token ?? null }));
        const active = servers.some((s) => s.url === parsed.active) ? parsed.active : servers[0]?.url ?? null;
        return { v: 2, servers, active };
      }
    } catch {
      /* Fall through to the migration, then to empty. */
    }
  }
  const legacyUrl = read(V1_SERVER_KEY);
  if (legacyUrl) {
    const migrated: ServerStore = {
      v: 2,
      servers: [{ url: legacyUrl, label: labelFor(legacyUrl), token: read(V1_TOKEN_KEY) }],
      active: legacyUrl,
    };
    save(migrated);
    write(V1_SERVER_KEY, null);
    write(V1_TOKEN_KEY, null);
    return migrated;
  }
  return EMPTY;
}

function save(store: ServerStore): void {
  write(STORE_KEY, JSON.stringify(store));
}


/** The default name for a server: its host, which is how people refer to one anyway. */
export function labelFor(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * The store, read once and then held.
 *
 * Lazy and gated, and both matter. Gated because a browser has no list — `isNativeApp` is a
 * build-time constant, so this collapses to `EMPTY` and the bundler deletes `load`, the migration
 * and everything they reach rather than shipping them in the chunk every page load waits for. Lazy
 * because a module-level read would run before that folding could help.
 */
export function readStore(): ServerStore {
  if (cached) return cached;
  cached = !isNativeApp || typeof window === "undefined" ? EMPTY : load();
  return cached;
}

let cached: ServerStore | null = null;

/**
 * Write the store and reload.
 *
 * The reload is the point, not a shortcut. The response cache, every view's state and the naming
 * index all hold data read from the server that was current a moment ago; a reload is the one
 * operation guaranteed to leave none of it behind. What it does *not* discard is the unsent work,
 * because that is scoped per server (see `serverScope`) and stays with the one it was made against.
 */
export function writeStore(next: ServerStore): void {
  cached = next;
  save(next);
  window.location.hash = "#/issues";
  window.location.reload();
}

/** The server the app is currently showing, or null before one is chosen. */
export function activeServer(): ServerProfile | null {
  const store = readStore();
  return store.servers.find((s) => s.url === store.active) ?? null;
}

/**
 * The origin the app talks to: empty in a browser, meaning "wherever this page came from".
 *
 * Empty is also what the packaged app returns before it has been pointed at a server, which is why
 * `isConfigured` exists rather than callers testing this for emptiness — on the web an empty base
 * is the normal, working state.
 */
export function serverOrigin(): string {
  return activeServer()?.url ?? "";
}

/** The base every API path is appended to. */
export function apiBase(): string {
  return serverOrigin() + "/api";
}

/** Whether the app knows which server it belongs to. Always true in a browser. */
export function isConfigured(): boolean {
  return !isNativeApp || activeServer() != null;
}

export function apiToken(): string | null {
  return activeServer()?.token ?? null;
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
 * What distinguishes one server's stored state from another's.
 *
 * Empty in a browser, which is what keeps the storage keys of the web app byte-for-byte what they
 * were before any of this existed — a returning reader's unsent work is still theirs. In the app it
 * is the active server's URL, so each tracker gets its own queue and switching between two of them
 * is not a reason to throw either away.
 */
export function serverScope(): string {
  const url = serverOrigin();
  return url ? `:${url}` : "";
}

/**
 * Tell the modules that keep server-scoped state that a server is gone for good.
 *
 * This module deliberately knows nothing about what is stored against a server — that would make
 * the one piece of configuration every other module reads depend on all of them. Instead each
 * module says so from its own side: `offline.ts` registers the disposal of that server's queue,
 * because a queued write belongs to the tracker it was made against and there is nowhere left to
 * send it.
 */
export function onServerForgotten(fn: (scope: string) => void): void {
  forgetHooks.push(fn);
}

/** Called by `serverList.ts` when an entry is removed or its address moved. */
export function notifyForgotten(url: string): void {
  for (const hook of forgetHooks) hook(`:${url}`);
}

const forgetHooks: Array<(scope: string) => void> = [];
