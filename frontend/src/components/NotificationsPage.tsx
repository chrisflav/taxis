import { useEffect, useState } from "react";
import { PageHeader } from "./PageHeader";
import { PAGE_META } from "../pages";
import type { Actor, Label, Notification } from "../types";
import { api, paths } from "../api";
import { EMPTY, REFERENCE_MAX_AGE, useResource } from "../cache";
import { Pagination, usePagination } from "./Pagination";
import { SearchableSelect } from "./SearchableSelect";
import { IssueSelectPicker } from "./IssuePicker";
import { SortHeader, type SortState } from "./SortHeader";

// A short, kind-specific summary of a notification's activity — mirrors the issue timeline's
// event descriptions, but text-only (the row itself links through to the issue).
function describeNotification(n: Notification): string {
  switch (n.kind) {
    case "state": return "changed the state";
    case "locked": return "locked/unlocked the issue";
    case "parent": return "changed the parent";
    case "deadline": return "changed the deadline";
    case "dependencies": return "changed dependencies";
    case "assignees": return "changed assignees";
    case "visibility": return "changed visibility";
    case "labels": return "changed labels";
    case "artifact_added": return "attached an artifact";
    case "artifact_updated": return "edited an artifact";
    case "artifact_removed": return "removed an artifact";
    case "check_added": return "added a check";
    case "check_updated": return "edited a check";
    case "check_removed": return "removed a check";
    case "comment_edited": return "edited a comment";
    case "comment_deleted": return "deleted a comment";
    case "review": return "left a review";
    case "comment": return "commented";
    case "review_requested": return "requested your review";
    default: return n.kind;
  }
}

const KIND_OPTIONS = [
  "state", "locked", "parent", "deadline", "dependencies", "assignees", "visibility", "labels",
  "artifact_added", "artifact_updated", "artifact_removed", "check_added", "check_updated",
  "check_removed", "comment_edited",
  "comment_deleted", "review", "comment", "review_requested",
];

type SortKey = "issue" | "kind" | "status" | "date";
// Rank used to sort the Status column: unread-and-pending first, then read-and-pending, then done.
const statusRank = (n: Notification) => (n.done ? 2 : n.read ? 1 : 0);

interface NotifFilterState {
  q: string;
  kind: string;
  done: "" | "true" | "false";
  read: "" | "true" | "false";
  parent: number | null;
  label: number | null;
}

// Unread-only is the default inbox view — everything else is a deliberate opt-in, so it's the
// only filter omitted from the URL when it's at its default value.
const defaultNotifFilters: NotifFilterState = { q: "", kind: "", done: "", read: "false", parent: null, label: null };

function notifFiltersFromParams(params: URLSearchParams): NotifFilterState {
  return {
    q: params.get("q") ?? "",
    kind: params.get("kind") ?? "",
    done: (params.get("done") as NotifFilterState["done"]) ?? "",
    read: params.has("read") ? (params.get("read") as NotifFilterState["read"]) : "false",
    parent: params.get("parent") ? Number(params.get("parent")) : null,
    label: params.get("label") ? Number(params.get("label")) : null,
  };
}

function notifFiltersToParams(f: NotifFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.kind) params.set("kind", f.kind);
  if (f.done) params.set("done", f.done);
  if (f.read !== "false") params.set("read", f.read);
  if (f.parent != null) params.set("parent", String(f.parent));
  if (f.label != null) params.set("label", String(f.label));
  return params;
}

// Also mirrored to localStorage: the notification banner (see App.tsx) can send you back here
// from any page, not just the issue you came from, landing on a bare "#/notifications" with no
// query string — localStorage is what restores the filters in that case.
const NOTIF_FILTERS_STORAGE_KEY = "taxis:notif-filters";

function loadStoredNotifFilters(): NotifFilterState | null {
  try {
    const raw = localStorage.getItem(NOTIF_FILTERS_STORAGE_KEY);
    return raw ? { ...defaultNotifFilters, ...JSON.parse(raw) } : null;
  } catch {
    return null;
  }
}

