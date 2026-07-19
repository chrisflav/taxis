import { useEffect, useState } from "react";
import type { Actor } from "../types";
import { api } from "../api";

const POLL_MS = 30_000;

// Just a badge + link to the full notifications page (search/filter/sort lives there — a small
// popover can't do that justice).
export function NotificationBell({ me, active = false }: { me: Actor | null; active?: boolean }) {
  const [unreadCount, setUnreadCount] = useState(0);

  const refreshCount = () => {
    if (me) api.unreadNotificationCount().then((r) => setUnreadCount(r.count)).catch(() => {});
  };
  useEffect(refreshCount, [me?.id]);
  useEffect(() => {
    if (!me) return;
    const t = setInterval(refreshCount, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [me?.id]);

  if (!me) return null;

  return (
    <a className={`notif-bell${active ? " active" : ""}`} href="#/notifications" title="Notifications">
      🔔{unreadCount > 0 && <span className="notif-count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
    </a>
  );
}
