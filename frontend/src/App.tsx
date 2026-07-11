import { useEffect, useState } from "react";
import type { Actor } from "./types";
import { api } from "./api";
import { IssueList } from "./components/IssueList";
import { IssueDetail } from "./components/IssueDetail";
import { IssueForm } from "./components/IssueForm";
import { GraphView } from "./components/Graph";
import { LabelsPage } from "./components/Labels";
import { Admin } from "./components/Admin";
import { TokensPage } from "./components/Tokens";
import { LoginBar } from "./components/Login";

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

  const refreshMe = () =>
    api.me().then(setMe).catch(() => setMe(null)).finally(() => setMeLoaded(true));

  useEffect(() => { refreshMe(); }, []);

  // e.g. "#/issues/3/edit" -> ["issues", "3", "edit"]
  const segments = route.replace(/^#\/?/, "").split("/").filter(Boolean);
  const top = segments[0] ?? "issues";
  const navClass = (t: string) => (top === t ? "active" : "");

  let view;
  if (top === "graph") view = <GraphView />;
  else if (top === "labels") view = <LabelsPage me={me} />;
  else if (top === "tokens") view = <TokensPage me={me} />;
  else if (top === "admin") view = me?.admin ? <Admin /> : <div className="panel muted">Admin access required. Sign in as an administrator.</div>;
  else if (top === "issues" && segments[1] === "new") view = <IssueForm me={me} />;
  else if (top === "issues" && segments[1]) view = <IssueDetail id={Number(segments[1])} me={me} />;
  else view = <IssueList me={me} />;

  return (
    <>
      <header className="topbar">
        <h1>Issue Tracker</h1>
        <nav>
          <a className={navClass("issues")} href="#/issues">Issues</a>
          <a className={navClass("graph")} href="#/graph">Graph</a>
          <a className={navClass("labels")} href="#/labels">Labels</a>
          {me && <a className={navClass("tokens")} href="#/tokens">Tokens</a>}
          {me?.admin && <a className={navClass("admin")} href="#/admin">Admin</a>}
          <a href="/docs" target="_blank" rel="noreferrer">API ↗</a>
        </nav>
        <div className="spacer" />
        {meLoaded && <LoginBar me={me} onChange={refreshMe} />}
      </header>
      {/* Keying on the auth identity remounts the view whenever the user signs in or out, so it
          re-fetches and never shows data from the previous session. */}
      <main key={me ? `actor-${me.id}` : "anon"}>
        {meLoaded ? view : <div className="muted" style={{ padding: 20 }}>Loading…</div>}
      </main>
    </>
  );
}
