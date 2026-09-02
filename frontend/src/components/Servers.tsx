import { useEffect, useState } from "react";
import type { Health } from "../types";
import { api } from "../api";
import { checkCompatibility, type Compatibility } from "../compat";
import { mirrorAvailable } from "../mirror";
import { queuedCountFor, useOfflineState } from "../offline";
import { activeServer, type ServerProfile } from "../server";
import {
  isPrivateHost,
  labelFor,
  normalizeServerUrl,
  removeServer,
  saveServer,
  servers,
  switchToServer,
} from "../serverList";
import { syncNow, useSyncState } from "../sync";
import { Modal } from "./Modal";
import { PageHeader } from "./PageHeader";

/**
 * The one screen that exists only in the packaged app: which trackers this app knows, and which one
 * it is showing.
 *
 * In a browser neither question is asked — the app was served by the tracker it belongs to, and the
 * session cookie says who you are. Packaged, both have to be answered, and a phone is one device
 * used against several trackers: a personal one, a work one, a local one on the desk. So this is a
 * list rather than a setting, and switching is one tap rather than retyping an address.
 *
 * It is worth this screen being an honest one: it *checks* an address rather than accepting it, it
 * says what it found there and whether that server is new enough for this build, and it names the
 * sign-ins it cannot offer instead of showing buttons that would not work.
 */

type Probe =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; url: string; health: Health; compat: Compatibility }
  | { state: "failed"; url: string; error: string };

