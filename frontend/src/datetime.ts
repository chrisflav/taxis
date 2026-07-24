// Convert between Unix seconds (as stored/sent by the API) and the value format
// `<input type="datetime-local">` expects/produces ("YYYY-MM-DDTHH:mm", local time).

export function dateToLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function unixToLocalInput(ts: number | null): string {
  if (ts == null) return "";
  return dateToLocalInput(new Date(ts * 1000));
}

export function localInputToUnix(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

// Quick relative deadlines offered next to the datetime input, so the common cases don't need
// typing out a full date. `now` is a parameter rather than a `new Date()` call inside, which keeps
// the arithmetic pure and lets the semantics be checked against a fixed clock.
//
// The chosen semantics:
//   - "In an hour"  — `now` plus one hour, keeping the current minute; the only preset that isn't
//                     anchored to a time of day, because it means "shortly".
//   - "End of day"  — today at 23:59 local, i.e. the last minute the input can express for today.
//   - "Tomorrow"    — the next day at 09:00 local: a deadline for "tomorrow" is due during the day,
//                     not at midnight when it starts.
//   - "Next week"   — the same weekday one week out, also at 09:00 local, for the same reason.
//
// All of them go through `Date`'s setters, which normalise, so crossing the end of a month or year
// (and a daylight-saving change) needs no special casing.
export const DEADLINE_PRESETS: { label: string; at: (now: Date) => Date }[] = [
  {
    label: "In an hour",
    at: (now) => {
      const d = new Date(now.getTime());
      d.setHours(d.getHours() + 1);
      return d;
    },
  },
  {
    label: "End of day",
    at: (now) => {
      const d = new Date(now.getTime());
      d.setHours(23, 59, 0, 0);
      return d;
    },
  },
  {
    label: "Tomorrow",
    at: (now) => {
      const d = new Date(now.getTime());
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
  {
    label: "Next week",
    at: (now) => {
      const d = new Date(now.getTime());
      d.setDate(d.getDate() + 7);
      d.setHours(9, 0, 0, 0);
      return d;
    },
  },
];
