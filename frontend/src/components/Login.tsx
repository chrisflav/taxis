import { useState, useEffect, useRef } from "react";
import type { Actor } from "../types";
import { api } from "../api";
import { ActorName } from "./ActorName";
import { Modal } from "./Modal";

// Everything that belongs to *you* rather than to the work: your tokens, the admin screens if you
// have them, the API reference, and signing out. These used to sit in the main nav next to Issues
// and Graph, which put four destinations you visit occasionally in the same row as the three you
// move between constantly — and made the bar change width when you signed in.
function AccountMenu({ me, onChange }: { me: Actor; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Initials keep the control a fixed width whatever someone is called.
  const initials = me.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

  return (
    <div className="account" ref={ref}>
      <button
        className="account-button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={me.displayName}
      >
        <span className="avatar">{initials || "?"}</span>
      </button>
      {open && (
        <div className="account-menu" role="menu">
          <div className="account-name">
            <ActorName name={me.displayName} bot={me.bot} />
            <div className="faint small">{me.email}</div>
          </div>
          <a role="menuitem" href="#/tokens" onClick={() => setOpen(false)}>API tokens</a>
          {me.admin && <a role="menuitem" href="#/admin" onClick={() => setOpen(false)}>Admin</a>}
          <a role="menuitem" href="/docs" target="_blank" rel="noreferrer">API reference ↗</a>
          <button role="menuitem" onClick={() => { setOpen(false); api.logout().then(onChange); }}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export function LoginBar({ me, onChange }: { me: Actor | null; onChange: () => void }) {
  const [centralPasswordEnabled, setCentralPasswordEnabled] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  useEffect(() => {
    api.health().then(h => {
      setCentralPasswordEnabled(!!h.centralPasswordEnabled);
      setGoogleEnabled(!!h.googleEnabled);
      setGithubEnabled(!!h.githubEnabled);
    }).catch(console.error);
  }, []);

  if (me) return <AccountMenu me={me} onChange={onChange} />;

  return (
    <div className="row">
      {googleEnabled && <a href={api.googleLoginUrl}><button>Sign in with Google</button></a>}
      {githubEnabled && <a href={api.githubLoginUrl}><button>Sign in with GitHub</button></a>}
      {centralPasswordEnabled && <button onClick={() => setShowPasswordForm(true)}>Sign in with Password</button>}
      {showPasswordForm && (
        <Modal title="Sign in with Password" onClose={() => setShowPasswordForm(false)}>
          <PasswordLoginForm
            onCancel={() => setShowPasswordForm(false)}
            onDone={() => { setShowPasswordForm(false); onChange(); }}
          />
        </Modal>
      )}
    </div>
  );
}

function PasswordLoginForm({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = () => api.passwordLogin(email, password).then(onDone).catch(e => alert(String(e)));

  return (
    <form onSubmit={e => { e.preventDefault(); submit(); }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input type="email" placeholder="Email" value={email} autoFocus
          onChange={e => setEmail(e.target.value)} />
        <input type="password" placeholder="Password" value={password}
          onChange={e => setPassword(e.target.value)} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Sign In</button>
        </div>
      </div>
    </form>
  );
}
