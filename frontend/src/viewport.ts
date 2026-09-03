import { useSyncExternalStore } from "react";

/**
 * Where the interface stops being a page and starts being an app.
 *
 * One number, named once, because two things have to agree about it: the stylesheet, whose media
 * queries move the navigation to the bottom of the screen and collapse the filter block, and the
 * components, which have to *render differently* rather than merely look different — a disclosure
 * that is closed by default is not something CSS can express.
 */
export const NARROW_MAX_PX = 720;

const query =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(`(max-width: ${NARROW_MAX_PX}px)`)
    : null;

function subscribe(fn: () => void): () => void {
  query?.addEventListener("change", fn);
  return () => query?.removeEventListener("change", fn);
}

const snapshot = (): boolean => query?.matches ?? false;

/** True on a phone-sized viewport. Follows a rotation or a resize, so nothing is decided once at
 *  startup and then left wrong. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
