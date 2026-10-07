/**
 * Roadmap 4.2b — the Governance Review Queue's two data sources and how they
 * combine into what the dashboard shows.
 *
 * - PENDING: `GET /api/governance/queue?status=needs_review` — complete for the
 *   reviewer's scope, with an exact `total`. It is the ONLY source of the
 *   pending list and the pending count.
 * - HISTORY: `GET /api/governance/queue?status=all` — a bounded snapshot (recent
 *   window, row caps). It supplies approved/blocked rows only; any pending rows
 *   it happens to contain are ignored, so it can never add, remove or count a
 *   pending item.
 *
 * The two loads fail independently. A failed history load leaves a loaded
 * pending queue intact; a failed pending load is surfaced as an error and is
 * never papered over with the bounded snapshot.
 */

export const QUEUE_VIEW_CAP = 50;

export type QueueStatusFilter = "needs_review" | "blocked" | "approved" | "all";
export type QueueRunTypeFilter = "all" | "research" | "verification" | "video";

export type QueueViewRow = {
  runId: string;
  collection: string;
  runType: "research" | "verification" | "video";
  governanceStatus: "approved" | "needs_review" | "blocked";
};

export type PendingSource<T> =
  | { state: "loading" }
  | { state: "ok"; rows: T[]; total: number }
  | { state: "error"; message: string };

export type HistorySource<T> =
  | { state: "loading" }
  | { state: "ok"; rows: T[] }
  | { state: "error"; message: string };

export type QueueStats = {
  needs: number | null;
  blocked: number | null;
  approved: number | null;
  total: number | null;
};

export type QueueView<T> = {
  rows: T[];
  /** "Showing X of N pending" when the pending response holds fewer rows than its total. */
  pendingNote: string | null;
  errors: string[];
  stats: QueueStats;
  loading: boolean;
};

const rowKey = (r: QueueViewRow) => `${r.collection}:${r.runId}`;

function matchesRunType(r: QueueViewRow, t: QueueRunTypeFilter): boolean {
  return t === "all" || r.runType === t;
}

export function buildQueueView<T extends QueueViewRow>(args: {
  pending: PendingSource<T>;
  history: HistorySource<T>;
  status: QueueStatusFilter;
  runType: QueueRunTypeFilter;
}): QueueView<T> {
  const { pending, history, status, runType } = args;
  const pendingRows = pending.state === "ok" ? pending.rows.filter((r) => r.governanceStatus === "needs_review") : [];
  const pendingKeys = new Set(pendingRows.map(rowKey));
  // History contributes decided rows only, and never a row the pending source owns.
  const decided = history.state === "ok"
    ? history.rows.filter((r) => r.governanceStatus !== "needs_review" && !pendingKeys.has(rowKey(r)))
    : [];

  const errors: string[] = [];
  const needPending = status === "needs_review" || status === "all";
  const needHistory = status !== "needs_review";
  if (needPending && pending.state === "error") errors.push(pending.message);
  if (needHistory && history.state === "error") errors.push(history.message);

  let rows: T[];
  if (status === "needs_review") {
    rows = pendingRows.filter((r) => matchesRunType(r, runType));
  } else if (status === "all") {
    const p = pendingRows.filter((r) => matchesRunType(r, runType));
    const room = Math.max(0, QUEUE_VIEW_CAP - p.length);
    rows = [...p, ...decided.filter((r) => matchesRunType(r, runType)).slice(0, room)];
  } else {
    rows = decided.filter((r) => r.governanceStatus === status && matchesRunType(r, runType)).slice(0, QUEUE_VIEW_CAP);
  }

  let pendingNote: string | null = null;
  if (needPending && pending.state === "ok" && pending.total > pendingRows.length) {
    const shown = pendingRows.filter((r) => matchesRunType(r, runType)).length;
    pendingNote =
      runType === "all"
        ? `Showing ${shown} of ${pending.total} pending`
        : `Showing ${shown} of ${pending.total} pending (all types)`;
  }

  const needs = pending.state === "ok" ? pending.total : null;
  const blocked = history.state === "ok" ? decided.filter((r) => r.governanceStatus === "blocked").length : null;
  const approved = history.state === "ok" ? decided.filter((r) => r.governanceStatus === "approved").length : null;
  const total = needs !== null && blocked !== null && approved !== null ? needs + blocked + approved : null;

  const loading =
    (needPending && pending.state === "loading") || (needHistory && history.state === "loading");

  return { rows, pendingNote, errors, stats: { needs, blocked, approved, total }, loading };
}

