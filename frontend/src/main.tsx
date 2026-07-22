import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { api, paths } from "./api";
import { REFERENCE_MAX_AGE, cachedGet } from "./cache";
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

prefetchReferenceData();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
