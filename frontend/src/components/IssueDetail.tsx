import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Actor, Artifact, Check, Comment, Event, Group, IssueDetail as Detail, IssueIndexEntry, Label,
  PluginKind, Plugins, ReviewState,
} from "../types";
import { api, paths } from "../api";
import { EMPTY, REFERENCE_MAX_AGE, useResource } from "../cache";
import { Modal, ConfirmModal, useConfirmClose } from "./Modal";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";
import { MultiSelect } from "./MultiSelect";
import { SearchableSelect } from "./SearchableSelect";
import { AutoTextarea } from "./AutoTextarea";
import { ActorName } from "./ActorName";
import { IssueBreadcrumbs } from "./Breadcrumbs";
import { IssueForm } from "./IssueForm";
import { diffWords } from "../diff";
import { localInputToUnix, unixToLocalInput } from "../datetime";
import { useIssueRefAutocomplete } from "../useIssueRefAutocomplete";
import { IssueRefMenu } from "./IssueRefMenu";
import { breadcrumbOptions } from "../breadcrumbs";

// Render a Unix (seconds) timestamp in the viewer's locale.
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

// Event kinds shown as an edit-history dropdown next to their text rather than in the timeline.
const CONTENT_KINDS = new Set(["title", "description", "goal", "comment_edited"]);

