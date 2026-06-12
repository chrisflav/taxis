import { useEffect, useState } from "react";
import type { Actor, Group, Issue, Label } from "../types";
import { api } from "../api";
import { MultiSelect } from "./MultiSelect";

// Shared create/edit form. Pass `issueId` to edit an existing issue. When `embedded` is set the
// form drops its page chrome (heading + panel) so it can live inside a modal, and uses the
// `onDone`/`onCancel` callbacks instead of hash navigation.
export function IssueForm({
  issueId,
  me,
  embedded = false,
  onDone,
  onCancel,
}: {
  issueId?: number;
  me: Actor | null;
  embedded?: boolean;
  onDone?: (issueId: number) => void;
  onCancel?: () => void;
}) {
  const editing = issueId != null;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<number[]>([]);
  const [parent, setParent] = useState<number | null>(null);
  const [dependencies, setDependencies] = useState<number[]>([]);
  const [assignees, setAssignees] = useState<number[]>([]);
  const [visibility, setVisibility] = useState<number[]>([]);
  const [locked, setLocked] = useState(false);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [allActors, setAllActors] = useState<Actor[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [allIssues, setAllIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!editing);

  useEffect(() => {
    api.listLabels().then(setAllLabels).catch(() => {});
    api.listActors().then(setAllActors).catch(() => {});
    api.listGroups().then(setAllGroups).catch(() => {});
    api.listIssues().then(setAllIssues).catch(() => {});
    if (editing) {
      api
        .getIssue(issueId!)
        .then((d) => {
          setTitle(d.issue.title);
          setDescription(d.issue.description);
          setLabels(d.issue.labels);
          setParent(d.issue.parent);
          setDependencies(d.issue.dependencies);
          setAssignees(d.issue.assignees);
          setVisibility(d.issue.visibility);
          setLocked(d.issue.locked);
          setLoaded(true);
        })
        .catch((e) => setError(String(e)));
    }
  }, [issueId]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // When locked, don't send frozen fields at all, so the backend never rejects a no-op change.
    const body = locked
      ? { labels, assignees, visibility }
      : { title, description, labels, parent, dependencies, assignees, visibility };
    const p = editing
      ? api.updateIssue(issueId!, body)
      : api.createIssue(body as Partial<Issue>);
    p.then((i) => {
      const id = editing ? issueId! : (i as Issue).id;
      if (onDone) onDone(id);
      else window.location.hash = `#/issues/${id}`;
    }).catch((e2) => setError(String(e2)));
  };

  const cancel = () => {
    if (onCancel) onCancel();
    else window.location.hash = editing ? `#/issues/${issueId}` : "#/issues";
  };

  if (!loaded) return <div className="muted">Loading…</div>;

  const labelOpts = allLabels.map((l) => ({ value: l.id, label: l.name }));
  const actorOpts = allActors.map((a) => ({ value: a.id, label: a.displayName }));
  const issueOpts = allIssues
    .filter((i) => i.id !== issueId)
    .map((i) => ({ value: i.id, label: `#${i.id} ${i.title}` }));
  // A user may only restrict visibility to groups they belong to (admins: any group).
  const visibleGroups = me?.admin ? allGroups : allGroups.filter((g) => me?.groups.includes(g.id));

  return (
    <form className={embedded ? "" : "panel"} onSubmit={submit} style={embedded ? undefined : { maxWidth: 680 }}>
      {!embedded && <h2>{editing ? `Edit issue #${issueId}` : "New issue"} {locked && <span title="locked">🔒</span>}</h2>}
      {error && <div className="error">{error}</div>}
      {!me && <div className="panel error">You must sign in to create or edit issues.</div>}
      {locked && (
        <div className="panel small" style={{ background: "var(--panel-2)" }}>
          🔒 This issue is locked. Title, description, and dependencies are frozen — unlock it from the
          issue page to change them. Labels and assignees can still be edited.
        </div>
      )}
      <label>Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus disabled={locked} />
      <label>Description</label>
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={locked} />
      <div className="muted small">Markdown and LaTeX math (KaTeX, e.g. <code>$x^2$</code>) supported.</div>
      <label>Labels</label>
      <MultiSelect options={labelOpts} selected={labels} onChange={setLabels} placeholder="Add labels…" />
      <label>Parent (containing issue)</label>
      {locked ? (
        <div className="row field-disabled">{parent != null ? <span className="chip">#{parent}</span> : <span className="muted small">none</span>}</div>
      ) : (
        <select value={parent ?? ""} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : null)}>
          <option value="">— none —</option>
          {issueOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      <label>Depends on (dependencies)</label>
      {locked ? (
        <div className="row field-disabled">{dependencies.length ? dependencies.map((p) => <span key={p} className="chip">#{p}</span>) : <span className="muted small">none</span>}</div>
      ) : (
        <MultiSelect options={issueOpts} selected={dependencies} onChange={setDependencies} placeholder="Select dependencies…" />
      )}
      <label>Assignees</label>
      <MultiSelect options={actorOpts} selected={assignees} onChange={setAssignees} placeholder="Assign actors…" />
      <label>Visible to groups (empty = public)</label>
      <MultiSelect
        options={visibleGroups.map((g) => ({ value: g.id, label: g.name }))}
        selected={visibility}
        onChange={setVisibility}
        placeholder="Everyone (public)"
      />
      <div className="row" style={{ marginTop: 16, justifyContent: embedded ? "flex-end" : "flex-start" }}>
        <button type="button" onClick={cancel}>Cancel</button>
        <button className="primary" type="submit">{editing ? "Save" : "Create"}</button>
      </div>
    </form>
  );
}