/**
 * Applies a just-committed review decision to both sources locally, so the
 * dashboard reflects it without a refetch. A row leaving `needs_review` leaves
 * the pending source (and its exact total); a row entering it (changes
 * requested on a blocked run) joins it.
 */
export function applyLocalReview<T extends QueueViewRow>(
  pending: PendingSource<T>,
  history: HistorySource<T>,
  row: T,
  updated: T
): { pending: PendingSource<T>; history: HistorySource<T> } {
  const key = rowKey(row);
  let nextPending = pending;
  if (pending.state === "ok") {
    const wasPending = pending.rows.some((r) => rowKey(r) === key);
    if (updated.governanceStatus === "needs_review") {
      nextPending = wasPending
        ? { ...pending, rows: pending.rows.map((r) => (rowKey(r) === key ? updated : r)) }
        : { state: "ok", rows: [updated, ...pending.rows], total: pending.total + 1 };
    } else if (wasPending) {
      nextPending = { state: "ok", rows: pending.rows.filter((r) => rowKey(r) !== key), total: Math.max(0, pending.total - 1) };
    }
  }
  let nextHistory = history;
  if (history.state === "ok") {
    const present = history.rows.some((r) => rowKey(r) === key);
    nextHistory = {
      state: "ok",
      rows: present ? history.rows.map((r) => (rowKey(r) === key ? updated : r)) : [updated, ...history.rows],
    };
  }
  return { pending: nextPending, history: nextHistory };
}

type QueueResponseBody<T> = { ok?: boolean; runs?: T[]; total?: unknown; queueNotice?: string; queueScope?: string };

export type QueueLoadResult<T> = {
  pending: PendingSource<T>;
  history: HistorySource<T>;
  /** queueNotice / queueScope, from whichever response succeeded (history first). */
  meta: { queueNotice?: string; queueScope?: string } | null;
  bothOk: boolean;
};

/**
 * Loads both sources independently. `fetchQueue(status)` performs the actual
 * `GET /api/governance/queue?status=…&runType=all&limit=50&offset=0` request
 * and `readError` turns a non-OK response into a message.
 */
export async function loadQueueSources<T>(
  fetchQueue: (status: "needs_review" | "all") => Promise<Response>,
  readError: (res: Response, fallback: string) => Promise<string>
): Promise<QueueLoadResult<T>> {
  const load = async (
    status: "needs_review" | "all"
  ): Promise<{ ok: true; data: QueueResponseBody<T> } | { ok: false; message: string }> => {
    try {
      const res = await fetchQueue(status);
      if (!res.ok) return { ok: false, message: await readError(res, "Could not load queue.") };
      const data = (await res.json()) as QueueResponseBody<T>;
      if (!data.ok) return { ok: false, message: "Could not load queue." };
      return { ok: true, data };
    } catch {
      return { ok: false, message: "Could not load queue." };
    }
  };

  const [p, h] = await Promise.all([load("needs_review"), load("all")]);

  const pending: PendingSource<T> =
    p.ok && typeof p.data.total === "number" && Number.isFinite(p.data.total)
      ? { state: "ok", rows: p.data.runs ?? [], total: p.data.total }
      : { state: "error", message: `Pending queue could not be loaded: ${p.ok ? "the response had no total." : p.message}` };
  const history: HistorySource<T> = h.ok
    ? { state: "ok", rows: h.data.runs ?? [] }
    : { state: "error", message: `Review history could not be loaded: ${h.message}` };
  const meta = h.ok ? h.data : p.ok ? p.data : null;

  return { pending, history, meta, bothOk: p.ok && h.ok };
}