export function IssueDetail({ id, me }: { id: number; me: Actor | null }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addArtifact, setAddArtifact] = useState(false);
  const [addCheck, setAddCheck] = useState(false);
  const [delArtifact, setDelArtifact] = useState<Artifact | null>(null);
  const [delCheck, setDelCheck] = useState<Check | null>(null);
  const [completeConfirm, setCompleteConfirm] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [addChildDirty, setAddChildDirty] = useState(false);
  const addChildClose = useConfirmClose(addChildDirty, () => setAddingChild(false));
  const [requestingReview, setRequestingReview] = useState(false);
  // Errors from the actions bar (state/lock changes) show inline next to it instead of replacing
  // the whole page the way a fatal load error does — e.g. a blocked "close as completed" (checks
  // not passing) is a normal, recoverable outcome, not a reason to lose the rest of the page.
  const [actionError, setActionError] = useState<string | null>(null);

  const load = () => api.getIssue(id).then(setDetail).catch((e) => setError(String(e)));

  useEffect(() => { load(); }, [id]);

  // Reference data, read through the shared cache: these are the same four responses every other
  // view wants, so after the first page of a session they cost nothing. The naming index replaces
  // what used to be a full `listIssues()` here — the ancestor chain, the parent/dependency pickers
  // and the `#123` autocomplete all only ever needed an issue's id, title and parent.
  const plugins = useResource<Plugins>(paths.plugins, api.plugins, REFERENCE_MAX_AGE).data ?? null;
  const groups = useResource<Group[]>(paths.groups, api.listGroups, REFERENCE_MAX_AGE).data ?? EMPTY;
  const allLabels = useResource<Label[]>(paths.labels, api.listLabels, REFERENCE_MAX_AGE).data ?? EMPTY;
  const allActors = useResource<Actor[]>(paths.actors, api.listActors, REFERENCE_MAX_AGE).data ?? EMPTY;
  const issueIndex = useResource<IssueIndexEntry[]>(paths.issueIndex, api.issueIndex, REFERENCE_MAX_AGE).data ?? EMPTY;

  const labelOpts = useMemo(() => allLabels.map((l) => ({ value: l.id, label: l.name })), [allLabels]);
  const actorOpts = useMemo(() => allActors.map((a) => ({ value: a.id, label: a.displayName })), [allActors]);
  const issueOpts = useMemo(
    () => breadcrumbOptions(issueIndex).filter((o) => o.value !== id),
    [issueIndex, id],
  );

  if (error) return <div className="panel error">{error}</div>;
  if (!detail) return <div className="muted">Loading…</div>;
  const { issue } = detail;

  // Persist a patch to the issue and refresh. Returns the promise so inline editors can await it.
  const patch = (body: Record<string, unknown>) => api.updateIssue(id, body).then(() => load());
  const setState = (state: string) => { setActionError(null); patch({ state }).catch((e) => setActionError(String(e))); };
  const del = () => api.deleteIssue(id).then(() => (window.location.hash = "#/issues"));

  const groupName = (g: number) => groups.find((x) => x.id === g)?.name ?? `#${g}`;
  const actorOf = (aid: number) => allActors.find((a) => a.id === aid);
  const labelName = (l: number) => allLabels.find((x) => x.id === l)?.name ?? `#${l}`;

  const canEdit = !!me;
  // When locked, the title, description, goal, parent and dependencies are frozen (labels,
  // assignees and visibility remain editable), mirroring the backend's locking rules.
  const editableUnlessLocked = canEdit && !issue.locked;
  const overdue = issue.deadline != null && issue.state === "open" && issue.deadline * 1000 < Date.now();
  // Marking an issue completed is blocked server-side while any attached check isn't passing —
  // unless the actor is an admin, who's allowed to bypass it (issue #3). Surfacing that here, and
  // asking for confirmation before an admin actually does it, makes the bypass visible instead of
  // marking-as-completed just silently succeeding.
  const failingChecks = detail.attachedChecks.filter((c) => c.status !== "passing");
  const completionBlocked = failingChecks.length > 0 && !me?.admin;

  const visibleGroups = me?.admin ? groups : groups.filter((g) => me?.groups.includes(g.id));

  const events = detail.events ?? [];
  const historyFor = (kind: string) => events.filter((e) => e.kind === kind);

  return (
    <div>
      <IssueBreadcrumbs issue={issue} index={issueIndex} />
      {issue.creatorName && (
        <div className="muted small" style={{ marginBottom: 6 }}>
          Created by <ActorName name={issue.creatorName} /> · {fmtTime(issue.createdAt)}
        </div>
      )}
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
        {canEdit && (
          <button className="small" style={{ marginLeft: 10 }} onClick={() => setAddingChild(true)}>
            + New child issue
          </button>
        )}
      </h2>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3 className="field-heading">Description <HistoryDropdown events={historyFor("description")} label="Description history" /></h3>
        </div>
        <InlineText
          value={issue.description ?? ""}
          canEdit={editableUnlessLocked}
          multiline
          placeholder="No description"
          onSave={(v) => patch({ description: v })}
          issues={issueIndex}
        />
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <h3 className="field-heading">Goal <HistoryDropdown events={historyFor("goal")} label="Goal history" /></h3>
        </div>
        <div className="muted small">The condition that must be fulfilled to complete this issue.</div>
        <InlineText
          value={issue.goal ?? ""}
          canEdit={editableUnlessLocked}
          multiline
          placeholder="No goal condition"
          onSave={(v) => patch({ goal: v })}
          issues={issueIndex}
        />
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

        <MetaRow label="Deadline" canEdit={canEdit}
          display={issue.deadline != null
            ? <span className={`small ${overdue ? "error" : ""}`}>{fmtTime(issue.deadline)}{overdue ? " (overdue)" : ""}</span>
            : <span className="muted small">none</span>}
          editor={(close) => <DeadlineEditor initial={issue.deadline}
            onSave={(v) => patch({ deadline: v })} onClose={close} onError={setError} />} />
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
        {detail.attachedChecks.length > 0 && (
          <div className="muted small" style={{ marginTop: 4 }}>
            A non-passing check here blocks "Close as completed" below — admins can bypass it.
          </div>
        )}
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

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Reviewers</h3>
          {me && <button onClick={() => setRequestingReview(true)}>+ Request review</button>}
        </div>
        {detail.reviewRequests.map((rr) => (
          <div key={rr.id} className="row" style={{ justifyContent: "space-between", borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
            <span className="small">
              <ActorName name={rr.actorName ?? `#${rr.actorId}`} />{" "}
              {rr.resolvedAt ? <span className="badge passing">reviewed</span> : <span className="badge pending">pending</span>}
              <span className="muted"> · requested by <ActorName name={rr.requestedByName ?? "someone"} /> · {fmtTime(rr.createdAt)}</span>
            </span>
            {me && !rr.resolvedAt && (
              <button className="danger" onClick={() => api.cancelReviewRequest(rr.id).then(load).catch((e) => setActionError(String(e)))}>
                Withdraw
              </button>
            )}
          </div>
        ))}
        {detail.reviewRequests.length === 0 && <div className="muted small" style={{ marginTop: 8 }}>No review requests</div>}
      </div>

      <Timeline
        detail={detail}
        me={me}
        actorOf={actorOf}
        labelName={labelName}
        groupName={groupName}
        index={issueIndex}
        onChange={load}
        onError={setError}
      />

      {me && (
        <>
          {actionError && <div className="panel error small">{actionError}</div>}
          <div className="actions-bar">
            <button
              onClick={() => (detail.participating ? api.unsubscribe(id) : api.subscribe(id)).then(load).catch((e) => setActionError(String(e)))}
              title={detail.participating ? "Stop getting notified about this issue" : "Get notified about this issue's activity"}
            >
              {detail.participating ? "🔕 Unsubscribe" : "🔔 Subscribe"}
            </button>
            {issue.state === "open" ? (
              <>
                <button onClick={() => setState("closed")}>Close</button>
                <button
                  onClick={() => (failingChecks.length > 0 ? setCompleteConfirm(true) : setState("completed"))}
                  disabled={completionBlocked}
                  title={completionBlocked
                    ? `Blocked: ${failingChecks.length} check(s) not passing (${failingChecks.map((c) => c.kind).join(", ")})`
                    : undefined}
                >
                  Close as completed
                </button>
              </>
            ) : (
              <button onClick={() => setState("open")}>Reopen</button>
            )}
            <button onClick={() => { setActionError(null); patch({ locked: !issue.locked }).catch((e) => setActionError(String(e))); }}>
              {issue.locked ? "🔓 Unlock" : "🔒 Lock"}
            </button>
            <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>
          </div>
        </>
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
      {requestingReview && (
        <RequestReviewModal
          issueId={issue.id}
          actors={allActors}
          onClose={() => setRequestingReview(false)}
          onDone={() => { setRequestingReview(false); load(); }}
        />
      )}
      {addingChild && (
        <Modal title={`New child issue of #${issue.id}`} onClose={addChildClose.requestClose}>
          <IssueForm
            me={me}
            embedded
            initialParent={issue.id}
            onCancel={addChildClose.requestClose}
            onDirtyChange={setAddChildDirty}
            onDone={(newId) => { setAddingChild(false); window.location.hash = `#/issues/${newId}`; }}
          />
        </Modal>
      )}
      {addChildClose.confirming && (
        <ConfirmModal
          title="Discard new issue?"
          message="You have unsaved changes. Discard them?"
          confirmLabel="Discard"
          danger
          onConfirm={addChildClose.confirmDiscard}
          onCancel={addChildClose.cancelDiscard}
        />
      )}
      {completeConfirm && (
        <ConfirmModal
          title="Complete with failing checks?"
          message={`${failingChecks.length} check(s) are not passing (${failingChecks.map((c) => c.kind).join(", ")}). As an admin you can bypass this and complete the issue anyway.`}
          confirmLabel="Complete anyway"
          onConfirm={() => { setCompleteConfirm(false); setState("completed"); }}
          onCancel={() => setCompleteConfirm(false)}
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
  value, canEdit, onSave, inline = false, multiline = false, placeholder, issues = [],
}: {
  value: string;
  canEdit: boolean;
  onSave: (v: string) => Promise<unknown>;
  inline?: boolean;
  multiline?: boolean;
  placeholder?: string;
  issues?: IssueIndexEntry[];
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
          ? <AutoTextarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
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
    ? <Markdown text={value} inline={inline} issues={issues} />
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
      <SearchableSelect options={options} value={val} onChange={setVal} />
      <span className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={save} disabled={busy}>Save</button>
        <button onClick={onClose} disabled={busy}>Cancel</button>
      </span>
    </span>
  );
}

// Inline deadline editor: a datetime-local input with Save/Cancel, plus a Clear button.
function DeadlineEditor({
  initial, onSave, onClose, onError,
}: {
  initial: number | null;
  onSave: (v: number | null) => Promise<unknown>;
  onClose: () => void;
  onError: (e: string) => void;
}) {
  const [val, setVal] = useState(unixToLocalInput(initial));
  const [busy, setBusy] = useState(false);
  const save = (v: string) => {
    setBusy(true);
    onSave(localInputToUnix(v)).then(onClose).catch((e) => onError(String(e))).finally(() => setBusy(false));
  };
  return (
    <span className="inline-edit">
      <input type="datetime-local" value={val} onChange={(e) => setVal(e.target.value)} />
      <span className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={() => save(val)} disabled={busy}>Save</button>
        {initial != null && <button onClick={() => save("")} disabled={busy}>Clear</button>}
        <button onClick={onClose} disabled={busy}>Cancel</button>
      </span>
    </span>
  );
}

// Modal to ask a specific actor to review the issue — independent of assignment.
function RequestReviewModal({
  issueId, actors, onClose, onDone,
}: {
  issueId: number;
  actors: Actor[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [actorId, setActorId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (actorId == null) { setErr("Choose who should review this."); return; }
    api.requestReview(issueId, actorId).then(onDone).catch((e2) => setErr(String(e2)));
  };

  return (
    <Modal title="Request review" onClose={onClose}>
      <form onSubmit={submit}>
        {err && <div className="error small">{err}</div>}
        <label>Reviewer</label>
        <SearchableSelect
          options={actors.map((a) => ({ value: a.id, label: a.displayName }))}
          value={actorId}
          onChange={setActorId}
          allowNone={false}
          placeholder="Choose an actor…"
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={actorId == null}>Request</button>
        </div>
      </form>
    </Modal>
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
              <HistoryDiff from={String(e.data.from ?? "")} to={String(e.data.to ?? "")} />
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// An inline word-level diff between two revisions of a title/description/comment: unchanged text
// plain, removed spans struck through, added spans highlighted — instead of showing the full old
// and new text as separate blocks.
function HistoryDiff({ from, to }: { from: string; to: string }) {
  const parts = diffWords(from, to);
  return (
    <div className="history-diff small">
      {parts.map((p, i) => {
        if (p.type === "equal") return <span key={i}>{p.text}</span>;
        if (p.type === "remove") return <span key={i} className="diff-remove">{p.text}</span>;
        return <span key={i} className="diff-add">{p.text}</span>;
      })}
    </div>
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
    case "deadline": {
      const to = d.to as number | null;
      return to == null ? "removed the deadline" : <>set the deadline to {new Date(to * 1000).toLocaleString()}</>;
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
              <AutoTextarea value={String(values[f.name] ?? "")} placeholder={f.placeholder ?? ""} onChange={(e) => setField(f.name, e.target.value)} />
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
  detail, me, actorOf, labelName, groupName, index, onChange, onError,
}: {
  detail: Detail;
  me: Actor | null;
  actorOf: (id: number) => Actor | undefined;
  labelName: (id: number) => string;
  groupName: (id: number) => string;
  index: IssueIndexEntry[];
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const comments = detail.comments ?? [];
  const events = detail.events ?? [];
  const ctx: EventCtx = { actorOf, labelName, groupName };
  const bodyAc = useIssueRefAutocomplete<HTMLTextAreaElement>(index, body, setBody);

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
          issues={index}
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

  const post = (review?: ReviewState) => {
    const text = body.trim();
    // An approving review needs no explanation; every other post (a plain comment, or a
    // request-changes review) must say something.
    if (!text && review !== "approve") return;
    setBusy(true);
    api.addComment(detail.issue.id, text, review)
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
        <form onSubmit={(e) => { e.preventDefault(); post(); }} style={{ marginTop: 12 }}>
          <div className="issue-ref-field">
            <AutoTextarea
              ref={bodyAc.elRef}
              value={body}
              onChange={bodyAc.onChangeWrapped}
              onKeyDown={bodyAc.onKeyDown}
              placeholder="Add a comment… (Markdown & LaTeX supported, type # to link an issue)"
            />
            <IssueRefMenu options={bodyAc.options} issues={index} onChoose={bodyAc.choose} pos={bodyAc.menuPos} menuRef={bodyAc.menuRef} />
          </div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
            <span className="muted small" style={{ marginRight: "auto" }}>Optionally post as a review:</span>
            <button type="button" className="danger" disabled={busy || !body.trim()} onClick={() => post("request_changes")}>
              ✗ Request changes
            </button>
            <button type="button" disabled={busy} onClick={() => post("approve")}>✓ Approve</button>
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
  comment: c, history, bot, canModify, issues, onChange, onError,
}: {
  comment: Comment;
  history: Event[];
  bot?: boolean;
  canModify: boolean;
  issues: IssueIndexEntry[];
  onChange: () => void;
  onError: (e: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  const save = () => {
    const text = draft.trim();
    if (!text && c.review !== "approve") return;
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
      {c.review && (
        <div className={`badge ${c.review === "approve" ? "passing" : "failing"}`} style={{ marginTop: 4 }}>
          {c.review === "approve" ? "✓ Approved" : "✗ Changes requested"}
        </div>
      )}
      {editing ? (
        <div style={{ marginTop: 6 }}>
          <AutoTextarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 6 }}>
            <button onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button className="primary" onClick={save} disabled={busy || (!draft.trim() && c.review !== "approve")}>Save</button>
          </div>
        </div>
      ) : (
        c.body.trim() && <div style={{ marginTop: 4 }}><Markdown text={c.body} issues={issues} /></div>
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
