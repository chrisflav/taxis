import { useEffect, useRef, useState } from "react";
import type { Actor, Group, Issue, Label } from "../types";
import { api } from "../api";
import { MultiSelect } from "./MultiSelect";
import { SearchableSelect } from "./SearchableSelect";
import { AutoTextarea } from "./AutoTextarea";
import { breadcrumbLabel } from "../breadcrumbs";
import { localInputToUnix, unixToLocalInput } from "../datetime";
import { useIssueRefAutocomplete } from "../useIssueRefAutocomplete";
import { IssueRefMenu } from "./IssueRefMenu";

// Shared create/edit form. Pass `issueId` to edit an existing issue. When `embedded` is set the
// form drops its page chrome (heading + panel) so it can live inside a modal, and uses the
// `onDone`/`onCancel` callbacks instead of hash navigation. `initialParent` pre-selects a parent
// for new child issues; it counts as the baseline, not as user input, for `onDirtyChange`.
export function IssueForm({
  issueId,
  me,
  embedded = false,
  initialParent = null,
  onDone,
  onCancel,
  onDirtyChange,
}: {
  issueId?: number;
  me: Actor | null;
  embedded?: boolean;
  initialParent?: number | null;
  onDone?: (issueId: number) => void;
  onCancel?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const editing = issueId != null;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("");
  const [labels, setLabels] = useState<number[]>([]);
  const [parent, setParent] = useState<number | null>(initialParent);
  const [dependencies, setDependencies] = useState<number[]>([]);
  const [assignees, setAssignees] = useState<number[]>([]);
  const [visibility, setVisibility] = useState<number[]>([]);
  const [deadline, setDeadline] = useState("");
  const [locked, setLocked] = useState(false);
  const [allLabels, setAllLabels] = useState<Label[]>([]);
  const [allActors, setAllActors] = useState<Actor[]>([]);
  const [allGroups, setAllGroups] = useState<Group[]>([]);
  const [allIssues, setAllIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!editing);

  // What counts as "unmodified" for onDirtyChange: the loaded issue when editing, or blank fields
  // (with the pre-selected parent) when creating — a pre-filled parent alone isn't user input.
  const baseline = useRef({
    title: "", description: "", goal: "", parent: initialParent, deadline: "",
    labels: [] as number[], dependencies: [] as number[], assignees: [] as number[], visibility: [] as number[],
  });

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
          setGoal(d.issue.goal);
          setLabels(d.issue.labels);
          setParent(d.issue.parent);
          setDependencies(d.issue.dependencies);
          setAssignees(d.issue.assignees);
          setVisibility(d.issue.visibility);
          setDeadline(unixToLocalInput(d.issue.deadline));
          setLocked(d.issue.locked);
          baseline.current = {
            title: d.issue.title, description: d.issue.description, goal: d.issue.goal, parent: d.issue.parent,
            deadline: unixToLocalInput(d.issue.deadline),
            labels: d.issue.labels, dependencies: d.issue.dependencies, assignees: d.issue.assignees, visibility: d.issue.visibility,
          };
          setLoaded(true);
        })
        .catch((e) => setError(String(e)));
    }
  }, [issueId]);

  useEffect(() => {
    if (!onDirtyChange) return;
    const b = baseline.current;
    const sameSet = (a: number[], c: number[]) =>
      a.length === c.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...c].sort((x, y) => x - y)[i]);
    onDirtyChange(
      title !== b.title || description !== b.description || goal !== b.goal || parent !== b.parent
        || deadline !== b.deadline
        || !sameSet(labels, b.labels) || !sameSet(dependencies, b.dependencies)
        || !sameSet(assignees, b.assignees) || !sameSet(visibility, b.visibility),
    );
  }, [title, description, goal, labels, parent, dependencies, assignees, visibility, deadline, loaded]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // When locked, don't send frozen fields at all, so the backend never rejects a no-op change.
    const body = locked
      ? { labels, assignees, visibility }
      : { title, description, goal, labels, parent, dependencies, assignees, visibility, deadline: localInputToUnix(deadline) };
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
    .map((i) => ({ value: i.id, label: breadcrumbLabel(i, allIssues) }));
  // A user may only restrict visibility to groups they belong to (admins: any group).
  const visibleGroups = me?.admin ? allGroups : allGroups.filter((g) => me?.groups.includes(g.id));

  // "#123" issue-reference autocomplete for the title, description and goal fields.
  const titleAc = useIssueRefAutocomplete<HTMLInputElement>(allIssues, title, setTitle);
  const descAc = useIssueRefAutocomplete<HTMLTextAreaElement>(allIssues, description, setDescription);
  const goalAc = useIssueRefAutocomplete<HTMLTextAreaElement>(allIssues, goal, setGoal);

  return (
    <form className={embedded ? "" : "panel"} onSubmit={submit} style={embedded ? undefined : { maxWidth: 680 }}>
      {!embedded && <h2>{editing ? `Edit issue #${issueId}` : "New issue"} {locked && <span title="locked">🔒</span>}</h2>}
      {error && <div className="error">{error}</div>}
      {!me && <div className="panel error">You must sign in to create or edit issues.</div>}
      {locked && (
        <div className="panel small" style={{ background: "var(--panel-2)" }}>
          🔒 This issue is locked. Title, description, goal, and dependencies are frozen — unlock it
          from the issue page to change them. Labels and assignees can still be edited.
        </div>
      )}
      <label>Title</label>
      <div className="issue-ref-field">
        <input
          ref={titleAc.elRef}
          value={title}
          onChange={titleAc.onChangeWrapped}
          onKeyDown={titleAc.onKeyDown}
          required
          autoFocus
          disabled={locked}
        />
        <IssueRefMenu options={titleAc.options} issues={allIssues} onChoose={titleAc.choose} pos={titleAc.menuPos} menuRef={titleAc.menuRef} />
      </div>
      <label>Description</label>
      <div className="issue-ref-field">
        <AutoTextarea
          ref={descAc.elRef}
          value={description}
          onChange={descAc.onChangeWrapped}
          onKeyDown={descAc.onKeyDown}
          disabled={locked}
        />
        <IssueRefMenu options={descAc.options} issues={allIssues} onChoose={descAc.choose} pos={descAc.menuPos} menuRef={descAc.menuRef} />
      </div>
      <div className="muted small">
        Markdown and LaTeX math (KaTeX, e.g. <code>$x^2$</code>) supported. Type <code>#</code> to link another issue.
      </div>
      <label>Goal</label>
      <div className="issue-ref-field">
        <AutoTextarea
          ref={goalAc.elRef}
          value={goal}
          onChange={goalAc.onChangeWrapped}
          onKeyDown={goalAc.onKeyDown}
          disabled={locked}
        />
        <IssueRefMenu options={goalAc.options} issues={allIssues} onChoose={goalAc.choose} pos={goalAc.menuPos} menuRef={goalAc.menuRef} />
      </div>
      <div className="muted small">
        A short condition that must be fulfilled to complete this issue.
      </div>
      <label>Labels</label>
      <MultiSelect options={labelOpts} selected={labels} onChange={setLabels} placeholder="Add labels…" />
      <label>Parent (containing issue)</label>
      {locked ? (
        <div className="row field-disabled">{parent != null ? <span className="chip">#{parent}</span> : <span className="muted small">none</span>}</div>
      ) : (
        <SearchableSelect options={issueOpts} value={parent} onChange={setParent} />
      )}
      <label>Depends on (dependencies)</label>
      {locked ? (
        <div className="row field-disabled">{dependencies.length ? dependencies.map((p) => <span key={p} className="chip">#{p}</span>) : <span className="muted small">none</span>}</div>
      ) : (
        <MultiSelect options={issueOpts} selected={dependencies} onChange={setDependencies} placeholder="Select dependencies…" />
      )}
      <label>Assignees</label>
      <MultiSelect options={actorOpts} selected={assignees} onChange={setAssignees} placeholder="Assign actors…" />
      <label>Deadline</label>
      <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
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
