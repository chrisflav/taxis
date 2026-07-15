import { useState, useEffect } from "react";
import type { Actor } from "../types";
import { api } from "../api";
import { ActorName } from "./ActorName";

export function LoginBar({ me, onChange }: { me: Actor | null; onChange: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [centralPasswordEnabled, setCentralPasswordEnabled] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);

  useEffect(() => {
    api.health().then(h => setCentralPasswordEnabled(!!h.centralPasswordEnabled)).catch(console.error);
  }, []);

  if (me) {
    return (
      <div className="row">
        <span className="muted small"><ActorName name={me.displayName} bot={me.bot} /></span>
        <button onClick={() => api.logout().then(onChange)}>Sign out</button>
      </div>
    );
  }

  if (showPasswordForm) {
    return (
      <div className="row">
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} />
        <button onClick={() => api.passwordLogin(email, password).then(onChange).catch(e => alert(String(e)))}>Sign In</button>
        <button onClick={() => setShowPasswordForm(false)}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="row">
      <a href={api.googleLoginUrl}><button>Sign in with Google</button></a>
      {centralPasswordEnabled && <button onClick={() => setShowPasswordForm(true)}>Sign in with Password</button>}
    </div>
  );
}
