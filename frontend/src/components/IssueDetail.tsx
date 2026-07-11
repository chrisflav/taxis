import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  Actor, Artifact, Check, Comment, Event, Group, Issue, IssueDetail as Detail, Label, PluginKind, Plugins,
} from "../types";
import { api } from "../api";
import { Modal, ConfirmModal } from "./Modal";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";
import { MultiSelect } from "./MultiSelect";
import { ActorName } from "./ActorName";

// Render a Unix (seconds) timestamp in the viewer's locale.
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

// Event kinds shown as an edit-history dropdown next to their text rather than in the timeline.
const CONTENT_KINDS = new Set(["title", "description", "comment_edited"]);

export function IssueDetail({ id, me }: { id: number; me: Actor | null }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [plugins, setPlugins] = useState<Plugins | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [allActors, setAllActors] = useState<Actor[]>([]);
  const [allIssues, setAllIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addArtifact, setAddArtifact] = useState(false);
  const [addCheck, setAddCheck] = useState(false);
  const [delArtifact, setDelArtifact] = useState<Artifact | null>(null);
  const [delCheck, setDelCheck] = useState<Check | null>(null);

  const load = () => api.getIssue(id).then(setDetail).catch((e) => setError(String(e)));

  useEffect(() => {
    load();
    api.plugins().then(setPlugins).catch(() => {});
    api.listGroups().then(setGroups).catch(() => {});
    api.listLabels().then(setAllLabels).catch(() => {});
    api.listActors().then(setAllActors).catch(() => {});
    api.listIssues().then(setAllIssues).catch(() => {});
  }, [id]);

  if (error) return <div className="panel error">{error}</div>;
  if (!detail) return <div className="muted">Loading…</div>;
  const { issue } = detail;

  // Persist a patch to the issue and refresh. Returns the promise so inline editors can await it.
  const patch = (body: Record<string, unknown>) => api.updateIssue(id, body).then(() => load());
  const setState = (state: string) => patch({ state }).catch((e) => setError(String(e)));
  const del = () => api.deleteIssue(id).then(() => (window.location.hash = "#/issues"));

  const groupName = (g: number) => groups.find((x) => x.id === g)?.name ?? `#${g}`;
  const actorOf = (aid: number) => allActors.find((a) => a.id === aid);
  const labelName = (l: number) => allLabels.find((x) => x.id === l)?.name ?? `#${l}`;

  const canEdit = !!me;
  // When locked, the title, description, parent and dependencies are frozen (labels, assignees and
  // visibility remain editable), mirroring the backend's locking rules.
  const editableUnlessLocked = canEdit && !issue.locked;

  const labelOpts = allLabels.map((l) => ({ value: l.id, label: l.name }));
  const actorOpts = allActors.map((a) => ({ value: a.id, label: a.displayName }));
  const issueOpts = allIssues.filter((i) => i.id !== id).map((i) => ({ value: i.id, label: `#${i.id} ${i.title}` }));
  const visibleGroups = me?.admin ? groups : groups.filter((g) => me?.groups.includes(g.id));

  const events = detail.events ?? [];
  const historyFor = (kind: string) => events.filter((e) => e.kind === kind);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>
        <span className="muted">#{issue.id}</span>{" · "}
        <InlineText
          value={issue.title}
          canEdit={editableUnlessLocked}
          inline
          onSave={(v) => patch({ title: v })}
        />{" "}
        <span className={`badge ${issue.state}`}>{issue.state}</span>
        {issue.locked && <span title="locked" style={{ marginLeft: 6 }}>🔒</span>}
        <HistoryDropdown events={historyFor("title")} label="Title history" />
      </h2>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3 className="field-heading">Description <HistoryDropdown events={historyFor("description")} label="Description history" /></h3>
        </div>
        <InlineText
          value={issue.description}
          canEdit={editableUnlessLocked}
          multiline
          placeholder="No description"
          onSave={(v) => patch({ description: v })}
        />
        {detail.issueLabels.length > 0 && (
          <div className="row" style={{ margin: "8px 0" }}>
            {detail.issueLabels.map((l) => <LabelChip key={l.id} label={l} />)}
          </div>
        )}

        <MetaRow label="Labels" canEdit={canEdit}
          display={detail.issueLabels.length
            ? detail.issueLabels.map((l) => <LabelChip key={l.id} label={l} />)
            : <span className="muted small">none</span>}
          editor={(close) => <MultiEditor options={labelOpts} initial={issue.labels} placeholder="Add labels…"
            onSave={(v) => patch({ labels: v })} onClose={close} onError={setError} />} />

        <MetaRow label="Parent" canEdit={editableUnlessLocked}
          display={issue.parent != null
            ? <a href={`#/issues/${issue.parent}`}>#{issue.parent}</a>
            : <span className="muted small">none</span>}
          editor={(close) => <SelectEditor options={issueOpts} initial={issue.parent}
            onSave={(v) => patch({ parent: v })} onClose={close} onError={setError} />} />

        <MetaRow label="Depends on" canEdit={editableUnlessLocked}
          display={issue.dependencies.length
            ? issue.dependencies.map((p) => <a key={p} href={`#/issues/${p}`} style={{ marginRight: 6 }}>#{p}</a>)
            : <span className="muted small">none</span>}
          editor={(close) => <MultiEditor options={issueOpts} initial={issue.dependencies} placeholder="Select dependencies…"
            onSave={(v) => patch({ dependencies: v })} onClose={close} onError={setError} />} />

        <MetaRow label="Assignees" canEdit={canEdit}
          display={detail.assignedActors.length
            ? detail.assignedActors.map((a) => <span key={a.id} className="chip"><ActorName name={a.displayName} bot={a.bot} /></span>)
            : <span className="muted small">none</span>}
          editor={(close) => <MultiEditor options={actorOpts} initial={issue.assignees} placeholder="Assign actors…"
            onSave={(v) => patch({ assignees: v })} onClose={close} onError={setError} />} />

        <MetaRow label="Visible to" canEdit={canEdit}
          display={issue.visibility.length
            ? issue.visibility.map((g) => <span key={g} className="chip">{groupName(g)}</span>)
            : <span className="muted small">Everyone (public)</span>}
          editor={(close) => <MultiEditor options={visibleGroups.map((g) => ({ value: g.id, label: g.name }))}
            initial={issue.visibility} placeholder="Everyone (public)"
            onSave={(v) => patch({ visibility: v })} onClose={close} onError={setError} />} />
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
            {me && <button className="danger" onClick={() => setDelArtifact(a)}>Remove</button>}
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
                <button className="danger" onClick={() => setDelCheck(c)}>Remove</button>
              </span>
            )}
          </div>
        ))}
        {detail.attachedChecks.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>None attached</div>}
      </div>

      <Timeline
        detail={detail}
        me={me}
        actorOf={actorOf}
        labelName={labelName}
        groupName={groupName}
        onChange={load}
        onError={setError}
      />

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
          <button onClick={() => patch({ locked: !issue.locked }).catch((e) => setError(String(e)))}>
            {issue.locked ? "🔓 Unlock" : "🔒 Lock"}
          </button>
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
      {delArtifact && (
        <ConfirmModal
          title="Remove artifact"
          message={`Remove the ${delArtifact.kind} artifact "${delArtifact.display.label}"?`}
          confirmLabel="Remove"
          danger
          onConfirm={() => api.deleteArtifact(delArtifact.id)
            .then(() => { setDelArtifact(null); load(); })
            .catch((e) => { setDelArtifact(null); setError(String(e)); })}
          onCancel={() => setDelArtifact(null)}
        />
      )}
      {delCheck && (
        <ConfirmModal
          title="Remove check"
          message={`Remove the ${delCheck.kind} check from this issue?`}
          confirmLabel="Remove"
          danger
          onConfirm={() => api.deleteCheck(delCheck.id)
            .then(() => { setDelCheck(null); load(); })
            .catch((e) => { setDelCheck(null); setError(String(e)); })}
          onCancel={() => setDelCheck(null)}
        />
      )}
    </div>
  );
}

