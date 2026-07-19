// Convert between Unix seconds (as stored/sent by the API) and the value format
// `<input type="datetime-local">` expects/produces ("YYYY-MM-DDTHH:mm", local time).

export function unixToLocalInput(ts: number | null): string {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToUnix(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
