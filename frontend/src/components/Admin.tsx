import { useEffect, useState } from "react";
import { PageHeader } from "./PageHeader";
import type { Actor, ApiToken, Group } from "../types";
import { api } from "../api";
import { Modal, ConfirmModal } from "./Modal";
import { MultiSelect } from "./MultiSelect";
import { Pagination, usePagination } from "./Pagination";
import { ActorName } from "./ActorName";

export function Admin() {
  const [groups, setGroups] = useState<Group[]>([]);
  const loadGroups = () => api.listGroups().then(setGroups).catch(() => {});
  useEffect(() => { loadGroups(); }, []);

  // Actors first, then groups below, each with its own search + pagination.
  return (
    <div>
      <PageHeader
        title="Admin"
        description="Who can sign in, which groups they belong to, and bringing issues in from elsewhere."
      />
      <ActorsPanel groups={groups} />
      <GroupsPanel groups={groups} onChange={loadGroups} />
      <ImportPanel />
    </div>
  );
}

function ActorsPanel({ groups }: { groups: Group[] }) {
  const [actors, setActors] = useState<Actor[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Actor | "new" | null>(null);
  const [deleting, setDeleting] = useState<Actor | null>(null);
  const [tokensFor, setTokensFor] = useState<Actor | null>(null);

  const load = () => api.listActors().then(setActors).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? `#${id}`;

  const q = query.trim().toLowerCase();
  const filtered = actors.filter(
    (a) => !q || a.displayName.toLowerCase().includes(q) || a.email.toLowerCase().includes(q),
  );
  const pager = usePagination(filtered, 10);
  useEffect(() => { pager.setPage(0); }, [q]);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Actors <span className="muted small">({actors.length})</span></h3>
        <button onClick={() => setEditing("new")}>+ Add actor</button>
      </div>
      <input
        placeholder="Search actors by name or email…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginTop: 8 }}
      />
      {err && <div className="error small">{err}</div>}
      <table>
        <tbody>
          {pager.pageItems.map((a) => (
            <tr key={a.id}>
              <td className="cell-id">{a.id}</td>
              <td>
                <ActorName name={a.displayName} bot={a.bot} />{" "}
                {a.admin && <span className="badge">admin</span>}
                <div className="muted small">{a.email}</div>
                {a.groups.length > 0 && (
                  <div>{a.groups.map((g) => <span key={g} className="chip">{groupName(g)}</span>)}</div>
                )}
              </td>
              <td className="cell-actions">
                <div className="row">
                  <button onClick={() => setEditing(a)}>Edit</button>
                  <button onClick={() => setTokensFor(a)}>Tokens</button>
                  <button className="danger" onClick={() => setDeleting(a)}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={3} className="muted small" style={{ padding: 16 }}>No matching actors</td></tr>
          )}
        </tbody>
      </table>
      <Pagination {...pager} />

      {editing && (
        <ActorModal
          actor={editing === "new" ? null : editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete actor"
          message={`Delete actor "${deleting.displayName}"?`}
          confirmLabel="Delete"
          danger
          onConfirm={() => api.deleteActor(deleting.id).then(() => { setDeleting(null); load(); })}
          onCancel={() => setDeleting(null)}
        />
      )}
      {tokensFor && (
        <ActorTokensModal actor={tokensFor} onClose={() => setTokensFor(null)} />
      )}
    </div>
  );
}

// Admin: manage the API tokens of another actor (typically a bot). Creates a token whose secret is
// shown exactly once, and lists the actor's existing tokens.
function ActorTokensModal({ actor, onClose }: { actor: Actor; onClose: () => void }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.listActorTokens(actor.id).then(setTokens).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, [actor.id]);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    api.createActorToken(actor.id, name.trim())
      .then((res) => { setSecret(res.secret); setCopied(false); setName(""); load(); })
      .catch((e2) => setErr(String(e2)));
  };
  const fmt = (ts: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "never");

  return (
    <Modal title={`Tokens for ${actor.displayName}`} onClose={onClose}>
      {err && <div className="error small">{err}</div>}
      <p className="muted small">
        A token authenticates as this actor via <code>Authorization: Bearer &lt;token&gt;</code>. Only a hash
        is stored; the secret is shown once here.
      </p>

      {secret && (
        <div className="panel" style={{ borderColor: "var(--accent)" }}>
          <strong>New token — copy it now, it won't be shown again:</strong>
          <div className="row" style={{ marginTop: 8 }}>
            <code className="token-secret">{secret}</code>
            <button onClick={() => { navigator.clipboard?.writeText(secret); setCopied(true); }}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button onClick={() => setSecret(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <form className="row" onSubmit={create} style={{ marginTop: 8 }}>
        <input placeholder="Token name (e.g. ci-bot)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" type="submit">Create token</button>
      </form>

      <table style={{ marginTop: 12 }}>
        <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th></tr></thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.name || <span className="muted">(unnamed)</span>}</td>
              <td><code className="small">{t.tokenPrefix}…</code></td>
              <td className="muted small">{fmt(t.createdAt)}</td>
              <td className="muted small">{fmt(t.lastUsed)}</td>
            </tr>
          ))}
          {tokens.length === 0 && (
            <tr><td colSpan={4} className="muted small" style={{ padding: 12 }}>No tokens yet</td></tr>
          )}
        </tbody>
      </table>
    </Modal>
  );
}

