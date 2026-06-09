import { useEffect, useState } from "react";
import type { Actor, Group, Issue, Label } from "../types";
import { api } from "../api";
import { MultiSelect } from "./MultiSelect";

// Shared create/edit form. Pass `issueId` to edit an existing issue.
export function IssueForm({ issueId, me }: { issueId?: number; me: Actor | null }) {
  const editing = issueId != null;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<number[]>([]);
  const [parents, setParents] = useState<number[]>([]);
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
          setParents(d.issue.parents);
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
      : { title, description, labels, parents, assignees, visibility };
    const p = editing
      ? api.updateIssue(issueId!, body)
      : api.createIssue(body as Partial<Issue>);
    p.then((i) => (window.location.hash = `#/issues/${editing ? issueId : (i as Issue).id}`))
      .catch((e2) => setError(String(e2)));
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
    <form className="panel" onSubmit={submit} style={{ maxWidth: 680 }}>
      <h2>{editing ? `Edit issue #${issueId}` : "New issue"} {locked && <span title="locked">🔒</span>}</h2>
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
      <label>Labels</label>
      <MultiSelect options={labelOpts} selected={labels} onChange={setLabels} placeholder="Add labels…" />
      <label>Depends on (parent issues)</label>
      {locked ? (
        <div className="row field-disabled">{parents.length ? parents.map((p) => <span key={p} className="chip">#{p}</span>) : <span className="muted small">none</span>}</div>
      ) : (
        <MultiSelect options={issueOpts} selected={parents} onChange={setParents} placeholder="Select parent issues…" />
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
      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" type="submit">{editing ? "Save" : "Create"}</button>
        <a href={editing ? `#/issues/${issueId}` : "#/issues"}><button type="button">Cancel</button></a>
      </div>
    </form>
  );
}
