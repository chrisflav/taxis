import { useEffect, useState } from "react";
import type { Actor, Label } from "../types";
import { api } from "../api";
import { Modal, ConfirmModal } from "./Modal";
import { LabelChip } from "./LabelChip";

const DEFAULT_COLOR = "#6b7280";

export function LabelsPage({ me }: { me: Actor | null }) {
  const isAdmin = !!me?.admin;
  const [labels, setLabels] = useState<Label[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Label | "new" | null>(null);
  const [deleting, setDeleting] = useState<Label | null>(null);

  const load = () => api.listLabels().then(setLabels).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>Labels</h2>
        {isAdmin && <button className="primary" onClick={() => setEditing("new")}>+ Add label</button>}
      </div>
      <p className="muted small">Labels are reusable across issues. Each has a name, an optional description, and a colour.</p>
      {err && <div className="panel error">{err}</div>}

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead><tr><th style={{ width: 50 }}>#</th><th>Label</th><th>Description</th><th style={{ width: 140 }}></th></tr></thead>
          <tbody>
            {labels.map((l) => (
              <tr key={l.id}>
                <td className="muted">{l.id}</td>
                <td><LabelChip label={l} /></td>
                <td className="muted">{l.description ?? "—"}</td>
                <td className="row">
                  {isAdmin && <button onClick={() => setEditing(l)}>Edit</button>}
                  {isAdmin && <button className="danger" onClick={() => setDeleting(l)}>Delete</button>}
                </td>
              </tr>
            ))}
            {labels.length === 0 && <tr><td colSpan={4} className="muted" style={{ textAlign: "center", padding: 24 }}>No labels yet</td></tr>}
          </tbody>
        </table>
      </div>

      {editing && (
        <LabelModal
          label={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete label"
          message={`Delete label "${deleting.name}"? It will be removed from all issues.`}
          confirmLabel="Delete"
          danger
          onConfirm={() => api.deleteLabel(deleting.id).then(() => { setDeleting(null); load(); })}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function LabelModal({ label, onClose, onSaved }: { label: Label | null; onClose: () => void; onSaved: () => void }) {
  const editing = label != null;
  const [name, setName] = useState(label?.name ?? "");
  const [description, setDescription] = useState(label?.description ?? "");
  const [color, setColor] = useState(label?.color ?? DEFAULT_COLOR);
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const body = { name, description: description || undefined, color };
    const p = editing ? api.updateLabel(label!.id, body) : api.createLabel(body);
    p.then(onSaved).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title={editing ? "Edit label" : "Add label"} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        <label>Description</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
        <label>Colour</label>
        <div className="row">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 48, height: 34, padding: 2 }} />
          <input value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 120 }} />
          <LabelChip label={{ name: name || "preview", color, description }} />
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">{editing ? "Save" : "Add"}</button>
        </div>
      </form>
    </Modal>
  );
}