function ActorModal({ actor, groups, onClose, onSaved }: {
  actor: Actor | null; groups: Group[]; onClose: () => void; onSaved: () => void;
}) {
  const editing = actor != null;
  const [email, setEmail] = useState(actor?.email ?? "");
  const [displayName, setDisplayName] = useState(actor?.displayName ?? "");
  const [groupIds, setGroupIds] = useState<number[]>(actor?.groups ?? []);
  const [admin, setAdmin] = useState(actor?.admin ?? false);
  const [bot, setBot] = useState(actor?.bot ?? false);
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { email, displayName: displayName || email, groups: groupIds, admin, bot };
    const p = editing ? api.updateActor(actor!.id, body) : api.createActor(body);
    p.then(onSaved).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title={editing ? "Edit actor" : "Add actor"} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <label>Display name</label>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <label>Groups</label>
        <MultiSelect
          options={groups.map((g) => ({ value: g.id, label: g.name }))}
          selected={groupIds}
          onChange={setGroupIds}
          placeholder="Assign to groups…"
        />
        <label className="row small" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Administrator
        </label>
        <label className="row small" style={{ marginTop: 6 }}>
          <input type="checkbox" checked={bot} onChange={(e) => setBot(e.target.checked)} /> Bot (shows a 🤖 marker next to the name)
        </label>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">{editing ? "Save" : "Add"}</button>
        </div>
      </form>
    </Modal>
  );
}

function GroupsPanel({ groups, onChange }: { groups: Group[]; onChange: () => void }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = groups.filter(
    (g) => !q || g.name.toLowerCase().includes(q) || (g.description ?? "").toLowerCase().includes(q),
  );
  const pager = usePagination(filtered, 10);
  useEffect(() => { pager.setPage(0); }, [q]);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Groups <span className="muted small">({groups.length})</span></h3>
        <button onClick={() => setEditing("new")}>+ Add group</button>
      </div>
      <input
        placeholder="Search groups…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginTop: 8 }}
      />
      <table>
        <tbody>
          {pager.pageItems.map((g) => (
            <tr key={g.id}>
              <td className="cell-id">{g.id}</td>
              <td>{g.name}</td>
              <td className="muted small">{g.description ?? ""}</td>
              <td className="cell-actions">
                <div className="row">
                  <button onClick={() => setEditing(g)}>Edit</button>
                  <button className="danger" onClick={() => setDeleting(g)}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr><td colSpan={4} className="muted small" style={{ padding: 16 }}>No matching groups</td></tr>
          )}
        </tbody>
      </table>
      <Pagination {...pager} />

      {editing && (
        <GroupModal
          group={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChange(); }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete group"
          message={`Delete group "${deleting.name}"? It will be removed from actors and issue visibility.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => api.deleteGroup(deleting.id).then(() => { setDeleting(null); onChange(); })}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function GroupModal({ group, onClose, onSaved }: { group: Group | null; onClose: () => void; onSaved: () => void }) {
  const editing = group != null;
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name, description: description || undefined };
    const p = editing ? api.updateGroup(group!.id, body) : api.createGroup(body);
    p.then(onSaved).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title={editing ? "Edit group" : "Add group"} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <label>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">{editing ? "Save" : "Add"}</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportPanel() {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const gh = (e: React.FormEvent) => {
    e.preventDefault();
    api.importGithub(owner, repo, "open").then((r) => setMsg(`Imported ${r.imported} GitHub issue(s)`))
      .catch((e2) => setMsg(String(e2)));
  };
  const gd = (e: React.FormEvent) => {
    e.preventDefault();
    api.importGdoc(text).then((r) => setMsg(`Imported ${r.imported} issue(s) from text`))
      .catch((e2) => setMsg(String(e2)));
  };

  return (
    <div className="panel">
      <h3>Import</h3>
      {msg && <div className="small">{msg}</div>}
      <form className="row" onSubmit={gh}>
        <input placeholder="owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
        <input placeholder="repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
        <button type="submit">Import GitHub issues</button>
      </form>
      <form onSubmit={gd} style={{ marginTop: 12 }}>
        <label>One issue per line</label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={"Task one\nTask two"} />
        <button type="submit" style={{ marginTop: 8 }}>Import lines</button>
      </form>
    </div>
  );
}
