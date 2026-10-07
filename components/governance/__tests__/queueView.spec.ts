/**
 * Roadmap 4.2b — `buildQueueView` / `applyLocalReview` rules, in isolation.
 * The end-to-end proof through the real route is in
 * app/api/governance/queue/__tests__/pendingQueueCompleteness.spec.ts.
 */

import { applyLocalReview, buildQueueView, QUEUE_VIEW_CAP, type QueueViewRow } from "@/components/governance/queueView";

const row = (runId: string, governanceStatus: QueueViewRow["governanceStatus"], runType: QueueViewRow["runType"] = "research"): QueueViewRow => ({
  runId,
  collection: runType === "research" ? "runs" : runType === "verification" ? "verifications" : "videoVerifications",
  runType,
  governanceStatus,
});
const n = (prefix: string, count: number, status: QueueViewRow["governanceStatus"], runType: QueueViewRow["runType"] = "research") =>
  Array.from({ length: count }, (_, i) => row(`${prefix}-${i}`, status, runType));

describe("all view", () => {
  it("history never evicts a returned pending row; history fills only the remaining capacity", () => {
    const pending = { state: "ok" as const, rows: n("p", 48, "needs_review"), total: 48 };
    const history = { state: "ok" as const, rows: n("h", 50, "approved") };
    const v = buildQueueView({ pending, history, status: "all", runType: "all" });
    expect(v.rows).toHaveLength(QUEUE_VIEW_CAP);
    expect(v.rows.filter((r) => r.governanceStatus === "needs_review")).toHaveLength(48);
    expect(v.rows.filter((r) => r.governanceStatus === "approved")).toHaveLength(2);
  });

  it("a pending row also present in the snapshot is shown once, as pending", () => {
    const pending = { state: "ok" as const, rows: [row("x", "needs_review")], total: 1 };
    const history = { state: "ok" as const, rows: [row("x", "needs_review"), row("y", "blocked")] };
    const v = buildQueueView({ pending, history, status: "all", runType: "all" });
    expect(v.rows.map((r) => r.runId)).toEqual(["x", "y"]);
  });
});

describe("pending count and note", () => {
  it("the snapshot's pending rows are never counted or shown", () => {
    const pending = { state: "ok" as const, rows: [row("p", "needs_review")], total: 1 };
    const history = { state: "ok" as const, rows: n("stale", 10, "needs_review") };
    const v = buildQueueView({ pending, history, status: "needs_review", runType: "all" });
    expect(v.rows.map((r) => r.runId)).toEqual(["p"]);
    expect(v.stats.needs).toBe(1);
    expect(v.stats.total).toBe(1);
  });

  it("no note when every pending row is shown", () => {
    const v = buildQueueView({ pending: { state: "ok", rows: n("p", 3, "needs_review"), total: 3 }, history: { state: "ok", rows: [] }, status: "needs_review", runType: "all" });
    expect(v.pendingNote).toBeNull();
  });

  it("a type filter over a partial pending page says the total spans all types", () => {
    const rows = [...n("r", 30, "needs_review"), ...n("c", 20, "needs_review", "verification")];
    const v = buildQueueView({ pending: { state: "ok", rows, total: 51 }, history: { state: "ok", rows: [] }, status: "needs_review", runType: "verification" });
    expect(v.rows).toHaveLength(20);
    expect(v.pendingNote).toBe("Showing 20 of 51 pending (all types)");
  });
});

describe("approved / blocked views are unchanged (history only)", () => {
  it("blocked view lists the snapshot's blocked rows and reports no pending error", () => {
    const v = buildQueueView({
      pending: { state: "error", message: "Pending queue could not be loaded: x" },
      history: { state: "ok", rows: [...n("b", 2, "blocked"), ...n("a", 3, "approved")] },
      status: "blocked",
      runType: "all",
    });
    expect(v.rows.map((r) => r.runId)).toEqual(["b-0", "b-1"]);
    expect(v.errors).toEqual([]);
    expect(v.stats).toEqual({ needs: null, blocked: 2, approved: 3, total: null });
  });
});

describe("applyLocalReview", () => {
  it("approving a pending row removes it from pending and decrements the exact total", () => {
    const p = { state: "ok" as const, rows: [row("x", "needs_review"), row("y", "needs_review")], total: 60 };
    const h = { state: "ok" as const, rows: [] as QueueViewRow[] };
    const next = applyLocalReview(p, h, p.rows[0], { ...p.rows[0], governanceStatus: "approved" });
    expect(next.pending).toEqual({ state: "ok", rows: [row("y", "needs_review")], total: 59 });
    expect(next.history).toEqual({ state: "ok", rows: [row("x", "approved")] });
  });

  it("changes requested on a blocked row moves it into pending and increments the total", () => {
    const p = { state: "ok" as const, rows: [] as QueueViewRow[], total: 4 };
    const h = { state: "ok" as const, rows: [row("z", "blocked")] };
    const next = applyLocalReview(p, h, h.rows[0], { ...h.rows[0], governanceStatus: "needs_review" });
    expect(next.pending).toEqual({ state: "ok", rows: [row("z", "needs_review")], total: 5 });
  });
});
