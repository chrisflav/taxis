import type { Actor } from "../types";
import { api } from "../api";

export function LoginBar({ me, onChange }: { me: Actor | null; onChange: () => void }) {
  if (me) {
    return (
      <div className="row">
        <span className="muted small">{me.displayName}</span>
        <button onClick={() => api.logout().then(onChange)}>Sign out</button>
      </div>
    );
  }

  return (
    <div className="row">
      <a href={api.googleLoginUrl}><button>Sign in with Google</button></a>
    </div>
  );
}
