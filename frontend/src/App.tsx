import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { Actor } from "./types";
import { api } from "./api";
import { invalidateCache } from "./cache";
import { IssueList } from "./components/IssueList";
import { LoginBar } from "./components/Login";
import { NotificationBell } from "./components/NotificationBell";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  AdminSkeleton, GraphSkeleton, IssueFormSkeleton, IssueSkeleton, LabelsSkeleton,
  NotificationsSkeleton, ReposSkeleton, TokensSkeleton,
} from "./components/PageSkeleton";

// Views away from the issue list load on demand: the graphs in particular pull in their own
// layout and canvas code, which nobody browsing issues should have to download first.
const GraphView = lazy(() => import("./components/Graph").then((m) => ({ default: m.GraphView })));
const RepoGraphView = lazy(() => import("./components/RepoGraph").then((m) => ({ default: m.RepoGraphView })));
const LabelsPage = lazy(() => import("./components/Labels").then((m) => ({ default: m.LabelsPage })));
const Admin = lazy(() => import("./components/Admin").then((m) => ({ default: m.Admin })));
const TokensPage = lazy(() => import("./components/Tokens").then((m) => ({ default: m.TokensPage })));
const NotificationsPage = lazy(() =>
  import("./components/NotificationsPage").then((m) => ({ default: m.NotificationsPage })));
// Also opened as a modal from the issue list and the detail view, both of which load it lazily —
// so this route must too, or the static import here would pull it back into the entry chunk and
// undo the split for all three.
const IssueForm = lazy(() => import("./components/IssueForm").then((m) => ({ default: m.IssueForm })));
// The detail view is a third of the application's code — the timeline, the inline editors, the
// history diffs and the attachment plumbing — and it was the one route still loaded up front. Its
// data is prefetched from the URL before React mounts, so the chunk arrives alongside the response
// it will render rather than after it.
const IssueDetail = lazy(() => import("./components/IssueDetail").then((m) => ({ default: m.IssueDetail })));

// The same mark as the favicon, so the tab and the page agree on what this is. Drawn here rather
// than loaded from /icon.svg: it is smaller inline than the request would be.
function Turnstile() {
  return (
    <svg viewBox="0 0 32 32" width="19" height="19" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <g fill="var(--accent-fg)">
        <rect x="10" y="7.5" width="3.6" height="17" rx="1.8" />
        <rect x="10" y="14.2" width="12" height="3.6" rx="1.8" />
      </g>
    </svg>
  );
}

