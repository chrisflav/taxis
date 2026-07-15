import { useState, useEffect } from "react";
import type { Actor } from "../types";
import { api } from "../api";
import { ActorName } from "./ActorName";
import { Modal } from "./Modal";

export function LoginBar({ me, onChange }: { me: Actor | null; onChange: () => void }) {
  const [centralPasswordEnabled, setCentralPasswordEnabled] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  useEffect(() => {
    api.health().then(h => {
      setCentralPasswordEnabled(!!h.centralPasswordEnabled);
      setGoogleEnabled(!!h.googleEnabled);
    }).catch(console.error);
  }, []);

  if (me) {
    return (
      <div className="row">
        <span className="muted small"><ActorName name={me.displayName} bot={me.bot} /></span>
        <button onClick={() => api.logout().then(onChange)}>Sign out</button>
      </div>
    );
  }

  return (
    <div className="row">
      {googleEnabled && <a href={api.googleLoginUrl}><button>Sign in with Google</button></a>}
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
