import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api, childrenQuery, graphQuery, issuePagePath, paths } from "./api";
import { LIST_MAX_AGE, REFERENCE_MAX_AGE, cachedGet } from "./cache";
import "./styles.css";

// Start the reads every view needs immediately, rather than after `/me` resolves and the first
// view mounts. On a high-latency link that ordering cost a whole round trip before the app even
// asked for data; these share the session cookie with `/me`, so firing them alongside it is
// equivalent. Whichever view mounts first finds them cached or already in flight.
function prefetchReferenceData(): void {
  cachedGet(paths.labels, api.listLabels, REFERENCE_MAX_AGE).catch(() => {});
  cachedGet(paths.actors, api.listActors, REFERENCE_MAX_AGE).catch(() => {});
  cachedGet(paths.issueIndex, api.issueIndex, REFERENCE_MAX_AGE).catch(() => {});
}

// And the reads the *current route* needs, taken from the URL before React has mounted anything.
// Letting the view ask for its own data on mount put two avoidable round trips on the critical
// path of opening an issue — the bundle had to run, then `/me` had to answer, before the issue was
// so much as requested. Nothing about the issue read depended on either: the session cookie rides
// along with any request, so the server resolves the actor without the client knowing who it is.
//
// Only what the first paint needs goes here. `/plugins` and `/groups` back editors and modals, so
// the view can fetch them when it mounts without holding paint up, and crowding them in would push
// the reads that *do* paint past the browser's six-connections-per-origin limit.
function prefetchRoute(hash: string): void {
  const issue = hash.match(/^#\/issues\/(\d+)/);
  if (issue) {
    const id = Number(issue[1]);
    const children = childrenQuery(id);
    cachedGet(paths.issue(id), () => api.getIssue(id), LIST_MAX_AGE).catch(() => {});
    cachedGet(issuePagePath(children), () => api.issuePage(children), LIST_MAX_AGE).catch(() => {});
    return;
  }
  if (hash.startsWith("#/graph")) {
    cachedGet(paths.issues(graphQuery), () => api.listIssues(graphQuery), LIST_MAX_AGE).catch(() => {});
    return;
  }
  if (hash.startsWith("#/repos")) {
    // The unattached-dependencies toggle starts off, so this is the variant that gets drawn. It is
    // the slowest read in the application — it reads a package manifest per repository, over the
    // network — which makes it the one most worth starting before the view that wants it exists.
    cachedGet(paths.repoGraph(false), () => api.repoGraph(false), LIST_MAX_AGE).catch(() => {});
    return;
  }
  // `#/labels` needs nothing here: the label list is already in the reference prefetch above,
  // which is the whole reason that page should never have been asking for it a second time.
}

prefetchReferenceData();
prefetchRoute(window.location.hash);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