// Minimal hash-based routing to avoid a router dependency.
function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/issues");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/issues");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<Actor | null>(null);
  const [meLoaded, setMeLoaded] = useState(false);
  // Arriving anywhere with a "?notif=N" query (e.g. from a notification row's link) surfaces a
  // banner that stays up across navigation — to a different issue, the issue list, anywhere —
  // until the user explicitly dismisses it or resolves it, not just while on that one page.
  const [activeNotifId, setActiveNotifId] = useState<number | null>(null);

  const refreshMe = () =>
    api.me().then(setMe).catch(() => setMe(null)).finally(() => setMeLoaded(true));

  useEffect(() => { refreshMe(); }, []);

  // Cached responses are scoped to whoever was signed in when they were fetched — issue reads are
  // visibility-filtered per actor — so a sign-in or sign-out throws the whole cache away rather
  // than letting the next view paint the previous session's data.
  const lastIdentity = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (!meLoaded) return;
    const identity = me?.id ?? null;
    if (lastIdentity.current !== undefined && lastIdentity.current !== identity) invalidateCache();
    lastIdentity.current = identity;
  }, [me?.id, meLoaded]);

  // e.g. "#/issues/3/edit" -> ["issues", "3", "edit"]; a trailing "?..." (view-state query params,
  // e.g. "#/issues?parent=7") is stripped before splitting into path segments.
  const [pathPart, queryPart] = route.replace(/^#\/?/, "").split("?");
  const segments = pathPart.split("/").filter(Boolean);
  const top = segments[0] ?? "issues";
  const navClass = (t: string) => (top === t ? "active" : "");
  // The active tab is styled, but styling is not something a screen reader can hear.
  const navCurrent = (t: string) => (top === t ? ("page" as const) : undefined);

  // Pick up a "notif" query param from wherever it appears, mark it read, and immediately strip it
  // from the URL — its only job is to seed `activeNotifId`, after which the banner's lifetime is
  // fully decoupled from the URL (so it survives further navigation, unlike a URL-derived flag).
  useEffect(() => {
    const nidRaw = new URLSearchParams(queryPart ?? "").get("notif");
    if (nidRaw == null) return;
    const nid = Number(nidRaw);
    if (Number.isNaN(nid)) return;
    setActiveNotifId(nid);
    api.markNotificationRead(nid).catch(() => {});
    const stripped = `#/${pathPart}`;
    if (window.location.hash !== stripped) history.replaceState(null, "", stripped);
  }, [route]);

  const dismissNotifBanner = () => setActiveNotifId(null);
  // Just navigates — doesn't dismiss or resolve the notification, so the banner keeps showing
  // (e.g. on the notifications list itself) until the user acts on it or dismisses it explicitly.
  const goToNotifications = () => { window.location.hash = "#/notifications"; };
  const markNotifDone = () => {
    if (activeNotifId != null) api.markNotificationDone(activeNotifId).catch(() => {});
    setActiveNotifId(null);
    // The natural next step when working through a queue of notifications.
    window.location.hash = "#/notifications";
  };

  let view;
  if (top === "graph") view = <GraphView />;
  else if (top === "repos") view = <RepoGraphView />;
  else if (top === "labels") view = <LabelsPage me={me} />;
  else if (top === "notifications") view = <NotificationsPage me={me} />;
  else if (top === "tokens") view = <TokensPage me={me} />;
  else if (top === "admin") view = me?.admin ? <Admin /> : <div className="panel muted">Admin access required. Sign in as an administrator.</div>;
  else if (top === "issues" && segments[1] === "new") view = <IssueForm me={me} />;
  else if (top === "issues" && segments[1]) view = <IssueDetail id={Number(segments[1])} me={me} />;
  else view = <IssueList me={me} />;

  // What stands in for a view while its chunk is downloading. Every view above except the issue
  // list and the issue detail is loaded on demand, so this fallback is what a reader sees for the
  // whole of that download — and a bare "Loading…" there is exactly why those pages appeared to
  // arrive all at once, however carefully the view itself filled in afterwards. The skeletons draw
  // the page's real heading and its layout, so only the data is ever actually missing.
  let fallback;
  if (top === "graph") fallback = <GraphSkeleton />;
  else if (top === "repos") fallback = <ReposSkeleton />;
  else if (top === "labels") fallback = <LabelsSkeleton />;
  else if (top === "notifications") fallback = <NotificationsSkeleton />;
  else if (top === "tokens") fallback = <TokensSkeleton />;
  else if (top === "admin") fallback = <AdminSkeleton />;
  else if (top === "issues" && segments[1] === "new") fallback = <IssueFormSkeleton />;
  else if (top === "issues" && segments[1]) fallback = <IssueSkeleton id={Number(segments[1])} />;
  else fallback = null;

  return (
    <>
      {/* The bar carries only the surfaces you move between while working. Everything that belongs
          to your account — tokens, admin, the API reference, signing out — is behind the account
          control on the right, which also keeps the bar the same width signed in or out. */}
      {/* The bar's rule and background span the window, but its contents sit in the same column the
          page below uses — otherwise the wordmark and the account button hang off the far edges
          while everything they belong to is centred. */}
      <header className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="#/issues" aria-label="taxis — all issues">
            <Turnstile />
            <span>taxis</span>
          </a>
          <nav aria-label="Main">
            <a className={navClass("issues")} aria-current={navCurrent("issues")} href="#/issues">Issues</a>
            <a className={navClass("graph")} aria-current={navCurrent("graph")} href="#/graph">Graph</a>
            <a className={navClass("repos")} aria-current={navCurrent("repos")} href="#/repos">Repos</a>
            <a className={navClass("labels")} aria-current={navCurrent("labels")} href="#/labels">Labels</a>
          </nav>
          <div className="spacer" />
          {meLoaded && <NotificationBell me={me} active={top === "notifications"} />}
          <ThemeToggle />
          {meLoaded && <LoginBar me={me} onChange={refreshMe} />}
        </div>
      </header>
      {activeNotifId != null && (
        <div className="notif-banner">
          <span className="small">You're here from a notification.</span>
          <span className="row" style={{ marginLeft: "auto" }}>
            <button onClick={goToNotifications}>← Back</button>
            <button className="primary" onClick={markNotifDone}>Mark as done</button>
            <button onClick={dismissNotifBanner}>Dismiss</button>
          </span>
        </div>
      )}
      {/* Keying on the auth identity remounts the view whenever the user signs in or out, so it
          re-fetches and never shows data from the previous session.

          The view is *not* gated on `/me` having answered. Nothing it reads needs the answer —
          every request carries the session cookie, and the server resolves the actor from it — so
          waiting only meant staring at "Loading…" for a round trip before the page was even asked
          for. Until `/me` lands the view renders as a signed-out reader would see it, which costs
          the edit affordances a moment's delay and buys the whole page appearing at once. */}
      <main key={me ? `actor-${me.id}` : "anon"}>
        {/* Keyed on the route so switching pages swaps to that page's skeleton rather than
            holding the previous page on screen until the new one is ready. */}
        <Suspense key={top} fallback={fallback}>{view}</Suspense>
      </main>
    </>
  );
}
