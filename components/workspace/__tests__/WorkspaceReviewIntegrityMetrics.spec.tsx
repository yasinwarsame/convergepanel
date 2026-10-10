/**
 * Order 3 — the read-only review integrity section.
 * Renders a REAL computed response (the pure layer over the faithful fake) and
 * proves: the three groups with exact counts, the override denominator, the
 * conditional single-reviewer row, the neutral missing-path note, the empty
 * state, no score / percentage / rank / quality language, no interactive
 * control, a response that does not reconcile is never rendered, and the
 * audit-page shell mounts it (and fetches) only when the server flag says so.
 */
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never) }));
// A STABLE auth object: a fresh object per render would re-trigger every effect keyed on `user`.
const AUTH = { user: { uid: "u1" }, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const fetchCalls: Array<{ url: string; method?: string }> = [];
let respond: (url: string) => { ok: boolean; status: number; body: unknown } = () => ({ ok: false, status: 404, body: {} });
jest.mock("@/lib/client/authedFetch", () => ({
  authedFetch: async (url: string, init: { method?: string }) => {
    fetchCalls.push({ url, method: init?.method });
    const r = respond(url);
    return { ok: r.ok, status: r.status, json: async () => r.body };
  },
}));

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import WorkspaceReviewIntegrityMetrics from "@/components/workspace/WorkspaceReviewIntegrityMetrics";
import WorkspaceAuditLogShell from "@/components/workspace/WorkspaceAuditLogShell";
import { computeReviewIntegrityMetrics, type ReviewIntegrityMetricsV1 } from "@/lib/governance/reviewIntegrityMetrics";
import { fakeCountExecutor, type Doc } from "@/lib/governance/__tests__/governanceSummaryFakes";

const W = "ws-1";
const r = (status?: string, decidedVia?: string, projectId: unknown = null): Doc => ({
  workspaceId: W,
  projectId,
  status: "complete",
  adaptiveOutput: { version: 1 },
  governanceRecord: { version: 1, humanReview: { ...(status ? { status } : {}), ...(decidedVia ? { decidedVia } : {}) } },
});
const metricsFor = (runs: Doc[]) => computeReviewIntegrityMetrics({ workspaceId: W, canonicalProjectIds: [], count: fakeCountExecutor({ runs, verifications: [], videoVerifications: [] }) });

const FIXTURE = [
  ...Array.from({ length: 5 }, () => r("approved")),
  r("approved", "single_reviewer"),
  r("rejected", "single_reviewer"),
  r("approved", "multi_reviewer_panel"),
  r("changes_requested", "multi_reviewer_panel"),
  r("approved_with_conditions", "multi_reviewer_owner_override"),
  r("pending"),
  r("bogus"),
  r("approved", undefined, "foreign-project"),
];

let metrics: ReviewIntegrityMetricsV1;
let noSingle: ReviewIntegrityMetricsV1;
let empty: ReviewIntegrityMetricsV1;
beforeAll(async () => {
  metrics = await metricsFor(FIXTURE);
  noSingle = await metricsFor([r("approved"), r("approved", "multi_reviewer_panel")]);
  empty = await metricsFor([]);
});
const serve = (m: unknown) => {
  respond = (url) => (url.includes("review-integrity-metrics") ? { ok: true, status: 200, body: { ok: true, metrics: m } } : { ok: true, status: 200, body: { ok: true, events: [], hasMore: false } });
};
beforeEach(() => {
  fetchCalls.length = 0;
  serve(metrics);
});

const textOf = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
async function mount(el: ReturnType<typeof createElement>) {
  let rr!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    rr = TestRenderer.create(el);
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return rr;
}
const byTestId = (rr: TestRenderer.ReactTestRenderer, id: string) => rr.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);
const section = async () => mount(createElement(WorkspaceReviewIntegrityMetrics, { workspaceId: W }));

it("Group A — recorded review state: the completed total and every state row", async () => {
  const text = textOf(byTestId(await section(), "review-integrity-states")[0]);
  for (const line of ["Completed adaptive research: 12", "Unreviewed: 0", "Pending: 1", "Approved: 7", "Approved with conditions: 1", "Changes requested: 1", "Rejected: 1", "Other or not recorded: 1"]) expect(text).toContain(line);
});

