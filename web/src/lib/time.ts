const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function unit(ms: number) {
  const a = Math.abs(ms);
  if (a < MIN) return "now";
  if (a < HOUR) return `${Math.round(a / MIN)}m`;
  if (a < DAY) return `${Math.round(a / HOUR)}h`;
  if (a < 30 * DAY) return `${Math.round(a / DAY)}d`;
  if (a < 365 * DAY) return `${Math.round(a / (30 * DAY))}mo`;
  return `${Math.round(a / (365 * DAY))}y`;
}

/** "5m ago", "just now", "in 2d". */
export function ago(iso: string, now = Date.now()) {
  const d = now - Date.parse(iso);
  const u = unit(d);
  if (u === "now") return "just now";
  return d >= 0 ? `${u} ago` : `in ${u}`;
}

export interface DueInfo {
  text: string;
  tone: "overdue" | "soon" | "later" | "none";
}

/** "in 2d", "3d overdue", "due today". */
export function due(iso: string | null, now = Date.now()): DueInfo {
  if (!iso) return { text: "No date", tone: "none" };
  const d = Date.parse(iso) - now;
  if (d < 0) {
    const u = unit(d);
    return { text: u === "now" ? "due now" : `${u} overdue`, tone: "overdue" };
  }
  const u = unit(d);
  if (d < DAY) return { text: u === "now" ? "due now" : `in ${u}`, tone: "soon" };
  return { text: `in ${u}`, tone: d < 2 * DAY ? "soon" : "later" };
}

export function fullDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
