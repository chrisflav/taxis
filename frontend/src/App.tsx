import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { Actor } from "./types";
import { api } from "./api";
import { invalidateCache } from "./cache";
import { IssueList } from "./components/IssueList";
import { IssueDetail } from "./components/IssueDetail";
import { IssueForm } from "./components/IssueForm";
import { LoginBar } from "./components/Login";
import { NotificationBell } from "./components/NotificationBell";
import { ThemeToggle } from "./components/ThemeToggle";

// Views away from the issue list load on demand: the graphs in particular pull in their own
// layout and canvas code, which nobody browsing issues should have to download first.
const GraphView = lazy(() => import("./components/Graph").then((m) => ({ default: m.GraphView })));
const RepoGraphView = lazy(() => import("./components/RepoGraph").then((m) => ({ default: m.RepoGraphView })));
const LabelsPage = lazy(() => import("./components/Labels").then((m) => ({ default: m.LabelsPage })));
const Admin = lazy(() => import("./components/Admin").then((m) => ({ default: m.Admin })));
const TokensPage = lazy(() => import("./components/Tokens").then((m) => ({ default: m.TokensPage })));
const NotificationsPage = lazy(() =>
  import("./components/NotificationsPage").then((m) => ({ default: m.NotificationsPage })));

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
          re-fetches and never shows data from the previous session. */}
      <main key={me ? `actor-${me.id}` : "anon"}>
        {meLoaded
          ? <Suspense fallback={<div className="muted" style={{ padding: 20 }}>Loading…</div>}>{view}</Suspense>
          : <div className="muted" style={{ padding: 20 }}>Loading…</div>}
      </main>
    </>
  );
}
