import { useEffect, useState } from "react";
import { PageHeader } from "./PageHeader";
import { PAGE_META } from "../pages";
import type { Actor, ApiToken } from "../types";
import { api } from "../api";
import { ConfirmModal } from "./Modal";

// Manage the signed-in actor's personal access tokens. The plaintext secret is shown exactly
// once, right after creation; afterwards only a recognisable prefix is stored.
export function TokensPage({ me }: { me: Actor | null }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);

  const load = () => api.listTokens().then(setTokens).catch((e) => setErr(String(e)));
  useEffect(() => { if (me) load(); }, [me?.id]);

  if (!me) return <div className="panel muted">Sign in to manage API tokens.</div>;

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    api.createToken(name.trim())
      .then((res) => { setFreshSecret(res.secret); setCopied(false); setName(""); load(); })
      .catch((e2) => setErr(String(e2)));
  };

  const fmt = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "never");

  return (
    <div>
      <PageHeader {...PAGE_META.tokens} />
      {err && <div className="panel error">{err}</div>}

      {freshSecret && (
        <div className="panel" style={{ borderColor: "var(--accent)" }}>
          <strong>New token — copy it now, it won't be shown again:</strong>
          <div className="row" style={{ marginTop: 8 }}>
            <code className="token-secret">{freshSecret}</code>
            <button
              onClick={() => { navigator.clipboard?.writeText(freshSecret); setCopied(true); }}
            >{copied ? "Copied ✓" : "Copy"}</button>
            <button onClick={() => setFreshSecret(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <form className="panel row" onSubmit={create}>
        <input placeholder="Token name (e.g. ci-bot)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" type="submit">Create token</button>
      </form>

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead><tr><th style={{ width: 50 }}>#</th><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id}>
                <td className="muted">{t.id}</td>
                <td>{t.name || <span className="muted">(unnamed)</span>}</td>
                <td><code className="small">{t.tokenPrefix}…</code></td>
                <td className="muted small">{fmt(t.createdAt)}</td>
                <td className="muted small">{fmt(t.lastUsed)}</td>
                <td><button className="danger" onClick={() => setRevoking(t)}>Revoke</button></td>
              </tr>
            ))}
            {tokens.length === 0 && (
              <tr><td colSpan={6} className="muted" style={{ textAlign: "center", padding: 24 }}>No tokens yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {revoking && (
        <ConfirmModal
          title="Revoke token"
          message={`Revoke token "${revoking.name || revoking.tokenPrefix}"? Anything using it will stop working immediately.`}
          confirmLabel="Revoke"
          danger
          onConfirm={() => api.deleteToken(revoking.id).then(() => { setRevoking(null); load(); })}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
