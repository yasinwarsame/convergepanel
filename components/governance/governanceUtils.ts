/**
 * Client helpers for the org governance dashboard.
 */

export function formatRelativeTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const now = Date.now();
  const diff = Math.floor((now - t) / 1000);
  if (diff < 60) return `${Math.max(1, diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  const d = new Date(t);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (d >= startOfYesterday && d < startOfToday) return "yesterday";
  if (d >= startOfToday) return "today";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Full local date/time for tooltips (e.g. audit log hover). */
export function formatFullDatetime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Audit "Run by": never show a raw UID where an email is expected. */
export function formatAuditRunOwnerDisplay(runOwnerEmail?: string): string {
  const e = (runOwnerEmail ?? "").trim();
  if (e && e.includes("@")) return e;
  return "Unknown user";
}

export function truncateText(s: string, max: number): string {
  const t = (s || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export async function readApiErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const j = (await res.json()) as {
      error?: { message?: string };
      message?: string;
    };
    if (j?.error && typeof j.error.message === "string") return j.error.message;
    if (typeof j?.message === "string") return j.message;
  } catch {
    /* ignore */
  }
  return fallback;
}
