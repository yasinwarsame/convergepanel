/**
 * Order 3 — the presentation layer re-checks the server response on its own
 * and words it factually: counts with explicit denominators, no score,
 * percentage, rank or quality language, and a missing decision path is never
 * presented as single-reviewer or as a defect.
 */
import { computeReviewIntegrityMetrics, type ReviewIntegrityMetricsV1 } from "@/lib/governance/reviewIntegrityMetrics";
import { DECISION_PATH_NOTE, presentReviewIntegrityMetrics, reconcileReviewIntegrityMetrics, REVIEW_INTEGRITY_EMPTY_MESSAGE } from "@/lib/governance/reviewIntegrityMetricsPresentation";
import { fakeCountExecutor, type Doc } from "./governanceSummaryFakes";

const W = "ws-1";
const r = (status?: string, decidedVia?: string): Doc => ({
  workspaceId: W,
  projectId: null,
  status: "complete",
  adaptiveOutput: { version: 1 },
  governanceRecord: { version: 1, humanReview: { ...(status ? { status } : {}), ...(decidedVia ? { decidedVia } : {}) } },
});
const metricsFor = (runs: Doc[]) =>
  computeReviewIntegrityMetrics({ workspaceId: W, canonicalProjectIds: [], count: fakeCountExecutor({ runs, verifications: [], videoVerifications: [] }), now: () => new Date("2026-10-11T00:00:00.000Z") });

/** The critical override-denominator fixture: 10 terminal decisions, 3 explicitly multi-reviewer. */
const OVERRIDE_FIXTURE = [
  ...Array.from({ length: 5 }, () => r("approved")),
  r("approved", "single_reviewer"),
  r("rejected", "single_reviewer"),
  r("approved", "multi_reviewer_panel"),
  r("changes_requested", "multi_reviewer_panel"),
  r("approved_with_conditions", "multi_reviewer_owner_override"),
  r("pending"),
];

let base: ReviewIntegrityMetricsV1;
beforeAll(async () => {
  base = await metricsFor(OVERRIDE_FIXTURE);
});
const clone = () => JSON.parse(JSON.stringify(base)) as ReviewIntegrityMetricsV1;

describe("reconcileReviewIntegrityMetrics (independent of the domain arithmetic)", () => {
  it("a real computed response reconciles", () => {
    expect(reconcileReviewIntegrityMetrics(base)).toEqual([]);
  });

  const breakers: Array<[string, (m: any) => void]> = [
    ["review states do not sum to the total", (m) => (m.totals.completedAdaptiveResearch += 1)],
    ["terminal total does not match its states", (m) => (m.totals.terminalHumanDecisions += 1)],
    ["non-terminal total mismatch", (m) => (m.totals.nonTerminalRecognized += 1)],
    ["other-or-missing mismatch", (m) => (m.totals.otherOrMissingReviewState += 1)],
    ["paths do not sum to terminal", (m) => (m.decisionPaths[3].count += 1)],
    ["panel count mismatch", (m) => (m.multiReviewer.panelFinalizationCount += 1)],
    ["override count mismatch", (m) => (m.multiReviewer.ownerOverrideCount += 1)],
    ["explicit count = all terminal decisions (mutation B shape)", (m) => (m.multiReviewer.explicitDecisionCount = m.totals.terminalHumanDecisions)],
    ["a negative count", (m) => (m.reviewStates[0].count = -1)],
    ["a non-integer count", (m) => (m.totals.projectIntegrityAnomalies = 0.5)],
    ["a missing row", (m) => m.reviewStates.pop()],
    ["rows out of order", (m) => m.decisionPaths.reverse()],
    ["unsupported version", (m) => (m.version = 2)],
    ["missing totals", (m) => delete m.totals],
  ];
  it.each(breakers)("%s → problems, never rendered", (_l, breakIt) => {
    const m = clone();
    breakIt(m);
    expect(reconcileReviewIntegrityMetrics(m).length).toBeGreaterThan(0);
  });
  it.each([[null], ["text"], [[]], [{}]])("non-object body %p → problems", (v) => {
    expect(reconcileReviewIntegrityMetrics(v).length).toBeGreaterThan(0);
  });
});

describe("presentReviewIntegrityMetrics", () => {
  it("MUTATION B: 'Owner overrides: 1 of 3' — the denominator is explicit multi-reviewer decisions, not the 10 terminal decisions", () => {
    const p = presentReviewIntegrityMetrics(base);
    if (p.kind !== "ready") throw new Error("expected ready");
    expect(p.multiReviewer).toEqual({ explicit: 3, panelFinalizations: 2, ownerOverrides: 1, ownerOverrideLine: "Owner overrides: 1 of 3 explicitly recorded multi-reviewer decisions" });
    expect(p.decisionPath.terminal).toBe(10);
  });

  it("all eight review-state rows, in contract order, with neutral labels", () => {
    const p = presentReviewIntegrityMetrics(base);
    if (p.kind !== "ready") throw new Error("expected ready");
    expect(p.reviewState.total).toBe(11);
    expect(p.reviewState.rows.map((x) => [x.label, x.count])).toEqual([
      ["Unreviewed", 0],
      ["Pending", 1],
      ["Approved", 7],
      ["Approved with conditions", 1],
      ["Changes requested", 1],
      ["Rejected", 1],
      ["Other or not recorded", 0],
    ]);
  });

  it("the recorded single-reviewer row appears only when its count is above zero; the not-recorded row and neutral note always appear", async () => {
    const withSingle = presentReviewIntegrityMetrics(base);
    if (withSingle.kind !== "ready") throw new Error("expected ready");
    expect(withSingle.decisionPath.rows.map((x) => x.label)).toEqual(["Recorded single-reviewer", "Multi-reviewer panel", "Owner override", "Path not recorded or unrecognized"]);
    const without = presentReviewIntegrityMetrics(await metricsFor([r("approved"), r("approved", "multi_reviewer_panel")]));
    if (without.kind !== "ready") throw new Error("expected ready");
    expect(without.decisionPath.rows.map((x) => [x.key, x.count])).toEqual([
      ["multi_reviewer_panel", 1],
      ["multi_reviewer_owner_override", 0],
      ["other_or_missing", 1],
    ]);
    expect(without.decisionPath.note).toBe(DECISION_PATH_NOTE);
  });

  it("no completed adaptive research → the normal empty state, not an error", async () => {
    expect(presentReviewIntegrityMetrics(await metricsFor([]))).toEqual({ kind: "empty", message: REVIEW_INTEGRITY_EMPTY_MESSAGE });
  });

  it("no score, rate, rank or quality language anywhere in the presented text", () => {
    const text = JSON.stringify(presentReviewIntegrityMetrics(base)).toLowerCase();
    for (const banned of ["%", "percent", "score", "rank", "accuracy", "quality", "performance", "trust", "leaderboard", "good reviewer", "bad reviewer", "error", "failure", "defect"]) {
      expect(text).not.toContain(banned);
    }
  });
});
