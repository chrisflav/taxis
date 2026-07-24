import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  Actor, Artifact, Check, Comment, Event, Group, Issue, IssueDetail as Detail,
  IssueListRow, IssuePage, IssueState, Label, Plugins, ReviewState,
} from "../types";
import { api, childrenQuery, issuePagePath, paths } from "../api";
import { EMPTY, LIST_MAX_AGE, REFERENCE_MAX_AGE, useResource } from "../cache";
import { Modal, ConfirmModal, useConfirmClose } from "./Modal";
import { LabelChip } from "./LabelChip";
import { Markdown } from "./Markdown";
import { MultiSelect } from "./MultiSelect";
import { AutoTextarea } from "./AutoTextarea";
import { ActorName } from "./ActorName";
import { DeadlinePresets } from "./DeadlinePresets";
import { IssueBreadcrumbs, SiblingNav } from "./Breadcrumbs";
import { diffWords } from "../diff";
import { localInputToUnix, unixToLocalInput } from "../datetime";
import { useIssueRefAutocomplete } from "../useIssueRefAutocomplete";
import { IssueRefMenu } from "./IssueRefMenu";
import { plainTitle } from "../breadcrumbs";
import { learnIssueNames, useIssueName, useKnownIssueName } from "../issueNames";
import { IssueMultiPicker, IssueSelectPicker } from "./IssuePicker";
import { fuzzyMatch } from "../fuzzy";
import { ClockIcon, LockedMark, TrashIcon } from "./Icon";
import type { CascadeState } from "./CascadeStateModal";

// Everything behind a button loads when that button is pressed. None of it is reachable without a
// deliberate action, and between them the three carry the whole issue-creation form and both
// attachment dialogues — code that every reader of every issue was previously made to download
// before the page could render.
const AttachModal = lazy(() => import("./AttachModal").then((m) => ({ default: m.AttachModal })));
const RequestReviewModal = lazy(() =>
  import("./AttachModal").then((m) => ({ default: m.RequestReviewModal })));
const IssueForm = lazy(() => import("./IssueForm").then((m) => ({ default: m.IssueForm })));
// Same reasoning, and it carries a request of its own: nobody who is merely reading an issue needs
// the dialogue that asks about its children, nor the list it fetches to ask with.
const CascadeStateModal = lazy(() =>
  import("./CascadeStateModal").then((m) => ({ default: m.CascadeStateModal })));

// Render a Unix (seconds) timestamp in the viewer's locale.
function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

// Event kinds shown as an edit-history dropdown next to their text rather than in the timeline.
const CONTENT_KINDS = new Set(["title", "description", "goal", "comment_edited"]);