it("Group B — recorded decision path, with the neutral note; missing paths are 'not recorded', never single-reviewer", async () => {
  const text = textOf(byTestId(await section(), "review-integrity-paths")[0]);
  for (const line of ["Terminal human decisions: 10", "Recorded single-reviewer: 2", "Multi-reviewer panel: 2", "Owner override: 1", "Path not recorded or unrecognized: 5", "Older or ordinary decisions may not record a decision path."]) expect(text).toContain(line);
});

it("Group C — MUTATION B: owner overrides are shown against explicit multi-reviewer decisions: 1 of 3", async () => {
  const rr = await section();
  expect(textOf(byTestId(rr, "review-integrity-multi")[0])).toContain("Explicit multi-reviewer decisions: 3");
  expect(textOf(byTestId(rr, "review-integrity-multi")[0])).toContain("Panel finalizations: 2");
  expect(textOf(byTestId(rr, "review-integrity-owner-overrides")[0])).toContain("Owner overrides: 1 of 3");
  expect(textOf(byTestId(rr, "review-integrity-owner-overrides")[0])).not.toContain("of 10");
});

it("Project integrity exclusions are disclosed, not hidden", async () => {
  expect(textOf(byTestId(await section(), "review-integrity-metrics")[0])).toContain("Project integrity exclusions (not counted above): 1");
});

it("the recorded single-reviewer row is not rendered when its count is 0", async () => {
  serve(noSingle);
  const rr = await section();
  expect(byTestId(rr, "review-integrity-path-single_reviewer")).toHaveLength(0);
  expect(byTestId(rr, "review-integrity-path-other_or_missing")).toHaveLength(1);
});

it("no completed adaptive research → the normal empty state, not an error", async () => {
  serve(empty);
  const rr = await section();
  expect(textOf(byTestId(rr, "review-integrity-empty")[0])).toBe("No completed adaptive research is available for review integrity metrics yet.");
  expect(byTestId(rr, "review-integrity-error")).toHaveLength(0);
  expect(byTestId(rr, "review-integrity-states")).toHaveLength(0);
});

it("is read-only: one GET, no control, and no score, percentage, rank or quality language", async () => {
  const rr = await section();
  expect(rr.root.findAll((n) => ["button", "input", "form", "select", "textarea", "a"].includes(n.type as string))).toHaveLength(0); // count only: a failing diff of ReactTestInstances hangs the reporter
  const text = textOf(byTestId(rr, "review-integrity-metrics")[0]);
  expect(text).not.toMatch(/%|score|rank|leaderboard|accuracy|quality|performance|trust|good reviewer|bad reviewer/i);
  expect(fetchCalls).toEqual([{ url: `/api/workspaces/${W}/review-integrity-metrics`, method: "GET" }]);
});

it("a response that does not reconcile is never rendered", async () => {
  const tampered = JSON.parse(JSON.stringify(metrics)) as ReviewIntegrityMetricsV1;
  tampered.multiReviewer.explicitDecisionCount = tampered.totals.terminalHumanDecisions;
  serve(tampered);
  const rr = await section();
  expect(byTestId(rr, "review-integrity-error")).toHaveLength(1);
  expect(byTestId(rr, "review-integrity-multi")).toHaveLength(0);
});

it("an API refusal shows the server message and no numbers", async () => {
  respond = () => ({ ok: false, status: 503, body: { ok: false, message: "Review integrity metrics are temporarily unavailable. Please try again." } });
  const rr = await section();
  expect(textOf(byTestId(rr, "review-integrity-error")[0])).toContain("temporarily unavailable");
  expect(byTestId(rr, "review-integrity-states")).toHaveLength(0);
});

describe("audit page shell wiring", () => {
  it("flag off (prop absent/false): no section and no review-integrity request", async () => {
    const rr = await mount(createElement(WorkspaceAuditLogShell, { workspaceId: W, workspaceName: "WS", canReadMembers: true, showGovernanceSummary: false }));
    expect(byTestId(rr, "review-integrity-metrics")).toHaveLength(0);
    expect(fetchCalls.some((c) => c.url.includes("review-integrity-metrics"))).toBe(false);
  });
  it("flag on (prop true): the section renders on the audit page and fetches once", async () => {
    const rr = await mount(createElement(WorkspaceAuditLogShell, { workspaceId: W, workspaceName: "WS", canReadMembers: true, showReviewIntegrityMetrics: true }));
    expect(byTestId(rr, "review-integrity-metrics")).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.url.includes("review-integrity-metrics"))).toHaveLength(1);
  });
});
