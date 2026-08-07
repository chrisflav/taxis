import { useEffect, useState } from "react";
import type { Health } from "../types";
import { api } from "../api";
import {
  apiToken,
  connectTo,
  isConfigured,
  isPrivateHost,
  normalizeServerUrl,
  serverOrigin,
} from "../server";
import { PageHeader } from "./PageHeader";

/**
 * The one screen that exists only in the packaged app: which taxis is this, and who am I on it.
 *
 * In a browser neither question is asked — the app was served by the tracker it belongs to, and the
 * session cookie says who you are. Packaged, both have to be answered before anything can be read,
 * so this is the app's front door and it is worth it being an honest one: it *checks* the address
 * rather than accepting it, it says what it found there, and it names the two things it cannot do
 * (OAuth, and a password sign-in) rather than showing buttons that would not work.
 */

type Probe =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; url: string; health: Health }
  | { state: "failed"; url: string; error: string };

/** Ask a candidate server what it is, without a credential — `/api/health` needs none. */
async function probe(url: string): Promise<Health> {
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

export function ServerConnect() {
  const current = serverOrigin();
  const [address, setAddress] = useState(current);
  const [token, setToken] = useState(apiToken() ?? "");
  const [result, setResult] = useState<Probe>({ state: "idle" });
  const [identity, setIdentity] = useState<{ checking: boolean; name?: string; error?: string }>({
    checking: false,
  });

  // Re-checking is what the button does; changing the address invalidates the previous answer
  // rather than leaving a green tick next to a different URL.
  useEffect(() => setResult({ state: "idle" }), [address]);
  useEffect(() => setIdentity({ checking: false }), [token, address]);

  const normalized = normalizeServerUrl(address);
  const cleartext = normalized?.startsWith("http://") ?? false;
  const host = normalized ? normalized.replace(/^https?:\/\//, "").split(/[:/]/)[0] : "";

  const check = async () => {
    if (!normalized) {
      setResult({ state: "failed", url: address, error: "that is not an address" });
      return;
    }
    setResult({ state: "checking" });
    try {
      setResult({ state: "ok", url: normalized, health: await probe(normalized) });
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

  const save = () => {
    if (!normalized) return;
    connectTo(normalized, token.trim() || null);
  };

  const disconnect = () => connectTo(null, null);

  return (
    <>
      <PageHeader
        title={isConfigured() ? "Server" : "Connect to taxis"}
        description={
          isConfigured()
            ? "Which tracker this app is showing, and the token it reads and writes with."
            : "This app is a taxis client. Point it at your tracker to get started."
        }
      />

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

        <div className="row">
          <button onClick={check} disabled={!normalized || result.state === "checking"}>
            {result.state === "checking" ? "Checking…" : "Check connection"}
          </button>
        </div>

        {result.state === "ok" && (
          <p className="notice small">
            Reached taxis {result.health.version || "(version not reported)"} at{" "}
            <span className="mono">{result.url}</span>.
          </p>
        )}
        {result.state === "failed" && (
          <p className="error small">Could not reach {result.url} — {result.error}.</p>
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
          server's own origin, which an app running from your device cannot use.
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
        <button className="primary" onClick={save} disabled={!normalized}>
          {isConfigured() ? "Save and reload" : "Connect"}
        </button>
        {isConfigured() && <button className="danger" onClick={disconnect}>Disconnect</button>}
        <span className="spacer" />
        <a href={api.docsUrl} target="_blank" rel="noreferrer" className="small muted">
          API reference ↗
        </a>
      </div>

      {isConfigured() && (
        <p className="small muted">
          Changing the server discards anything still queued to be sent — those changes belong to the
          tracker they were made on.
        </p>
      )}
    </>
  );
}
