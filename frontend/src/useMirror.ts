import { useSyncExternalStore } from "react";
import { mirrorAvailable, mirrorRevision, subscribeMirror } from "./mirror";
import { isNativeApp } from "./server";
import { useSyncState } from "./sync";

/**
 * Whether a view should read the tracker off the device rather than off the server.
 *
 * Shared by the three views that draw the whole tracker — the list, the tree and the graph — so
 * they agree about where their rows come from. They would otherwise disagree during the one moment
 * it matters: a first launch, where the mirror is still filling and each view decides for itself
 * whether it is worth waiting for.
 *
 * False until local storage has said what it holds (`known`), which is deliberately not the same as
 * "false because nothing is stored": guessing the second would cost a request per launch for a
 * tracker already sitting on the device. `isNativeApp` is a build-time constant, so on the web this
 * folds to `false` and takes the mirror out of that bundle entirely.
 */
export function useLocalFirst(): boolean {
  const { stored, known } = useSyncState();
  return isNativeApp && mirrorAvailable && known && stored > 0;
}

/**
 * True while the app still does not know whether it holds a copy.
 *
 * A view with this should ask for nothing and wait: the answer is a local storage read away, and
 * whichever way it goes it decides where the data comes from.
 */
export function useLocalUndecided(): boolean {
  const { known } = useSyncState();
  return isNativeApp && mirrorAvailable && !known;
}

/** A counter that moves whenever the stored copy changes, so a view reading it knows to read
 *  again. `sync.ts` is what moves it, by applying what the change feed delivered. */
export function useMirrorRevision(): number {
  return useSyncExternalStore(subscribeMirror, mirrorRevision, mirrorRevision);
}