/** "a, b and c" — a list read as a sentence, because that is where it appears. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Ask a candidate server what it is, without a credential — `/api/health` needs none. */
async function probeHealth(url: string): Promise<Health> {
  const res = await fetch(url + "/api/health", { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const data = text ? JSON.parse(text) : null;
  if (!data || typeof data.status !== "string") throw new Error("that is not a taxis server");
  return data as Health;
}

/** Check a token by using it: `/api/session` answers with the actor it belongs to. */
async function whoami(url: string, token: string): Promise<string | null> {
  const res = await fetch(url + "/api/session", {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`the server answered ${res.status}`);
  const data = JSON.parse((await res.text()) || "null");
  return data?.actor?.displayName ?? data?.actor?.email ?? null;
}

// ---------------------------------------------------------------------------------------------
// Adding and editing one server

function ServerForm({
  editing,
  onDone,
  onCancel,
}: {
  /** The entry being changed, or null to add one. */
  editing: ServerProfile | null;
  onDone: () => void;
  onCancel: (() => void) | null;
}) {
  const [address, setAddress] = useState(editing?.url ?? "");
  const [label, setLabel] = useState(editing?.label ?? "");
  const [token, setToken] = useState(editing?.token ?? "");
  const [result, setResult] = useState<Probe>({ state: "idle" });
  const [identity, setIdentity] = useState<{ checking: boolean; name?: string; error?: string }>({
    checking: false,
  });

  // Re-checking is what the button does; changing the address invalidates the previous answer
  // rather than leaving a verdict standing next to a different URL.
  useEffect(() => setResult({ state: "idle" }), [address]);
  useEffect(() => setIdentity({ checking: false }), [token, address]);

  const normalized = normalizeServerUrl(address);
  const cleartext = normalized?.startsWith("http://") ?? false;
  const host = normalized ? normalized.replace(/^https?:\/\//, "").split(/[:/]/)[0] : "";
  const duplicate =
    normalized != null &&
    normalized !== editing?.url &&
    servers().some((s) => s.url === normalized);

  const check = async () => {
    if (!normalized) {
      setResult({ state: "failed", url: address, error: "that is not an address" });
      return;
    }
    setResult({ state: "checking" });
    try {
      // Reachability and *usability* are two questions, and the second one is why this screen
      // checks at all: the app ships separately from the server now, so a server can be perfectly
      // reachable and still not have the endpoints this build was written against.
      const health = await probeHealth(normalized);
      const compat = await checkCompatibility(normalized, token.trim() || null);
      setResult({ state: "ok", url: normalized, health, compat });
    } catch (e) {
      setResult({
        state: "failed",
        url: normalized,
        error: e instanceof Error ? e.message : "could not reach it",
      });
    }
  };

  const checkToken = async () => {
    if (!normalized || !token.trim()) return;
    setIdentity({ checking: true });
    try {
      const name = await whoami(normalized, token.trim());
      setIdentity({
        checking: false,
        name: name ?? undefined,
        error: name ? undefined : "the server did not recognise that token",
      });
    } catch (e) {
      setIdentity({ checking: false, error: e instanceof Error ? e.message : "could not check it" });
    }
  };

  const submit = () => {
    if (!normalized || duplicate) return;
    saveServer(
      { url: normalized, label: label.trim() || labelFor(normalized), token: token.trim() || null },
      editing?.url,
    );
    onDone();
  };

  return (
    <>
      <div className="panel">
        <label htmlFor="server-address">Server address</label>
        <input
          id="server-address"
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="taxis.example.org"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <p className="small muted">
          The address you would open in a browser. Without a scheme, a private or on-device address
          is assumed to be <span className="mono">http</span> and anything else{" "}
          <span className="mono">https</span>.
          {normalized && normalized !== address.trim() && (
            <> Reading it as <span className="mono">{normalized}</span>.</>
          )}
        </p>

        <label htmlFor="server-label">Name</label>
        <input
          id="server-label"
          type="text"
          placeholder={normalized ? labelFor(normalized) : "Work"}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <p className="small muted">What to call it in the switcher. Its host, if you leave this blank.</p>

        <div className="row">
          <button onClick={check} disabled={!normalized || result.state === "checking"}>
            {result.state === "checking" ? "Checking…" : "Check connection"}
          </button>
        </div>

        {duplicate && (
          <p className="error small">
            That server is already in the list — switch to it instead of adding it twice.
          </p>
        )}
        {result.state === "ok" && (
          <p className="notice small">
            Reached taxis {result.health.version || "(version not reported)"} at{" "}
            <span className="mono">{result.url}</span>.
          </p>
        )}
        {result.state === "failed" && (
          <p className="error small">Could not reach {result.url} — {result.error}.</p>
        )}
        {/* The verdict that actually decides whether the app will work. A server can answer
            `/api/health` perfectly and still be older than the endpoints this build calls, in which
            case the issue list comes back empty and the error describes a routing accident. Better
            said here, next to the address, than discovered later as a blank screen. */}
        {result.state === "ok" && result.compat.missing.length > 0 && (
          <p className="error small">
            This server is older than the app: it does not have {listOf(result.compat.missing)}.
            Update it to <span className="mono">{result.compat.needs}</span> or newer — until then
            the issue list will be empty.
          </p>
        )}
        {result.state === "ok" && result.compat.missing.length === 0 && (
          <p className="small muted">It has every endpoint this build of the app needs.</p>
        )}
        {cleartext && !isPrivateHost(host) && (
          <p className="error small">
            This address is plain <span className="mono">http</span>, so your token and everything
            you read travel unencrypted. Use <span className="mono">https</span> for a server that
            is not on your own network.
          </p>
        )}
      </div>

      <div className="panel">
        <label htmlFor="server-token">Access token</label>
        <input
          id="server-token"
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="taxis_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="small muted">
          Create one in the web app under <strong>Tokens</strong> — the secret is shown once, at
          creation. A token is how this app signs in: the browser sign-ins put a cookie on the
          server's own origin, which an app running from your device cannot use. Each server has its
          own, since a token is issued by one tracker and means nothing to another.
        </p>
        <div className="row">
          <button onClick={checkToken} disabled={!normalized || !token.trim() || identity.checking}>
            {identity.checking ? "Checking…" : "Check token"}
          </button>
          {normalized && (
            <a href={`${normalized}/#/tokens`} target="_blank" rel="noreferrer">
              <button>Open Tokens ↗</button>
            </a>
          )}
        </div>
        {identity.name && <p className="notice small">Signed in as {identity.name}.</p>}
        {identity.error && <p className="error small">{identity.error}</p>}
        {!token.trim() && (
          <p className="small muted">
            Leave it empty to browse without signing in. taxis lets anyone read, so the app works —
            you just cannot change anything, and issues restricted to a group stay hidden.
          </p>
        )}
      </div>

      <div className="row">
        <button className="primary" onClick={submit} disabled={!normalized || duplicate}>
          {editing ? "Save and switch" : "Connect"}
        </button>
        {onCancel && <button onClick={onCancel}>Cancel</button>}
        <span className="spacer" />
        <a href={api.docsUrl} target="_blank" rel="noreferrer" className="small muted">
          API reference ↗
        </a>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The list

function ServerRow({
  server,
  active,
  onEdit,
  onRemove,
}: {
  server: ServerProfile;
  active: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="panel server-row">
      <div className="server-row-main">
        <div className="row">
          <strong>{server.label}</strong>
          {active && <span className="badge">Showing</span>}
          {!server.token && <span className="badge">Read-only</span>}
        </div>
        <div className="mono small faint">{server.url}</div>
      </div>
      <div className="row">
        {!active && (
          <button className="primary" onClick={() => switchToServer(server.url)}>
            Switch
          </button>
        )}
        <button onClick={onEdit}>Edit</button>
        <button className="danger" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

/** "5m", "3h", "2d" — enough to answer "is this copy from today or from last week?". */
function since(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * What of the active tracker is held on the device.
 *
 * Here rather than in the top bar because it is a fact about a *server*, and this is the screen
 * about servers. The top bar says what is not on the server yet; this says what is not on the
 * server *only* — the copy that makes the issue list work in a tunnel.
 *
 * The button exists for the case the triggers cannot cover: somebody about to get on a plane, who
 * would rather not find out in the air whether the last sync was five minutes or five days ago.
 */
function OfflineCopy() {
  const { syncing, stored, complete, syncedAt, live, error } = useSyncState();
  const { offline } = useOfflineState();
  if (!mirrorAvailable) return null;
  return (
    <div className="panel">
      <div className="row">
        <strong>On this device</strong>
        {syncing && <span className="badge">Syncing…</span>}
        {/* Whether changes arrive by themselves. Worth saying because it is the difference between
            a copy that is current and one that is as old as the last time something asked. */}
        {!syncing && live && <span className="badge">Live</span>}
      </div>
      <p className="small muted">
        {stored === 0
          ? "No issues stored yet. This app keeps a copy of every issue you can see, so the list, its filters and its search go on working with no connection."
          : `${stored} issue${stored === 1 ? "" : "s"} stored${
              complete ? "" : ", the most recently updated ones — this tracker is larger than the app keeps"
            }.${syncedAt ? ` Synced ${since(syncedAt)}.` : ""}`}
      </p>
      {stored > 0 && live && (
        <p className="small muted">
          Connected to this tracker's change stream, so edits made elsewhere arrive as they happen.
        </p>
      )}
      {error && <p className="small error">The last sync did not finish: {error}</p>}
      <div className="row">
        {/* Disabled rather than silently doing nothing while there is no connection: a sync needs a
            server to walk, and a button that answers a tap with no change is worse than one that
            says why it cannot. */}
        <button
          onClick={() => void syncNow(true)}
          disabled={syncing || offline}
          title={offline ? "No connection to the server." : "Bring the copy on this device up to date."}
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>
    </div>
  );
}

export function Servers() {
  const configured = servers();
  const active = activeServer();
  // `null` closed, `{server: null}` adding, `{server}` editing — one piece of state, so the form is
  // never open for two things at once.
  const [editor, setEditor] = useState<{ server: ServerProfile | null } | null>(null);
  const [removing, setRemoving] = useState<ServerProfile | null>(null);

  // Nothing configured at all: this is the app's front door, and a list with a "+" on it would be
  // one tap in the way of the only thing there is to do.
  if (configured.length === 0) {
    return (
      <>
        <PageHeader
          title="Connect to taxis"
          description="This app is a taxis client. Point it at your tracker to get started."
        />
        <ServerForm editing={null} onDone={() => {}} onCancel={null} />
      </>
    );
  }

  if (editor) {
    return (
      <>
        <PageHeader
          title={editor.server ? `Edit ${editor.server.label}` : "Add a server"}
          description={
            editor.server
              ? "Changing the address makes this a different tracker: anything queued against the old one is dropped."
              : "Another taxis to switch between. Each keeps its own token and its own unsent work."
          }
        />
        <ServerForm
          editing={editor.server}
          onDone={() => setEditor(null)}
          onCancel={() => setEditor(null)}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Servers"
        description="The trackers this app knows about. Switching reloads onto the other one; each keeps its own token and its own queue of unsent changes."
        actions={<button className="primary" onClick={() => setEditor({ server: null })}>Add a server</button>}
      />
      {configured.map((s) => (
        <ServerRow
          key={s.url}
          server={s}
          active={s.url === active?.url}
          onEdit={() => setEditor({ server: s })}
          onRemove={() => setRemoving(s)}
        />
      ))}
      <OfflineCopy />
      {removing && (
        <Modal title={`Remove ${removing.label}?`} onClose={() => setRemoving(null)}>
          <p>
            The app will forget <span className="mono">{removing.url}</span> and its token. Nothing
            on the server itself changes — the token stays valid until you revoke it under{" "}
            <strong>Tokens</strong> there.
          </p>
          {/* Named because it is the only thing here that cannot be undone by adding the server
              back: a queued write is the only copy of that change in existence. */}
          {queuedCountFor(`:${removing.url}`) > 0 && (
            <p className="error">
              {queuedCountFor(`:${removing.url}`)} change(s) queued against it have not reached the
              server yet, and will be lost. Switch to it and let them send first if you want them.
            </p>
          )}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button onClick={() => setRemoving(null)}>Cancel</button>
            <button className="danger" onClick={() => { removeServer(removing.url); setRemoving(null); }}>
              Remove
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