// Preserves filters across the round-trip to an issue (via a notification row) and back: reads
// them from the current hash on mount (falling back to the last stored filters when the hash
// carries none), same pattern as IssueList's view-state persistence.
function readNotifFiltersFromHash(): NotifFilterState {
  const hash = window.location.hash || "";
  const qIndex = hash.indexOf("?");
  if (qIndex < 0) return loadStoredNotifFilters() ?? defaultNotifFilters;
  return notifFiltersFromParams(new URLSearchParams(hash.slice(qIndex + 1)));
}

// A small toolbar that appears once at least one notification is checked, bulk-marking them
// read or done.
function NotifBulkBar({
  selectedIds, onClear, onApplied,
}: {
  selectedIds: Set<number>;
  onClear: () => void;
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (action: "read" | "done") => {
    setBusy(true);
    setError(null);
    const fn = action === "read" ? api.markNotificationRead : api.markNotificationDone;
    Promise.all([...selectedIds].map((id) => fn(id)))
      .then(() => { onApplied(); onClear(); })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="panel bulk-bar row">
      <strong>{selectedIds.size} selected</strong>
      {error && <span className="error small">{error}</span>}
      <button onClick={() => apply("read")} disabled={busy}>Mark read</button>
      <button className="primary" onClick={() => apply("done")} disabled={busy}>Mark done</button>
      <button onClick={onClear} disabled={busy}>Clear selection</button>
    </div>
  );
}

export function NotificationsPage({ me }: { me: Actor | null }) {
  const [items, setItems] = useState<Notification[]>([]);
  // Labels name the label filter; the parent filter searches for its issue rather than being
  // handed every issue in the tracker to pick one out of.
  const labels = useResource<Label[]>(paths.labels, api.listLabels, REFERENCE_MAX_AGE).data ?? EMPTY;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initialFilters = useState(readNotifFiltersFromHash)[0];
  const [q, setQ] = useState(initialFilters.q);
  const [kind, setKind] = useState(initialFilters.kind);
  const [done, setDone] = useState(initialFilters.done);
  // Only unread notifications are shown by default — that's the actionable inbox; everything else
  // is one filter change away.
  const [read, setRead] = useState(initialFilters.read);
  const [parent, setParent] = useState(initialFilters.parent);
  const [label, setLabel] = useState(initialFilters.label);
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "date", dir: "desc" });
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Keep the URL in sync with the filters so navigating away (e.g. clicking into a notification)
  // and back preserves them — mirrors IssueList's view-state persistence.
  useEffect(() => {
    const state: NotifFilterState = { q, kind, done, read, parent, label };
    const params = notifFiltersToParams(state);
    const qsStr = params.toString();
    const next = "#/notifications" + (qsStr ? `?${qsStr}` : "");
    if (window.location.hash !== next) history.replaceState(null, "", next);
    try { localStorage.setItem(NOTIF_FILTERS_STORAGE_KEY, JSON.stringify(state)); } catch {}
  }, [q, kind, done, read, parent, label]);

  const load = () => {
    setLoading(true);
    api.listNotifications({
      q: q || undefined,
      kind: kind || undefined,
      done: done === "" ? undefined : done === "true",
      read: read === "" ? undefined : read === "true",
      parent: parent ?? undefined,
      label: label ?? undefined,
      limit: 500,
    })
      .then(setItems)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [q, kind, done, read, parent, label]);

  const defaultDir: Record<SortKey, "asc" | "desc"> = { issue: "asc", kind: "asc", status: "asc", date: "desc" };
  const onSort = (k: SortKey) =>
    setSort((s) => (s.key === k ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" } : { key: k, dir: defaultDir[k] }));

  const sorted = [...items].sort((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    let cmp = 0;
    switch (sort.key) {
      case "issue": cmp = a.issueTitle.localeCompare(b.issueTitle, undefined, { sensitivity: "base" }); break;
      case "kind": cmp = a.kind.localeCompare(b.kind); break;
      case "status": cmp = statusRank(a) - statusRank(b); break;
      case "date": cmp = a.createdAt - b.createdAt; break;
    }
    if (cmp === 0) cmp = b.createdAt - a.createdAt;
    return cmp * dir;
  });

  const pager = usePagination(sorted);
  useEffect(() => { pager.setPage(0); }, [q, kind, done, read, parent, label, sort.key, sort.dir]);

  const toggleSelected = (id: number) =>
    setSelected((s) => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const markRead = (n: Notification) =>
    api.markNotificationRead(n.id).then(load).catch((e) => setError(String(e)));
  const markDone = (n: Notification) =>
    api.markNotificationDone(n.id).then(load).catch((e) => setError(String(e)));
  const open = (n: Notification) => {
    api.markNotificationRead(n.id).catch(() => {});
    window.location.hash = `#/issues/${n.issueId}?notif=${n.id}`;
  };

  const labelOpts = labels.map((l) => ({ value: l.id, label: l.name }));

  if (!me) return <div className="panel muted">Sign in to see your notifications.</div>;

  return (
    <div>
      <PageHeader {...PAGE_META.notifications} />

      <div className="filters panel">
        <div>
          <label>Search (issue title)</label>
          <input placeholder="type to filter…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div>
          <label>Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">any</option>
            {KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div>
          <label>Read</label>
          <select value={read} onChange={(e) => setRead(e.target.value as typeof read)}>
            <option value="">any</option>
            <option value="false">unread</option>
            <option value="true">read</option>
          </select>
        </div>
        <div>
          <label>Done</label>
          <select value={done} onChange={(e) => setDone(e.target.value as typeof done)}>
            <option value="">any</option>
            <option value="false">not done</option>
            <option value="true">done</option>
          </select>
        </div>
        <div>
          <label>Parent issue</label>
          <IssueSelectPicker value={parent} onChange={setParent} placeholder="any parent" />
        </div>
        <div>
          <label>Label</label>
          <SearchableSelect options={labelOpts} value={label} onChange={setLabel} placeholder="any label" />
        </div>
      </div>

      {selected.size > 0 && (
        <NotifBulkBar selectedIds={selected} onClear={() => setSelected(new Set())} onApplied={load} />
      )}

      {error && <div className="panel error">{error}</div>}
      {loading ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="panel" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      checked={pager.pageItems.length > 0 && pager.pageItems.every((n) => selected.has(n.id))}
                      onChange={(e) => setSelected((s) => {
                        const next = new Set(s);
                        pager.pageItems.forEach((n) => (e.target.checked ? next.add(n.id) : next.delete(n.id)));
                        return next;
                      })}
                    />
                  </th>
                  <SortHeader label="Issue" k="issue" sort={sort} onSort={onSort} />
                  <SortHeader label="Type" k="kind" sort={sort} onSort={onSort} style={{ width: 140 }} />
                  <SortHeader label="Status" k="status" sort={sort} onSort={onSort} style={{ width: 110 }} />
                  <SortHeader label="Date" k="date" sort={sort} onSort={onSort} style={{ width: 140 }} />
                  <th style={{ width: 170 }}></th>
                </tr>
              </thead>
              <tbody>
                {pager.pageItems.map((n) => (
                  <tr key={n.id} className={`issue-row${n.read ? "" : " notif-unread"}`} onClick={() => open(n)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(n.id)} onChange={() => toggleSelected(n.id)} />
                    </td>
                    <td>
                      <strong className="small">#{n.issueId} {n.issueTitle}</strong>
                      <div className="muted small">{describeNotification(n)}</div>
                    </td>
                    <td className="small">{n.kind}</td>
                    <td>
                      {!n.read && <span className="badge pending">unread</span>}
                      {n.done && <span className="badge passing">done</span>}
                    </td>
                    <td className="muted small" title={new Date(n.createdAt * 1000).toLocaleString()}>
                      {new Date(n.createdAt * 1000).toLocaleString()}
                    </td>
                    <td className="row" onClick={(e) => e.stopPropagation()}>
                      {!n.read && <button onClick={() => markRead(n)}>Mark read</button>}
                      {!n.done && <button onClick={() => markDone(n)}>Mark done</button>}
                    </td>
                  </tr>
                ))}
                {pager.pageItems.length === 0 && (
                  <tr><td colSpan={6} className="muted" style={{ textAlign: "center", padding: 24 }}>No matching notifications</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination {...pager} />
        </>
      )}
    </div>
  );
}
