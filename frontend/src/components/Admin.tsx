import { useEffect, useState } from "react";
import type { Actor, Group } from "../types";
import { api } from "../api";
import { Modal, ConfirmModal } from "./Modal";
import { MultiSelect } from "./MultiSelect";

export function Admin() {
  const [groups, setGroups] = useState<Group[]>([]);
  const loadGroups = () => api.listGroups().then(setGroups).catch(() => {});
  useEffect(() => { loadGroups(); }, []);

  return (
    <div>
      <h2>Admin</h2>
      <div className="grid-2">
        <ActorsPanel groups={groups} />
        <GroupsPanel groups={groups} onChange={loadGroups} />
      </div>
      <ImportPanel />
    </div>
  );
}

function ActorsPanel({ groups }: { groups: Group[] }) {
  const [actors, setActors] = useState<Actor[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Actor | "new" | null>(null);
  const [deleting, setDeleting] = useState<Actor | null>(null);

  const load = () => api.listActors().then(setActors).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  const groupName = (id: number) => groups.find((g) => g.id === id)?.name ?? `#${id}`;

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Actors</h3>
        <button onClick={() => setEditing("new")}>+ Add actor</button>
      </div>
      {err && <div className="error small">{err}</div>}
      <table>
        <tbody>
          {actors.map((a) => (
            <tr key={a.id}>
              <td className="muted">{a.id}</td>
              <td>
                {a.displayName} {a.admin && <span className="badge">admin</span>}
                <div className="muted small">{a.email}</div>
                {a.groups.length > 0 && (
                  <div>{a.groups.map((g) => <span key={g} className="chip">{groupName(g)}</span>)}</div>
                )}
              </td>
              <td className="row">
                <button onClick={() => setEditing(a)}>Edit</button>
                <button className="danger" onClick={() => setDeleting(a)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
    </div>
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
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { email, displayName: displayName || email, groups: groupIds, admin };
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
          <input type="checkbox" style={{ width: "auto" }} checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Administrator
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
  const [adding, setAdding] = useState(false);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Groups</h3>
        <button onClick={() => setAdding(true)}>+ Add group</button>
      </div>
      <table>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}><td className="muted">{g.id}</td><td>{g.name}</td><td className="muted small">{g.description ?? ""}</td></tr>
          ))}
        </tbody>
      </table>
      {adding && <GroupModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChange(); }} />}
    </div>
  );
}

function GroupModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    api.createGroup({ name, description: description || undefined }).then(onSaved).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title="Add group" onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <label>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Add</button>
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