export function IssueDetail({ id, me }: { id: number; me: Actor | null }) {
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addArtifact, setAddArtifact] = useState(false);
  const [addCheck, setAddCheck] = useState(false);
  const [editArtifact, setEditArtifact] = useState<Artifact | null>(null);
  const [editCheck, setEditCheck] = useState<Check | null>(null);
  const [delArtifact, setDelArtifact] = useState<Artifact | null>(null);
  const [delCheck, setDelCheck] = useState<Check | null>(null);
  const [completeConfirm, setCompleteConfirm] = useState(false);
  // The state a click asked for, held while the children prompt asks whether it should carry down.
  const [cascade, setCascade] = useState<CascadeState | null>(null);
  const [addingChild, setAddingChild] = useState(false);
  const [addChildDirty, setAddChildDirty] = useState(false);
  const addChildClose = useConfirmClose(addChildDirty, () => setAddingChild(false));
  const [requestingReview, setRequestingReview] = useState(false);
  // Errors from the actions bar (state/lock changes) show inline next to it instead of replacing
  // the whole page the way a fatal load error does — e.g. a blocked "close as completed" (checks
  // not passing) is a normal, recoverable outcome, not a reason to lose the rest of the page.
  const [actionError, setActionError] = useState<string | null>(null);

  // The issue itself, read through the same cache as everything else on this page rather than into
  // local state. Coming back to an issue — from the list, from a child, from the back button — then
  // repaints from the last response immediately and revalidates behind it, instead of blanking the
  // page for a round trip it has already made. `main.tsx` starts this read from the URL before
  // React mounts, so on a cold load it is usually already in flight by the time this runs.
  const detailRes = useResource<Detail>(paths.issue(id), () => api.getIssue(id), LIST_MAX_AGE);
  const detail = detailRes.data ?? null;
  const load = detailRes.reload;

  // Reference data, read through the shared cache: the same responses every other view wants, so
  // after the first page of a session they cost nothing.
  //
  // The naming index is gone from here entirely. The ancestor chain and the sibling links arrive
  // with the issue, the pickers search the tracker instead of holding it, and a `#123` in the prose
  // asks for that issue by number — so what used to be 140 KB of every issue's name, on the
  // critical path of every issue page, is now nothing at all.
  const allLabels = useResource<Label[]>(paths.labels, api.listLabels, REFERENCE_MAX_AGE).data ?? EMPTY;
  const allActors = useResource<Actor[]>(paths.actors, api.listActors, REFERENCE_MAX_AGE).data ?? EMPTY;
  // Plugin kinds describe the attachment dialogues and groups describe the visibility editor:
  // neither is on the page until somebody opens one, so neither is read until then. The exception
  // is an issue that is actually restricted, whose rail names the groups it is restricted to.
  const [editorsUsed, setEditorsUsed] = useState(false);
  const plugins = useResource<Plugins>(
    editorsUsed ? paths.plugins : null, api.plugins, REFERENCE_MAX_AGE).data ?? null;

  // This issue's children, read as rows rather than taken from the naming index: the index carries
  // no state or labels, and a container's children are worth showing with the same badges the list
  // shows.
  //
  // One page of them, not all. This used to fetch every child in a single response, which on a
  // container with a thousand of them was 32 KB gzipped sitting on the detail view's critical path
  // and growing with no bound. The page's `stateCounts` still describes *every* child, so the
  // progress line remains a fact about the issue rather than about what happened to be fetched.
  const childQuery = useMemo(() => childrenQuery(id), [id]);
  const childrenRes = useResource<IssuePage>(
    issuePagePath(childQuery), () => api.issuePage(childQuery), LIST_MAX_AGE);
  const children = childrenRes.data?.issues ?? EMPTY;

  const restricted = (detail?.issue.visibility.length ?? 0) > 0;
  const groups = useResource<Group[]>(
    editorsUsed || restricted ? paths.groups : null, api.listGroups, REFERENCE_MAX_AGE).data ?? EMPTY;

  // Every response this page reads names issues — its own ancestors and siblings, the children it
  // lists — so anything else that has to name one (a `#123` in the description, the parent chip)
  // is usually answered without a request of its own.
  useEffect(() => {
    if (!detail) return;
    learnIssueNames([
      { id: detail.issue.id, title: detail.issue.title, parent: detail.issue.parent },
      ...detail.ancestors,
      ...(detail.siblings?.prev ? [detail.siblings.prev] : []),
      ...(detail.siblings?.next ? [detail.siblings.next] : []),
    ]);
  }, [detail]);
  useEffect(() => { learnIssueNames(children); }, [children]);

  const labelOpts = useMemo(() => allLabels.map((l) => ({ value: l.id, label: l.name })), [allLabels]);
  const labelById = useMemo(() => new Map(allLabels.map((l) => [l.id, l])), [allLabels]);
  const actorOpts = useMemo(() => allActors.map((a) => ({ value: a.id, label: a.displayName })), [allActors]);
  // An issue may not be its own parent or its own dependency.
  const notSelf = useCallback((other: number) => other === id, [id]);

  if (error) return <div className="panel error">{error}</div>;
  // A failed *first* load has nothing to fall back on. A failed revalidation of an issue already on
  // screen is left to the inline error paths, rather than throwing away a good page.
  if (!detail && detailRes.error) return <div className="panel error">{detailRes.error}</div>;
  // Nothing to render the body from yet — but the page's structure does not depend on the body.
  // The id is in the URL and the naming index (prefetched, and usually warm) carries the title and
  // the ancestor chain, so the frame, the heading and the breadcrumbs are real from the first
  // paint and only the parts that genuinely need the response are placeheld.
  if (!detail) return <IssueSkeleton id={id} />;
  const { issue } = detail;

  // Persist a patch to the issue and refresh. Returns the promise so inline editors can await it.
  const patch = (body: Record<string, unknown>) => api.updateIssue(id, body).then(() => load());
  const setState = (state: string) => { setActionError(null); patch({ state }).catch((e) => setActionError(String(e))); };
  const del = () => api.deleteIssue(id).then(() => (window.location.hash = "#/issues"));

  // Set this issue's state, and the state of the children the prompt listed — there is no bulk
  // endpoint, so a cascade is one request per child. `allSettled`, because a child that refuses the
  // change (a check not passing, a lock, a visibility rule) is a fact about that child and not a
  // reason to abandon the rest or the issue the reader actually clicked; the refusals are counted
  // and said out loud instead. Only the listed children: the cascade never recurses into
  // grandchildren, so nothing is written that the prompt did not show.
  const applyState = (state: CascadeState, childIds: number[]) => {
    setCascade(null);
    setActionError(null);
    Promise.allSettled(childIds.map((c) => api.updateIssue(c, { state })))
      .then((rs) => rs.filter((r) => r.status === "rejected").length)
      .then((failed) => api.updateIssue(id, { state })
        .then(() => {
          if (failed > 0) {
            setActionError(
              `${failed} of ${childIds.length} child issues could not be set to ${state}.`);
          }
        })
        .catch((e) => setActionError(String(e))))
      // Children may have changed even where the issue itself refused, so refresh either way.
      .then(() => { load(); childrenRes.reload(); });
  };

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

  // Whether finishing this issue leaves unfinished work filed under it — counted over every child
  // by the server, not over the page the panel happens to hold. While that page is still in flight
  // the answer reads as "none", which skips the prompt rather than disabling the button: the prompt
  // is an offer to save the reader some clicks, and is not worth making them wait for.
  const openChildCount = childrenRes.data?.stateCounts?.open
    ?? children.filter((c) => c.state === "open").length;
  // Complete and close both mean something for the children; reopening an issue claims nothing
  // about them, so it goes straight through. Asked *after* the failing-checks bypass so the two
  // questions queue rather than fight over the screen.
  const requestStateChange = (state: CascadeState) =>
    (openChildCount > 0 ? setCascade(state) : setState(state));

  const visibleGroups = me?.admin ? groups : groups.filter((g) => me?.groups.includes(g.id));

  const events = detail.events ?? [];
  const historyFor = (kind: string) => events.filter((e) => e.kind === kind);

  return (
    <div>
      <div className="crumb-bar">
        <IssueBreadcrumbs ancestors={detail.ancestors ?? EMPTY} />
        <SiblingNav nav={detail.siblings} />
      </div>

      <div className="page-head">
        <h2 className="issue-title">
          <span className="issue-number">#{issue.id}</span>
          <InlineText
            value={issue.title}
            canEdit={editableUnlessLocked}
            inline
            onSave={(v) => patch({ title: v })}
          />
          <span className={`badge ${issue.state}`}>{issue.state}</span>
          {issue.locked && <LockedMark />}
          <HistoryDropdown events={historyFor("title")} label="Title history" />
        </h2>
        {issue.creatorName && (
          <div className="page-byline">
            Opened by <ActorName name={issue.creatorName} /> · {fmtTime(issue.createdAt)}
          </div>
        )}
      </div>

      {/* Substance on the left, relations on the right. The four attachment panels that used to
          stack down the page each announcing "None attached" now sit in the rail as one line
          apiece, which puts the children — the thing you actually navigate by — directly under
          the goal they belong to. */}
      <div className="issue-layout">
        <div>
          <div className="panel">
            <h3 className="field-heading">
              Description <HistoryDropdown events={historyFor("description")} label="Description history" />
            </h3>
            <InlineText
              value={issue.description ?? ""}
              canEdit={editableUnlessLocked}
              multiline
              placeholder="No description"
              onSave={(v) => patch({ description: v })}
            />

            <h3 className="field-heading" style={{ marginTop: 20 }}>
              Goal <HistoryDropdown events={historyFor("goal")} label="Goal history" />
            </h3>
            {/* An issue is an obligation, and this is the condition that discharges it — so it is
                set the way a goal is set in Lean, behind a turnstile. */}
            <div className="goal-block">
              <span className="goal-turnstile" aria-hidden="true">⊢</span>
              <div className="goal-body">
                <InlineText
                  value={issue.goal ?? ""}
                  canEdit={editableUnlessLocked}
                  multiline
                  placeholder="sorry — no goal stated yet"
                  placeholderClass="goal-sorry"
                  onSave={(v) => patch({ goal: v })}
                />
              </div>
            </div>
          </div>

          <ChildrenPanel
            parent={issue}
            items={children}
            total={childrenRes.data?.total ?? null}
            counts={childrenRes.data?.stateCounts ?? null}
            loading={childrenRes.loading}
            labelById={labelById}
            canEdit={canEdit}
            onAdd={() => { setEditorsUsed(true); setAddingChild(true); }}
          />

          <Timeline
            detail={detail}
            me={me}
            actorOf={actorOf}
            labelName={labelName}
            groupName={groupName}
            onChange={load}
            onError={setError}
          />
        </div>

        <aside className="issue-rail">
          <div className="panel">
            <MetaRow label="Labels" canEdit={canEdit}
              display={detail.issueLabels.length
                ? detail.issueLabels.map((l) => <LabelChip key={l.id} label={l} />)
                : <span className="rail-empty">None</span>}
              editor={(close) => <MultiEditor options={labelOpts} initial={issue.labels} placeholder="Add labels…"
                onSave={(v) => patch({ labels: v })} onClose={close} onError={setError} />} />

            <MetaRow label="Parent" canEdit={editableUnlessLocked}
              display={issue.parent != null
                ? <IssueRef id={issue.parent} />
                : <span className="rail-empty">None</span>}
              editor={(close) => <IssueSelectEditor initial={issue.parent} exclude={notSelf}
                onSave={(v) => patch({ parent: v })} onClose={close} onError={setError} />} />

            <MetaRow label="Depends on" canEdit={editableUnlessLocked}
              display={issue.dependencies.length
                ? issue.dependencies.map((p) => <IssueRef key={p} id={p} />)
                : <span className="rail-empty">Nothing</span>}
              editor={(close) => <IssueMultiEditor initial={issue.dependencies} exclude={notSelf}
                placeholder="Select dependencies…"
                onSave={(v) => patch({ dependencies: v })} onClose={close} onError={setError} />} />

            <MetaRow label="Assignees" canEdit={canEdit}
              display={detail.assignedActors.length
                ? detail.assignedActors.map((a) => <span key={a.id} className="chip"><ActorName name={a.displayName} bot={a.bot} /></span>)
                : <span className="rail-empty">Nobody</span>}
              editor={(close) => <MultiEditor options={actorOpts} initial={issue.assignees} placeholder="Assign actors…"
                onSave={(v) => patch({ assignees: v })} onClose={close} onError={setError} />} />

            <MetaRow label="Visible to" canEdit={canEdit} onOpen={() => setEditorsUsed(true)}
              display={issue.visibility.length
                ? issue.visibility.map((g) => <span key={g} className="chip">{groupName(g)}</span>)
                : <span className="rail-empty">Everyone</span>}
              editor={(close) => <MultiEditor options={visibleGroups.map((g) => ({ value: g.id, label: g.name }))}
                initial={issue.visibility} placeholder="Everyone (public)"
                onSave={(v) => patch({ visibility: v })} onClose={close} onError={setError} />} />

            <MetaRow label="Deadline" canEdit={canEdit}
              display={issue.deadline != null
                ? <span className={overdue ? "error" : undefined}>{fmtTime(issue.deadline)}{overdue ? " · overdue" : ""}</span>
                : <span className="rail-empty">None</span>}
              editor={(close) => <DeadlineEditor initial={issue.deadline}
                onSave={(v) => patch({ deadline: v })} onClose={close} onError={setError} />} />
          </div>

          <div className="panel">
            <div className="rail-section">
              <h3 className="panel-title">
                Artifacts <span className="count">{detail.attachedArtifacts.length || ""}</span>
                <span className="spacer" />
                {me && <button className="ghost" onClick={() => { setEditorsUsed(true); setAddArtifact(true); }}>Add</button>}
              </h3>
              {detail.attachedArtifacts.map((a) => (
                <div key={a.id} className="attach-row">
                  <span className="attach-main">
                    <span className="badge">{a.kind}</span>
                    {a.display.url
                      ? <a href={a.display.url} target="_blank" rel="noreferrer" className="small">{a.display.label}</a>
                      : <span className="muted small">{a.display.label}</span>}
                  </span>
                  {me && (
                    <span className="attach-actions">
                      <button className="ghost" title="Edit artifact" aria-label="Edit artifact"
                        onClick={() => { setEditorsUsed(true); setEditArtifact(a); }}>✎</button>
                      <button className="ghost" title="Remove artifact" aria-label="Remove artifact"
                        onClick={() => setDelArtifact(a)}>×</button>
                    </span>
                  )}
                </div>
              ))}
              {detail.attachedArtifacts.length === 0 && <div className="rail-empty">None attached</div>}
            </div>

            <div className="rail-section">
              <h3 className="panel-title">
                Checks <span className="count">{detail.attachedChecks.length || ""}</span>
                <span className="spacer" />
                {me && <button className="ghost" onClick={() => { setEditorsUsed(true); setAddCheck(true); }}>Add</button>}
              </h3>
              {detail.attachedChecks.map((c) => (
                <div key={c.id} className="attach-row">
                  <span className="attach-main">
                    <span className={`badge ${c.status}`}>{c.status}</span>
                    <span className="small">{c.kind}</span>
                    {c.detail && <span className="muted small">{c.detail}</span>}
                  </span>
                  {me && (
                    <span className="attach-actions">
                      <button className="ghost" title="Run this check now" onClick={() => api.runCheck(c.id).then(load)}>Run</button>
                      <button className="ghost" title="Edit check" aria-label="Edit check"
                        onClick={() => { setEditorsUsed(true); setEditCheck(c); }}>✎</button>
                      <button className="ghost" title="Remove check" aria-label="Remove check"
                        onClick={() => setDelCheck(c)}>×</button>
                    </span>
                  )}
                </div>
              ))}
              {detail.attachedChecks.length === 0
                ? <div className="rail-empty">None attached</div>
                : <div className="rail-empty" style={{ marginTop: 6 }}>
                    A check that is not passing blocks "Complete" — admins can bypass it.
                  </div>}
            </div>

            <div className="rail-section">
              <h3 className="panel-title">
                Reviewers <span className="count">{detail.reviewRequests.length || ""}</span>
                <span className="spacer" />
                {me && <button className="ghost" onClick={() => { setEditorsUsed(true); setRequestingReview(true); }}>Request</button>}
              </h3>
              {detail.reviewRequests.map((rr) => (
                <div key={rr.id} className="attach-row">
                  <span className="attach-main">
                    {rr.resolvedAt ? <span className="badge passing">reviewed</span> : <span className="badge pending">pending</span>}
                    <span className="small"><ActorName name={rr.actorName ?? `#${rr.actorId}`} /></span>
                  </span>
                  {me && !rr.resolvedAt && (
                    <button className="ghost" title="Withdraw review request"
                      onClick={() => api.cancelReviewRequest(rr.id).then(load).catch((e) => setActionError(String(e)))}>×</button>
                  )}
                </div>
              ))}
              {detail.reviewRequests.length === 0 && <div className="rail-empty">Nobody asked</div>}
            </div>
          </div>

          {me && (
            <div className="panel">
              {actionError && <div className="error small" style={{ marginBottom: 8 }}>{actionError}</div>}
              <div className="rail-actions">
                {issue.state === "open" ? (
                  <>
                    <button
                      className="primary"
                      onClick={() => (failingChecks.length > 0 ? setCompleteConfirm(true) : requestStateChange("completed"))}
                      disabled={completionBlocked}
                      title={completionBlocked
                        ? `Blocked: ${failingChecks.length} check(s) not passing (${failingChecks.map((c) => c.kind).join(", ")})`
                        : undefined}
                    >
                      Complete
                    </button>
                    <button onClick={() => requestStateChange("closed")}>Close without completing</button>
                  </>
                ) : (
                  <button className="primary" onClick={() => setState("open")}>Reopen</button>
                )}
                <button
                  onClick={() => (detail.participating ? api.unsubscribe(id) : api.subscribe(id)).then(load).catch((e) => setActionError(String(e)))}
                  title={detail.participating ? "Stop getting notified about this issue" : "Get notified about this issue's activity"}
                >
                  {detail.participating ? "Unsubscribe" : "Subscribe"}
                </button>
                <button onClick={() => { setActionError(null); patch({ locked: !issue.locked }).catch((e) => setActionError(String(e))); }}>
                  {issue.locked ? "Unlock editing" : "Lock editing"}
                </button>
              </div>
              <div className="rail-danger">
                <button className="danger" style={{ width: "100%" }} onClick={() => setConfirmDelete(true)}>Delete issue</button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Dialogues, all of them lazily loaded. `fallback={null}` because the alternative to
          a dialogue that appears a frame late is a spinner that appears a frame late; the
          chunk is small and same-origin, and after the first open it is in cache. */}
      <Suspense fallback={null}>
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
        {editArtifact && (
          <AttachModal
            title="Edit artifact"
            kinds={plugins?.artifactKinds ?? []}
            existing={{ kind: editArtifact.kind, value: editArtifact.payload }}
            onClose={() => setEditArtifact(null)}
            onSubmit={(_kind, value) => api.updateArtifact(editArtifact.id, value)}
            onDone={() => { setEditArtifact(null); load(); }}
          />
        )}
        {editCheck && (
          <AttachModal
            title="Edit check"
            kinds={plugins?.checkKinds ?? []}
            existing={{ kind: editCheck.kind, value: editCheck.config }}
            onClose={() => setEditCheck(null)}
            onSubmit={(_kind, value) => api.updateCheck(editCheck.id, value)}
            onDone={() => { setEditCheck(null); load(); }}
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
          <Modal title="New child issue" onClose={addChildClose.requestClose}>
            {/* Say which issue this child lands under. The parent's title is already loaded for
                this page, so naming it here — rather than a bare "#123" — spares the reader from
                opening the modal unsure of where the new issue will be filed. */}
            <div className="muted small" style={{ marginBottom: 12 }}>
              Child of <span className="issue-ref-id">#{issue.id}</span> · <Markdown text={issue.title} inline />
            </div>
            {/* Creating a child is a step in working *this* issue, so stay on it: `onDone` closes
                the modal and reloads the children list, and the new child appears in the panel
                above rather than yanking the reader off to a page they didn't ask for. */}
            <IssueForm
              me={me}
              embedded
              initialParent={issue.id}
              onCancel={addChildClose.requestClose}
              onDirtyChange={setAddChildDirty}
              onDone={() => { setAddingChild(false); childrenRes.reload(); }}
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
            onConfirm={() => { setCompleteConfirm(false); requestStateChange("completed"); }}
            onCancel={() => setCompleteConfirm(false)}
          />
        )}
        {cascade && (
          <CascadeStateModal
            parent={issue.id}
            state={cascade}
            onApply={(childIds) => applyState(cascade, childIds)}
            onCancel={() => setCascade(null)}
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
      </Suspense>
    </div>
  );
}

// The issue page before its response has arrived.
//
// The structure of an issue page is the same for every issue, so the frame, the heading and the
// layout are all real on the first paint and only the slots that genuinely need the response are
// placeheld. What used to happen here was a bare "Loading…", followed by the entire page appearing
// at once.
//
// The title comes from the naming store when the issue is already named there — which it is
// whenever you arrived from a list, a graph, a breadcrumb or a `#123` link, i.e. nearly always.
// Where it isn't, the heading is a placeholder rather than a request: the response carrying the
// real title is already in flight.
//
// The panels are laid out in the same grid as the real page, so nothing jumps when it fills in.
function IssueSkeleton({ id }: { id: number }) {
  const entry = useKnownIssueName(id);
  const bar = (width: string) => <span className="skeleton-line" style={{ width }} />;

  return (
    <div aria-busy="true">
      <div className="crumb-bar">
        <IssueBreadcrumbs ancestors={EMPTY} />
      </div>

      <div className="page-head">
        <h2 className="issue-title">
          <span className="issue-number">#{id}</span>
          {entry?.title ? <Markdown text={entry.title} inline /> : <span style={{ flex: 1 }}>{bar("24ch")}</span>}
        </h2>
      </div>

      <div className="issue-layout">
        <div>
          <div className="panel">
            <h3 className="field-heading">Description</h3>
            {bar("100%")}{bar("97%")}{bar("62%")}
            <h3 className="field-heading" style={{ marginTop: 20 }}>Goal</h3>
            <div className="goal-block">
              <span className="goal-turnstile" aria-hidden="true">⊢</span>
              <div className="goal-body" style={{ flex: 1 }}>{bar("55%")}</div>
            </div>
          </div>

          <div className="panel">
            <h3 className="panel-title">Children</h3>
            {bar("100%")}{bar("100%")}
          </div>

          <div className="panel">
            <h3 className="panel-title">Activity</h3>
            {bar("100%")}{bar("78%")}
          </div>
        </div>

        <aside className="issue-rail">
          <div className="panel">
            {["Labels", "Parent", "Depends on", "Assignees", "Visible to", "Deadline"].map((label) => (
              <div key={label} className="meta-row">
                <span className="meta-label muted small">{label}</span>
                <span className="meta-value" style={{ flex: 1 }}>{bar("9ch")}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

// A link to another issue that says which issue it is. A bare "#18" makes you visit it to find out
// what it was, which is the round trip this page is trying to stop making.
function IssueRef({ id }: { id: number }) {
  // Asked for by number, and batched with every other name this page needs — the parent chip and
  // six dependency chips are one request between them, not seven and not a copy of the tracker.
  const entry = useIssueName(id);
  const title = entry ? plainTitle(entry.title) : "";
  return (
    <a className="issue-ref" href={`#/issues/${id}`} title={title || undefined}>
      <span className="issue-ref-id">#{id}</span>
      {title ? ` ${title}` : ""}
    </a>
  );
}

// "Open" is what you almost always want to see in a container's children — the work that is left —
// so it's the default on a genuinely first-ever visit. But the choice, once made, belongs to the
// reader and not to the issue: every issue's page mounts a fresh ChildrenPanel, so to keep one
// setting across issues (and across a full reload, which a module-level variable would not survive)
// it's mirrored to localStorage under one shared key. Only the state tab is persisted; the search
// box stays per-view, since a query that helped find a child here rarely helps on the next issue.
const CHILD_STATE_STORAGE_KEY = "taxis:child-state-filter";

function loadChildStateFilter(): "" | IssueState {
  try {
    const raw = localStorage.getItem(CHILD_STATE_STORAGE_KEY);
    // Trust only a value from the known set; anything else (a stale or corrupted key) falls back
    // to the "open" default rather than filtering by a state the UI can't represent.
    if (raw === "" || raw === "open" || raw === "closed" || raw === "completed") return raw;
  } catch {
    // localStorage can throw in private-mode or otherwise blocked contexts; the default is fine.
  }
  return "open";
}

// The issues contained by this one, listed here rather than behind a link to a filtered issue list.
// Going one step down the containment tree used to mean leaving the issue for the search page and
// coming back, which is a round trip to answer "what is in this?" — a question the page it starts
// on should simply answer.
//
// The list stays here; the issue list stays the place for sorting, columns and bulk edits, and is
// one link away for anyone who wants them.
function ChildrenPanel({
  parent, items, total, counts, loading, labelById, canEdit, onAdd,
}: {
  parent: Issue;
  /** One page of children — not necessarily all of them. */
  items: IssueListRow[];
  /** How many children there are in total, however many were fetched. */
  total: number | null;
  /** Those children by state, so progress describes the issue and not the page. */
  counts: { open: number; closed: number; completed: number } | null;
  loading: boolean;
  labelById: Map<number, Label>;
  canEdit: boolean;
  onAdd: () => void;
}) {
  // Filtering here is deliberately two controls, not a copy of the issue list's filter bar: on a
  // container with thirty children the questions you ask in place are "which one was that" and
  // "what is still open". Anything beyond that is what the issue list is for, one link below.
  const [q, setQ] = useState("");
  const [state, setState] = useState<"" | IssueState>(loadChildStateFilter);

  // Persist the tab so the next issue's panel opens on the same filter.
  useEffect(() => {
    try { localStorage.setItem(CHILD_STATE_STORAGE_KEY, state); } catch {}
  }, [state]);

  // Counted over every child, not over the filtered view and not over the fetched page — this is
  // the issue's progress, and it should change neither because you typed in the search box nor
  // because the panel stopped fetching at a hundred rows. The server sends the breakdown with the
  // page; `items.length` is only a fallback for a response that predates it.
  const childCount = total ?? items.length;
  const done = counts?.completed ?? items.filter((c) => c.state === "completed").length;
  const open = counts?.open ?? items.filter((c) => c.state === "open").length;

  const shown = useMemo(
    () => items.filter((c) => (!state || c.state === state) && fuzzyMatch(q, c.title)),
    [items, q, state],
  );

  const STATE_TABS: { value: "" | IssueState; label: string }[] = [
    { value: "", label: "All" },
    { value: "open", label: "Open" },
    { value: "closed", label: "Closed" },
    { value: "completed", label: "Completed" },
  ];

  return (
    <div className="panel">
      <h3 className="panel-title">
        Children
        {childCount > 0 && <span className="count">{childCount} · {open} open · {done} completed</span>}
        <span className="spacer" />
        {canEdit && <button onClick={onAdd}>+ New child issue</button>}
      </h3>

      {/* How much of this obligation is discharged, as a line rather than another sentence. */}
      {childCount > 0 && (
        <div
          className="progress"
          role="img"
          aria-label={`${done} of ${childCount} children completed`}
        >
          <span style={{ width: `${Math.round((done / childCount) * 100)}%` }} />
        </div>
      )}

      {loading && items.length === 0 && (
        <div style={{ marginTop: 8 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="skeleton-line" style={{ width: `${72 - i * 14}%` }} />
          ))}
        </div>
      )}
      {!loading && childCount === 0 && (
        <div className="rail-empty" style={{ marginTop: 8 }}>
          Nothing is filed under this issue{canEdit ? " yet — add the first child above." : "."}
        </div>
      )}

      {childCount > 0 && (
        <div className="child-filters">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter these children…"
            aria-label="Filter children by title"
          />
          <div className="segmented compact">
            {STATE_TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={state === t.value ? "active" : ""}
                onClick={() => setState(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {/* Always rendered, so the row never changes shape. Filling this in used to squeeze the
              flexible search box and shove the state tabs sideways on every keystroke. */}
          <span className="child-count" aria-live="polite">
            {shown.length !== items.length ? `${shown.length} of ${items.length}` : ""}
          </span>
        </div>
      )}

      {shown.map((c) => (
        <a key={c.id} className="child-row" href={`#/issues/${c.id}`}>
          <span className="child-id">#{c.id}</span>
          <span className="child-title"><Markdown text={c.title} inline /></span>
          {c.locked && <LockedMark />}
          {c.labels.map((l) => { const lbl = labelById.get(l); return lbl ? <LabelChip key={l} label={lbl} /> : null; })}
          {/* Last and right-aligned in a fixed slot, so every row's state reads down one column
              instead of landing wherever that row's labels happen to end. */}
          <span className="child-state"><span className={`badge ${c.state}`}>{c.state}</span></span>
        </a>
      ))}

      {childCount > 0 && shown.length === 0 && (
        <div className="rail-empty" style={{ padding: "14px 0 4px" }}>
          {items.length < childCount
            ? "No match among the children loaded here — the issue list searches all of them."
            : "No child matches that."}
        </div>
      )}

      {childCount > 0 && (
        <div className="small" style={{ marginTop: 12 }}>
          {items.length < childCount && (
            <div className="muted" style={{ marginBottom: 4 }}>
              Showing {items.length} of {childCount}.
            </div>
          )}
          <a href={`#/issues?parents=${parent.id}`}>Open these in the issue list →</a>
        </div>
      )}
    </div>
  );
}

// An inline-editable text value: renders the value (as markdown), and — for editors — a pencil that
// swaps the block for an input/textarea with Save/Cancel, leaving the rest of the page in place.
function InlineText({
  value, canEdit, onSave, inline = false, multiline = false, placeholder, placeholderClass,
}: {
  value: string;
  canEdit: boolean;
  onSave: (v: string) => Promise<unknown>;
  inline?: boolean;
  multiline?: boolean;
  placeholder?: string;
  /** Lets a caller style its own empty state — the goal's is `sorry`, not grey filler text. */
  placeholderClass?: string;
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
    ? <Markdown text={value} inline={inline} />
    : <span className={placeholderClass ?? "muted"}>{placeholder ?? "empty"}</span>;
  return (
    <span className={inline ? "editable editable-inline" : "editable"}>
      {body}
      {canEdit && <button className="edit-pencil" title="Edit" onClick={begin}>✎</button>}
    </span>
  );
}

// A labelled metadata row with inline editing: shows the value plus a pencil that reveals `editor`.
function MetaRow({
  label, canEdit, display, editor, onOpen,
}: {
  label: string;
  canEdit: boolean;
  display: ReactNode;
  editor: (close: () => void) => ReactNode;
  /** Called when the editor is revealed. What an editor needs and the page does not — the group
      list, the plugin kinds — is read then rather than on every page load. */
  onOpen?: () => void;
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
          {canEdit && <button className="edit-pencil" title={`Edit ${label.toLowerCase()}`}
            onClick={() => { onOpen?.(); setEditing(true); }}>✎</button>}
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

// The same two editors over an issue picker, which searches the tracker rather than being handed
// every issue in it. Separate components rather than a prop on the ones above, because what they
// take is a *query*, not an option list.
function IssueMultiEditor({
  initial, placeholder, exclude, onSave, onClose, onError,
}: {
  initial: number[];
  placeholder?: string;
  exclude?: (id: number) => boolean;
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
      <IssueMultiPicker selected={sel} onChange={setSel} placeholder={placeholder} exclude={exclude} />
      <span className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={save} disabled={busy}>Save</button>
        <button onClick={onClose} disabled={busy}>Cancel</button>
      </span>
    </span>
  );
}

function IssueSelectEditor({
  initial, exclude, onSave, onClose, onError,
}: {
  initial: number | null;
  exclude?: (id: number) => boolean;
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
      <IssueSelectPicker value={val} onChange={setVal} exclude={exclude} />
      <span className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={save} disabled={busy}>Save</button>
        <button onClick={onClose} disabled={busy}>Cancel</button>
      </span>
    </span>
  );
}

// Inline deadline editor: a datetime-local input with Save/Cancel, plus a Clear button and a row of
// quick relative presets that fill the input without saving.
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
      <DeadlinePresets onPick={setVal} />
      <span className="row" style={{ marginTop: 6 }}>
        <button className="primary" onClick={() => save(val)} disabled={busy}>Save</button>
        {initial != null && <button onClick={() => save("")} disabled={busy}>Clear</button>}
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
        <ClockIcon size={12} /> {events.length} edit{events.length === 1 ? "" : "s"}
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
    case "artifact_updated":
      return <>edited the <span className="badge">{String(d.kind ?? "")}</span> artifact{d.label ? <> ({String(d.label)})</> : null}</>;
    case "artifact_removed":
      return <>removed a <span className="badge">{String(d.kind ?? "")}</span> artifact</>;
    case "check_added":
      return <>added a <span className="badge">{String(d.kind ?? "")}</span> check</>;
    case "check_updated":
      return <>edited the <span className="badge">{String(d.kind ?? "")}</span> check — it needs running again</>;
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
  const bodyAc = useIssueRefAutocomplete<HTMLTextAreaElement>(body, setBody);

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
      <h3 className="panel-title">
        Activity
        <span className="count">{comments.length} comment{comments.length === 1 ? "" : "s"}</span>
      </h3>
      {items.length === 0 && <div className="rail-empty">No activity yet.</div>}
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
            <IssueRefMenu options={bodyAc.options} onChoose={bodyAc.choose} pos={bodyAc.menuPos} menuRef={bodyAc.menuRef} />
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
              aria-label="Delete comment" onClick={() => setConfirmDel(true)}><TrashIcon size={13} /></button>
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
        c.body.trim() && <div style={{ marginTop: 4 }}><Markdown text={c.body} /></div>
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
