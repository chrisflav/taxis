import { useState, useEffect, useRef } from "react";
import type { Actor, Session } from "../types";
import { api } from "../api";
import { isNativeApp } from "../server";
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
          {isNativeApp && <a role="menuitem" href="#/connect" onClick={() => setOpen(false)}>Server</a>}
          <a role="menuitem" href={api.docsUrl} target="_blank" rel="noreferrer">API reference ↗</a>
          {/* Signing out of the packaged app means giving up its token, which is a property of the
              connection rather than of a session — so it lives on the same screen the token was
              entered on, next to the server it belongs to. */}
          {isNativeApp
            ? <a role="menuitem" href="#/connect" onClick={() => setOpen(false)}>Sign out…</a>
            : <button role="menuitem" onClick={() => { setOpen(false); api.logout().then(onChange); }}>Sign out</button>}
        </div>
      )}
    </div>
  );
}

// Which sign-in methods exist is server configuration, and it arrives with the answer to "who is
// signed in" — the same request, because they are the same question about the same corner of the
// bar. This used to be a second request to `/health` on every page load.
export function LoginBar({ me, auth, onChange }: { me: Actor | null; auth: Session | null; onChange: () => void }) {
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  if (me) return <AccountMenu me={me} onChange={onChange} />;

  // Every sign-in the server offers ends with a cookie on the *server's* origin: the two OAuth
  // flows redirect a browser there, and the password form is answered with a `Set-Cookie`. The
  // packaged app runs from the device, so none of those cookies would ever be sent back with its
  // requests — showing the buttons would be offering three things that cannot work. It carries an
  // API token instead, and that is entered on the connect screen.
  if (isNativeApp) {
    return <a href="#/connect"><button>Sign in</button></a>;
  }

  const googleEnabled = !!auth?.googleEnabled;
  const githubEnabled = !!auth?.githubEnabled;
  const centralPasswordEnabled = !!auth?.centralPasswordEnabled;

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
