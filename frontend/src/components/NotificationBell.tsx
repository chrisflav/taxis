import { useEffect, useState } from "react";
import type { Actor } from "../types";
import { api } from "../api";
import { BellIcon } from "./Icon";

const POLL_MS = 30_000;

// Just a badge + link to the full notifications page (search/filter/sort lives there — a small
// popover can't do that justice).
export function NotificationBell({ me, active = false }: { me: Actor | null; active?: boolean }) {
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshCount = () => {
    if (me) api.unreadNotificationCount().then((r) => setUnreadCount(r.count)).catch(() => {});
  };
  useEffect(refreshCount, [me?.id]);
  // Polled only while the tab is being looked at. A background tab asking every thirty seconds
  // whether anything happened is a round trip per poll for the life of the tab — on a slow or
  // metered link that is the only traffic left once the page has loaded, and it never stops.
  // Coming back to the tab asks immediately, so the count is current when it is visible.
  useEffect(() => {
    if (!me) return;
    const poll = () => { if (document.visibilityState === "visible") refreshCount(); };
    const onVisible = () => { if (document.visibilityState === "visible") refreshCount(); };
    const t = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
    // eslint-disable-next-line
  }, [me?.id]);

  if (!me) return null;

  return (
    <a className={`notif-bell${active ? " active" : ""}`} href="#/notifications" title="Notifications">
      <BellIcon size={17} />
      {unreadCount > 0 && <span className="notif-count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
    </a>
  );
}
