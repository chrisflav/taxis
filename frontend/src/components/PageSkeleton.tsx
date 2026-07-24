import { PageHeader } from "./PageHeader";
import { PAGE_META } from "../pages";

/**
 * The architecture of each page, drawn while that page is still on its way.
 *
 * These deliberately live here rather than beside the views they stand in for. Every view except
 * the issue list and the issue detail is loaded on demand, and a view that has not been downloaded
 * cannot draw its own frame — the frame is precisely what should be on screen *while its chunk is
 * downloading*. Rendered as the `Suspense` fallback in `App`, so arriving at a page puts its
 * heading, its controls and the shape of its content up immediately, and the data fills in after.
 *
 * Every view is loaded on demand now, including the issue detail — which is a third of the
 * application's code and was the last route still arriving up front. Before any of this, each of
 * them showed a bare "Loading…" and then the whole page at once, which is the thing this stops.
 *
 * Headings are the real ones (see `PAGE_META`) — a page's title is a fact about the page, not
 * about its data.
 */

/** One placeholder bar, sized like the text it stands in for. */
function Bar({ w, h }: { w: string; h?: number }) {
  return <span className="skeleton-line" style={{ width: w, ...(h ? { height: h } : {}) }} />;
}

/** The controls strip both graphs put above their canvas. */
function ControlsRow() {
  return (
    <div className="row" style={{ marginBottom: 12, justifyContent: "space-between" }}>
      <div className="row"><Bar w="160px" h={30} /><Bar w="120px" h={30} /></div>
      <Bar w="90px" h={30} />
    </div>
  );
}

/** The canvas frame, at the height the graph will occupy so nothing moves when it arrives. */
function CanvasFrame({ note }: { note: string }) {
  return (
    <div className="graph-viewport graph-viewport-empty">
      <span className="muted small">{note}</span>
    </div>
  );
}

function TableSkeleton({ headers, rows = 4 }: { headers: ReadonlyArray<string>; rows?: number }) {
  return (
    <div className="panel" style={{ padding: 0, marginTop: 12 }}>
      <table>
        <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              {headers.map((h, j) => <td key={h}>{j === 0 ? <Bar w="3ch" /> : <Bar w={j === 1 ? "9ch" : "55%"} />}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LabelsSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader {...PAGE_META.labels} />
      <Bar w="320px" h={32} />
      <TableSkeleton headers={["#", "Label", "Description", ""]} />
    </div>
  );
}

export function GraphSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader {...PAGE_META.graph} />
      <div className="row" style={{ marginBottom: 12 }}><Bar w="100%" h={34} /></div>
      <ControlsRow />
      <p className="canvas-legend">
        Arrows point from an issue to the dependency it needs. Scroll to zoom, drag to pan, hover to
        trace, click to open.
      </p>
      <CanvasFrame note="Laying out the graph…" />
    </div>
  );
}

export function ReposSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader {...PAGE_META.repos} />
      <ControlsRow />
      <p className="canvas-legend">
        Nodes are repositories attached to issues; arrows point from a repository to one it depends
        on, read from its package manifests. Scroll to zoom, drag to pan, hover to trace, click to
        open the repository.
      </p>
      <CanvasFrame note="Reading each repository's package manifests…" />
    </div>
  );
}

export function NotificationsSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader {...PAGE_META.notifications} />
      <div className="row" style={{ marginBottom: 12 }}><Bar w="100%" h={34} /></div>
      <div className="panel">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} style={{ padding: "10px 0", borderTop: i ? "1px solid var(--border)" : undefined }}>
            <Bar w="42%" /><Bar w="70%" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TokensSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader {...PAGE_META.tokens} />
      <TableSkeleton headers={["#", "Name", "Prefix", "Created"]} rows={3} />
    </div>
  );
}

export function AdminSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader {...PAGE_META.admin} />
      <TableSkeleton headers={["#", "Name", "Email", ""]} />
      <TableSkeleton headers={["#", "Group", "Description", ""]} rows={2} />
    </div>
  );
}

/** The issue detail view, whose chunk is on its way.
 *
 *  A plainer relative of the skeleton inside `IssueDetail` itself: that one can name the issue,
 *  because by the time it runs it has the naming index in hand. This one runs *before* that code
 *  exists, so it draws the frame and the issue number — which the URL supplies — and lets the
 *  richer version take over when the chunk lands. */
export function IssueSkeleton({ id }: { id: number }) {
  return (
    <div aria-busy="true">
      <div className="crumb-bar"><Bar w="22ch" /></div>
      <div className="page-head">
        <h2 className="issue-title">
          <span className="issue-number">#{id}</span>
          <span style={{ flex: 1 }}><Bar w="24ch" /></span>
        </h2>
      </div>
      <div className="issue-layout">
        <div>
          <div className="panel">
            <h3 className="field-heading">Description</h3>
            <Bar w="100%" /><Bar w="97%" /><Bar w="62%" />
            <h3 className="field-heading" style={{ marginTop: 20 }}>Goal</h3>
            <div className="goal-block">
              <span className="goal-turnstile" aria-hidden="true">⊢</span>
              <div className="goal-body" style={{ flex: 1 }}><Bar w="55%" /></div>
            </div>
          </div>
          <div className="panel">
            <h3 className="panel-title">Children</h3><Bar w="100%" /><Bar w="100%" />
          </div>
          <div className="panel">
            <h3 className="panel-title">Activity</h3><Bar w="100%" /><Bar w="78%" />
          </div>
        </div>
        <aside className="issue-rail">
          <div className="panel">
            {["Labels", "Parent", "Depends on", "Assignees", "Visible to", "Deadline"].map((label) => (
              <div key={label} className="meta-row">
                <span className="meta-label muted small">{label}</span>
                <span className="meta-value" style={{ flex: 1 }}><Bar w="9ch" /></span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** The new-issue form, which is also loaded on demand. */
export function IssueFormSkeleton() {
  return (
    <div aria-busy="true">
      <PageHeader title="New issue" description="Describe the obligation and the condition that discharges it." />
      <div className="panel">
        <Bar w="12%" /><Bar w="100%" h={32} />
        <div style={{ height: 12 }} />
        <Bar w="18%" /><Bar w="100%" h={90} />
        <div style={{ height: 12 }} />
        <Bar w="14%" /><Bar w="100%" h={60} />
      </div>
    </div>
  );
}
