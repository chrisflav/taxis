import { useEffect, useState } from "react";
import type { Actor, Group, IssueDetail as Detail, PluginKind, Plugins } from "../types";
import { api } from "../api";
import { Modal, ConfirmModal } from "./Modal";
import { LabelChip } from "./LabelChip";

// Render a Unix (seconds) timestamp in the viewer's locale.
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export function IssueDetail({ id, me }: { id: number; me: Actor | null }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [plugins, setPlugins] = useState<Plugins | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addArtifact, setAddArtifact] = useState(false);
  const [addCheck, setAddCheck] = useState(false);

  const load = () => api.getIssue(id).then(setDetail).catch((e) => setError(String(e)));

  useEffect(() => {
    load();
    api.plugins().then(setPlugins).catch(() => {});
    api.listGroups().then(setGroups).catch(() => {});
  }, [id]);

  if (error) return <div className="panel error">{error}</div>;
  if (!detail) return <div className="muted">Loading…</div>;
  const { issue } = detail;

  const setState = (state: string) => api.updateIssue(id, { state }).then(load).catch((e) => setError(String(e)));
  const del = () => api.deleteIssue(id).then(() => (window.location.hash = "#/issues"));

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>
        #{issue.id} · {issue.title} <span className={`badge ${issue.state}`}>{issue.state}</span>
        {issue.locked && <span title="locked" style={{ marginLeft: 6 }}>🔒</span>}
      </h2>

      <div className="panel">
        <p style={{ whiteSpace: "pre-wrap" }}>{issue.description || <span className="muted">No description</span>}</p>
        {detail.issueLabels.length > 0 && (
          <div className="row" style={{ marginBottom: 8 }}>
            {detail.issueLabels.map((l) => <LabelChip key={l.id} label={l} />)}
          </div>
        )}
        <div className="row small muted">
          <span>Parent: {issue.parent != null
            ? <a href={`#/issues/${issue.parent}`}>#{issue.parent}</a>
            : "none"}</span>
        </div>
        <div className="row small muted" style={{ marginTop: 4 }}>
          <span>Depends on: {issue.dependencies.length ? issue.dependencies.map((p) => (
            <a key={p} href={`#/issues/${p}`} style={{ marginRight: 6 }}>#{p}</a>
          )) : "none"}</span>
        </div>
        <div className="row small" style={{ marginTop: 8 }}>
          <span className="muted">Visible to:</span>
          {issue.visibility.length
            ? issue.visibility.map((g) => <span key={g} className="chip">{groups.find((x) => x.id === g)?.name ?? `#${g}`}</span>)
            : <span className="muted">Everyone (public)</span>}
        </div>
        {detail.assignedActors.length > 0 && (
          <div className="row small" style={{ marginTop: 8 }}>
            <span className="muted">Assignees:</span>
            {detail.assignedActors.map((a) => <span key={a.id} className="chip">{a.displayName}</span>)}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Artifacts</h3>
          {me && <button onClick={() => setAddArtifact(true)}>+ Add artifact</button>}
        </div>
        {detail.attachedArtifacts.map((a) => (
          <div key={a.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
            <span>
              <span className="badge">{a.kind}</span>{" "}
              {a.display.url
                ? <a href={a.display.url} target="_blank" rel="noreferrer">{a.display.label}</a>
                : <span className="muted small">{a.display.label}</span>}
            </span>
            {me && <button className="danger" onClick={() => api.deleteArtifact(a.id).then(load)}>Remove</button>}
          </div>
        ))}
        {detail.attachedArtifacts.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>None attached</div>}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Checks</h3>
          {me && <button onClick={() => setAddCheck(true)}>+ Add check</button>}
        </div>
        {detail.attachedChecks.map((c) => (
          <div key={c.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
            <span>
              <span className="badge">{c.kind}</span>{" "}
              <span className={`badge ${c.status}`}>{c.status}</span>{" "}
              {c.detail && <span className="muted small">{c.detail}</span>}
            </span>
            {me && (
              <span className="row">
                <button onClick={() => api.runCheck(c.id).then(load)}>Run</button>
                <button className="danger" onClick={() => api.deleteCheck(c.id).then(load)}>Remove</button>
              </span>
            )}
          </div>
        ))}
        {detail.attachedChecks.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>None attached</div>}
      </div>

      <CommentsSection detail={detail} me={me} onChange={load} />

      {me && (
        <div className="actions-bar">
          {issue.state === "open" ? (
            <>
              <button onClick={() => setState("closed")}>Close</button>
              <button onClick={() => setState("completed")}>Close as completed</button>
            </>
          ) : (
            <button onClick={() => setState("open")}>Reopen</button>
          )}
          <button onClick={() => api.updateIssue(id, { locked: !issue.locked }).then(load).catch((e) => setError(String(e)))}>
            {issue.locked ? "🔓 Unlock" : "🔒 Lock"}
          </button>
          <a href={`#/issues/${id}/edit`}><button>Edit</button></a>
          <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
      )}

      {addArtifact && (
        <AttachModal
          title="Add artifact"
          kinds={plugins?.artifactKinds ?? []}
          onClose={() => setAddArtifact(false)}
          onSubmit={(kind, value) => api.addArtifact(issue.id, kind, value)}
          onDone={() => { setAddArtifact(false); load(); }}
        />
      )}
      {addCheck && (
        <AttachModal
          title="Add check"
          kinds={plugins?.checkKinds ?? []}
          onClose={() => setAddCheck(false)}
          onSubmit={(kind, value) => api.addCheck(issue.id, kind, value)}
          onDone={() => { setAddCheck(false); load(); }}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title="Delete issue"
          message={`Delete issue #${issue.id} "${issue.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={del}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// Modal for attaching an artifact or check. Renders a form derived from the selected kind's
// field schema (from /api/plugins) and assembles the payload — no raw JSON needed.
function AttachModal({
  title, kinds, onClose, onSubmit, onDone,
}: {
  title: string;
  kinds: PluginKind[];
  onClose: () => void;
  onSubmit: (kind: string, value: unknown) => Promise<unknown>;
  onDone: () => void;
}) {
  const [kind, setKind] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [err, setErr] = useState<string | null>(null);

  const selected = kinds.find((k) => k.kind === kind);

  const chooseKind = (k: string) => {
    setKind(k);
    setErr(null);
    const kd = kinds.find((x) => x.kind === k);
    const init: Record<string, string | boolean> = {};
    kd?.fields.forEach((f) => { init[f.name] = f.type === "boolean" ? false : ""; });
    setValues(init);
  };
  const setField = (name: string, v: string | boolean) => setValues((prev) => ({ ...prev, [name]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) { setErr("choose a kind"); return; }
    const payload: Record<string, unknown> = {};
    for (const f of selected.fields) {
      const raw = values[f.name];
      if (f.type === "boolean") { payload[f.name] = !!raw; continue; }
      const s = String(raw ?? "").trim();
      if (s === "") {
        if (f.required) { setErr(`${f.label} is required`); return; }
        continue;
      }
      if (f.type === "number") {
        const n = Number(s);
        if (Number.isNaN(n)) { setErr(`${f.label} must be a number`); return; }
        payload[f.name] = n;
      } else {
        payload[f.name] = s;
      }
    }
    onSubmit(kind, payload).then(onDone).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Kind</label>
        <select value={kind} onChange={(e) => chooseKind(e.target.value)} required>
          <option value="" disabled>choose a kind…</option>
          {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.kind}</option>)}
        </select>

        {selected && selected.fields.length === 0 && (
          <p className="muted small">No additional fields required.</p>
        )}
        {selected?.fields.map((f) => (
          <div key={f.name}>
            <label>{f.label}{f.required ? " *" : ""}</label>
            {f.type === "boolean" ? (
              <input type="checkbox" style={{ width: "auto" }} checked={!!values[f.name]} onChange={(e) => setField(f.name, e.target.checked)} />
            ) : f.type === "text" ? (
              <textarea value={String(values[f.name] ?? "")} placeholder={f.placeholder ?? ""} onChange={(e) => setField(f.name, e.target.value)} />
            ) : (
              <input type={f.type === "number" ? "number" : "text"} value={String(values[f.name] ?? "")} placeholder={f.placeholder ?? ""} onChange={(e) => setField(f.name, e.target.value)} />
            )}
            {f.help && <div className="muted small">{f.help}</div>}
          </div>
        ))}

        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={!selected}>Attach</button>
        </div>
      </form>
    </Modal>
  );
}

// Discussion thread on an issue: existing comments plus (for signed-in users) a box to add one.
// A comment can be removed by its author or an admin.
function CommentsSection({
  detail, me, onChange,
}: {
  detail: Detail;
  me: Actor | null;
  onChange: () => void;
}) {
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const comments = detail.comments ?? [];

  const post = (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    api.addComment(detail.issue.id, text)
      .then(() => { setBody(""); setErr(null); onChange(); })
      .catch((e2) => setErr(String(e2)))
      .finally(() => setBusy(false));
  };

  const canDelete = (authorId: number | null) => !!me && (me.admin || me.id === authorId);

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Comments <span className="muted small">({comments.length})</span></h3>
      {comments.length === 0 && <div className="muted small">No comments yet.</div>}
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">
              <strong>{c.authorName ?? "(unknown)"}</strong>
              <span className="muted"> · {fmtTime(c.createdAt)}{c.updatedAt !== c.createdAt ? " (edited)" : ""}</span>
            </span>
            {canDelete(c.authorId) && (
              <button className="danger" onClick={() => api.deleteComment(c.id).then(onChange).catch((e2) => setErr(String(e2)))}>Delete</button>
            )}
          </div>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{c.body}</div>
        </div>
      ))}

      {me ? (
        <form onSubmit={post} style={{ marginTop: 12 }}>
          {err && <div className="error small">{err}</div>}
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment…" />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <button className="primary" type="submit" disabled={busy || !body.trim()}>Comment</button>
          </div>
        </form>
      ) : (
        <div className="muted small" style={{ marginTop: 12 }}>Sign in to comment.</div>
      )}
    </div>
  );
}