// An inline-editable text value: renders the value (as markdown), and — for editors — a pencil that
// swaps the block for an input/textarea with Save/Cancel, leaving the rest of the page in place.
function InlineText({
  value, canEdit, onSave, inline = false, multiline = false, placeholder,
}: {
  value: string;
  canEdit: boolean;
  onSave: (v: string) => Promise<unknown>;
  inline?: boolean;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = () => { setDraft(value); setErr(null); setEditing(true); };
  const save = () => {
    setBusy(true);
    onSave(draft).then(() => { setEditing(false); setErr(null); }).catch((e) => setErr(String(e))).finally(() => setBusy(false));
  };

  if (editing) {
    return (
      <span className={inline ? "inline-edit inline-edit-inline" : "inline-edit"}>
        {err && <div className="error small">{err}</div>}
        {multiline
          ? <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
          : <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />}
        <span className="row" style={{ marginTop: 6 }}>
          <button className="primary" onClick={save} disabled={busy}>Save</button>
          <button onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
        </span>
      </span>
    );
  }

  const body = value
    ? <Markdown text={value} inline={inline} />
    : <span className="muted">{placeholder ?? "empty"}</span>;
  return (
    <span className={inline ? "editable editable-inline" : "editable"}>
      {body}
      {canEdit && <button className="edit-pencil" title="Edit" onClick={begin}>✎</button>}
    </span>
  );
}

// A labelled metadata row with inline editing: shows the value plus a pencil that reveals `editor`.
function MetaRow({
  label, canEdit, display, editor,
}: {
  label: string;
  canEdit: boolean;
  display: ReactNode;
  editor: (close: () => void) => ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="meta-row">
      <span className="meta-label muted small">{label}</span>
      {editing ? (
        <span className="meta-value">{editor(() => setEditing(false))}</span>
      ) : (
        <span className="meta-value">
          {display}
          {canEdit && <button className="edit-pencil" title={`Edit ${label.toLowerCase()}`} onClick={() => setEditing(true)}>✎</button>}
        </span>
      )}
    </div>
  );
}

// Inline multi-select editor (labels, dependencies, assignees, visibility) with Save/Cancel.
function MultiEditor({
  options, initial, placeholder, onSave, onClose, onError,
}: {
  options: { value: number; label: string }[];
  initial: number[];
  placeholder?: string;
  onSave: (v: number[]) => Promise<unknown>;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const [sel, setSel] = useState<number[]>(initial);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    onSave(sel).then(onClose).catch((e) => onError(String(e))).finally(() => setBusy(false));
  };
  return (
    <span className="inline-edit">
      <MultiSelect options={options} selected={sel} onChange={setSel} placeholder={placeholder} />
      <span className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={save} disabled={busy}>Save</button>
        <button onClick={onClose} disabled={busy}>Cancel</button>
      </span>
    </span>
  );
}

// Inline single-select editor (parent) with a "none" option and Save/Cancel.
function SelectEditor({
  options, initial, onSave, onClose, onError,
}: {
  options: { value: number; label: string }[];
  initial: number | null;
  onSave: (v: number | null) => Promise<unknown>;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const [val, setVal] = useState<number | null>(initial);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    onSave(val).then(onClose).catch((e) => onError(String(e))).finally(() => setBusy(false));
  };
  return (
    <span className="inline-edit">
      <select value={val ?? ""} onChange={(e) => setVal(e.target.value ? Number(e.target.value) : null)}>
        <option value="">— none —</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={save} disabled={busy}>Save</button>
        <button onClick={onClose} disabled={busy}>Cancel</button>
      </span>
    </span>
  );
}

// A collapsible edit-history popover shown next to a title/description/comment. Each entry shows
// who changed it and when, with the previous → new value.
function HistoryDropdown({ events, label }: { events: Event[]; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  // Close the popover when clicking anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  if (events.length === 0) return null;
  return (
    <span className="history" ref={ref}>
      <button className="history-toggle" title={label} onClick={() => setOpen((o) => !o)}>
        🕓 {events.length} edit{events.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="history-menu">
          <div className="history-head small muted">{label}</div>
          {events.slice().reverse().map((e) => (
            <div key={e.id} className="history-item">
              <div className="small muted">
                <ActorName name={e.actorName ?? "(unknown)"} bot={e.actorBot} /> · {fmtTime(e.createdAt)}
              </div>
              <div className="history-from small">{String(e.data.from ?? "")}</div>
              <div className="history-to small">{String(e.data.to ?? "")}</div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

interface EventCtx {
  actorOf: (id: number) => Actor | undefined;
  labelName: (id: number) => string;
  groupName: (id: number) => string;
}

// A human-readable phrase describing a single non-content change, used in the merged timeline.
function describeEvent(e: Event, ctx: EventCtx): ReactNode {
  const d = e.data;
  const ids = (v: unknown) => (Array.isArray(v) ? (v as number[]) : []);
  const issueLink = (i: number): ReactNode => (<a key={i} href={`#/issues/${i}`}>#{i}</a>);
  const nameOf = (aid: number): ReactNode => {
    const a = ctx.actorOf(aid);
    return <ActorName name={a?.displayName ?? `#${aid}`} bot={a?.bot} />;
  };
  switch (e.kind) {
    case "state": {
      const to = d.to;
      if (to === "open") return "reopened this issue";
      if (to === "completed") return "marked this issue completed";
      return "closed this issue";
    }
    case "locked":
      return d.to ? "locked this issue" : "unlocked this issue";
    case "parent": {
      const to = d.to as number | null;
      return to == null ? "removed the parent" : <>set the parent to {issueLink(to)}</>;
    }
    case "dependencies":
      return joinChange("dependency", ids(d.added).map(issueLink), ids(d.removed).map(issueLink));
    case "assignees":
      return joinChange("assignee", ids(d.added).map(nameOf), ids(d.removed).map(nameOf));
    case "visibility":
      return joinChange("visibility group", ids(d.added).map((i) => ctx.groupName(i)), ids(d.removed).map((i) => ctx.groupName(i)));
    case "labels":
      return joinChange("label", ids(d.added).map((i) => ctx.labelName(i)), ids(d.removed).map((i) => ctx.labelName(i)));
    case "artifact_added":
      return <>attached a <span className="badge">{String(d.kind ?? "")}</span> artifact{d.label ? <> ({String(d.label)})</> : null}</>;
    case "artifact_removed":
      return <>removed a <span className="badge">{String(d.kind ?? "")}</span> artifact</>;
    case "check_added":
      return <>added a <span className="badge">{String(d.kind ?? "")}</span> check</>;
    case "check_removed":
      return <>removed a <span className="badge">{String(d.kind ?? "")}</span> check</>;
    case "comment_deleted":
      return "deleted a comment";
    default:
      return e.kind;
  }
}

// One compact change entry inside the merged timeline.
function EventLine({ event, ctx }: { event: Event; ctx: EventCtx }) {
  return (
    <div className="timeline-item">
      <span className="timeline-dot" />
      <span className="small">
        <strong><ActorName name={event.actorName ?? "(system)"} bot={event.actorBot} /></strong>{" "}
        {describeEvent(event, ctx)}
        <span className="muted"> · {fmtTime(event.createdAt)}</span>
      </span>
    </div>
  );
}

// "added X, Y and removed Z" phrasing for a relation change, given already-rendered node lists.
function joinChange(noun: string, added: ReactNode[], removed: ReactNode[]): ReactNode {
  const parts: ReactNode[] = [];
  const list = (xs: ReactNode[]) => xs.map((x, i) => <span key={i}>{i > 0 ? ", " : ""}{x}</span>);
  const plural = (n: number) => (n === 1 ? noun : `${noun}s`);
  if (added.length) parts.push(<span key="a">added {plural(added.length)} {list(added)}</span>);
  if (removed.length) parts.push(<span key="r">removed {plural(removed.length)} {list(removed)}</span>);
  if (parts.length === 0) return `changed ${noun}s`;
  return parts.flatMap((p, i) => (i > 0 ? [" and ", p] : [p]));
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

// One unified, chronological stream of an issue's activity: comments (each editable/removable by
// its author or an admin, with an edit-history dropdown) interleaved with the non-content changes
// (state, lock, parent, dependencies, assignees, visibility, labels, artifacts, checks), plus a
// box to add a comment for signed-in users. Title/description/comment edits stay as edit-history
// dropdowns next to their text rather than appearing here.
function Timeline({
  detail, me, actorOf, labelName, groupName, onChange, onError,
}: {
  detail: Detail;
  me: Actor | null;
  actorOf: (id: number) => Actor | undefined;
  labelName: (id: number) => string;
  groupName: (id: number) => string;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const comments = detail.comments ?? [];
  const events = detail.events ?? [];
  const ctx: EventCtx = { actorOf, labelName, groupName };

  const canModify = (authorId: number | null) => !!me && (me.admin || me.id === authorId);

  // Merge comments and non-content change events into a single time-ordered list. `Array.sort` is
  // stable, so events and comments sharing a timestamp keep a sensible order.
  const items: { at: number; key: string; node: ReactNode }[] = [
    ...comments.map((c) => ({
      at: c.createdAt,
      key: `c-${c.id}`,
      node: (
        <CommentItem
          comment={c}
          history={events.filter((e) => e.kind === "comment_edited" && e.data.commentId === c.id)}
          bot={actorOf(c.authorId ?? -1)?.bot}
          canModify={canModify(c.authorId)}
          onChange={onChange}
          onError={onError}
        />
      ),
    })),
    ...events.filter((e) => !CONTENT_KINDS.has(e.kind)).map((e) => ({
      at: e.createdAt,
      key: `e-${e.id}`,
      node: <EventLine event={e} ctx={ctx} />,
    })),
  ].sort((a, b) => a.at - b.at);

  const post = (e: React.FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    api.addComment(detail.issue.id, text)
      .then(() => { setBody(""); onChange(); })
      .catch((e2) => onError(String(e2)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Activity <span className="muted small">({comments.length} comment{comments.length === 1 ? "" : "s"})</span></h3>
      {items.length === 0 && <div className="muted small">No activity yet.</div>}
      <div className="timeline-list">
        {items.map((it) => <div key={it.key} className="timeline-entry">{it.node}</div>)}
      </div>

      {me ? (
        <form onSubmit={post} style={{ marginTop: 12 }}>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a comment… (Markdown & LaTeX supported)" />
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

function CommentItem({
  comment: c, history, bot, canModify, onChange, onError,
}: {
  comment: Comment;
  history: Event[];
  bot?: boolean;
  canModify: boolean;
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const save = () => {
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    api.updateComment(c.id, text)
      .then(() => { setEditing(false); onChange(); })
      .catch((e) => onError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="comment-card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="small">
          <strong><ActorName name={c.authorName ?? "(unknown)"} bot={bot} /></strong>
          <span className="muted"> · {fmtTime(c.createdAt)}{c.updatedAt !== c.createdAt ? " (edited)" : ""}</span>
          <HistoryDropdown events={history} label="Comment history" />
        </span>
        {canModify && !editing && (
          <span className="comment-controls">
            <button className="edit-pencil" title="Edit comment" onClick={() => { setDraft(c.body); setEditing(true); }}>✎</button>
            <button className="edit-pencil edit-pencil-danger" title="Delete comment"
              onClick={() => setConfirmDel(true)}>🗑</button>
          </span>
        )}
      </div>
      {editing ? (
        <div style={{ marginTop: 6 }}>
          <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <button onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy || !draft.trim()}>Save</button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 4 }}><Markdown text={c.body} /></div>
      )}
      {confirmDel && (
        <ConfirmModal
          title="Delete comment"
          message="Delete this comment? This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => api.deleteComment(c.id)
            .then(() => { setConfirmDel(false); onChange(); })
            .catch((e) => { setConfirmDel(false); onError(String(e)); })}
          onCancel={() => setConfirmDel(false)}
        />
      )}
    </div>
  );
}
