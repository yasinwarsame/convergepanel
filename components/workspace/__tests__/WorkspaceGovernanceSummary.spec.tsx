/**
 * Step 6.3 — the read-only Workspace governance summary UI.
 * Renders a REAL computed summary (the pure layer over the faithful fake), and
 * proves: exact counts with denominators, automated vs human kept apart,
 * exclusions disclosed, no score / tier / percentage, no interactive control,
 * and a summary that does not reconcile is never rendered.
 */
jest.mock("next/link", () => ({ __esModule: true, default: ({ href, children }: Record<string, unknown>) => require("react").createElement("a", { href }, children as never) }));
// A STABLE auth object: a fresh object per render would re-trigger every
// effect keyed on \`user\` (an infinite fetch/render loop in the test, not the app).
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
import WorkspaceGovernanceSummary from "@/components/workspace/WorkspaceGovernanceSummary";
import WorkspaceAuditLogShell from "@/components/workspace/WorkspaceAuditLogShell";
import { computeWorkspaceGovernanceSummary, type WorkspaceGovernanceSummary as Summary } from "@/lib/governance/workspaceGovernanceSummary";
import { fakeCountExecutor, type Dataset } from "@/lib/governance/__tests__/governanceSummaryFakes";

const W = "ws-1";
const REV = { governanceReviewedAt: "2026-10-01T00:00:00.000Z" };
const DATA: Dataset = {
  runs: [
    { workspaceId: W, projectId: null, status: "complete", governanceStatus: "approved" },
    { workspaceId: W, projectId: null, status: "complete", governanceStatus: "approved", ...REV },
    { workspaceId: W, projectId: null, status: "running" },
    { workspaceId: W, projectId: "foreign", status: "complete", governanceStatus: "approved" },
    { workspaceId: W, projectId: null, status: "complete", adaptiveOutput: { version: 1 }, governanceRecord: { version: 1, automatedGovernance: { status: "flagged" }, humanReview: { status: "pending" } } },
  ],
  verifications: [{ workspaceId: W, projectId: null, type: "claim_verification", governanceStatus: "garbage", ...REV }],
  videoVerifications: [],
};

let summary: Summary;
beforeAll(async () => {
  summary = await computeWorkspaceGovernanceSummary({ workspaceId: W, canonicalProjectIds: [], count: fakeCountExecutor(DATA), now: () => new Date("2026-10-09T00:00:00.000Z") });
});
beforeEach(() => {
  fetchCalls.length = 0;
  respond = (url) => (url.includes("governance-summary") ? { ok: true, status: 200, body: { ok: true, summary } } : { ok: true, status: 200, body: { ok: true, events: [], hasMore: false } });
});

const textOf = (n: TestRenderer.ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));
async function mount(el: ReturnType<typeof createElement>) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(el);
  });
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
  return r;
}
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);

it("renders exact counts with their denominators, per family, with exclusions disclosed", async () => {
  const r = await mount(createElement(WorkspaceGovernanceSummary, { workspaceId: W }));
  const research = textOf(byTestId(r, "governance-family-research")[0]);
  expect(research).toContain("Research — 2 completed");
  expect(research).toContain("Cleared by automated check: 1 of 2");
  expect(research).toContain("Not recorded (replaced by a human decision): 1 of 2");
  expect(research).toContain("Not yet complete (not counted above): 1");
  expect(research).toContain("Excluded for Project integrity: 1");
  const claim = textOf(byTestId(r, "governance-family-claim_verification")[0]);
  expect(claim).toContain("Reviewed with an unrecognized status (not counted as a decision): 1");
  expect(textOf(byTestId(r, "governance-rollup-needs_attention")[0])).toContain("Needs attention: 1 of");
});

it("keeps human decisions under their own heading, apart from automated outcomes", async () => {
  const research = textOf(byTestId(await mount(createElement(WorkspaceGovernanceSummary, { workspaceId: W })), "governance-family-research")[0]);
  const [automatedPart, humanPart] = research.split("Human decisions");
  expect(humanPart).toContain("Approved: 1");
  expect(automatedPart).not.toContain("Approved: 1");
});

it("is read-only and shows no score, tier or percentage", async () => {
  const r = await mount(createElement(WorkspaceGovernanceSummary, { workspaceId: W }));
  expect(r.root.findAll((n) => ["button", "input", "form", "select", "textarea", "a"].includes(n.type as string))).toHaveLength(0); // count only: a failing diff of ReactTestInstances (circular fiber graph) hangs the reporter
  const text = textOf(byTestId(r, "governance-summary")[0]);
  expect(text).not.toMatch(/%|score|tier|grade|rating/i);
  expect(fetchCalls).toEqual([{ url: `/api/workspaces/${W}/governance-summary`, method: "GET" }]);
});

it("a summary that does not reconcile is never rendered", async () => {
  const tampered: Summary = JSON.parse(JSON.stringify(summary));
  tampered.totals[0].automatedDenominator += 1;
  respond = () => ({ ok: true, status: 200, body: { ok: true, summary: tampered } });
  const r = await mount(createElement(WorkspaceGovernanceSummary, { workspaceId: W }));
  expect(byTestId(r, "governance-summary-error")).toHaveLength(1);
  expect(byTestId(r, "governance-family-research")).toHaveLength(0); // count only: a failing diff of ReactTestInstances (circular fiber graph) hangs the reporter
});

it("an API refusal shows the server message and no numbers", async () => {
  respond = () => ({ ok: false, status: 503, body: { ok: false, message: "The governance summary is temporarily unavailable. Please try again." } });
  const r = await mount(createElement(WorkspaceGovernanceSummary, { workspaceId: W }));
  expect(textOf(byTestId(r, "governance-summary-error")[0])).toContain("temporarily unavailable");
  expect(byTestId(r, "governance-summary-rollup")).toHaveLength(0); // count only: a failing diff of ReactTestInstances (circular fiber graph) hangs the reporter
});

it("an overlap record is disclosed as counted under its primary family — never as excluded", async () => {
  // One adaptive run that ALSO carries a System A governanceStatus, and one
  // non-adaptive run that ALSO carries a governanceRecord: each is counted once,
  // under its primary family, and disclosed as an overlap.
  const overlapData: Dataset = {
    runs: [
      { workspaceId: W, projectId: null, status: "complete", adaptiveOutput: { version: 1 }, governanceRecord: { version: 1, automatedGovernance: { status: "passed" }, humanReview: { status: "unreviewed" } }, governanceStatus: "approved" },
      { workspaceId: W, projectId: null, status: "complete", governanceStatus: "approved", governanceRecord: { version: 1 } },
    ],
    verifications: [],
    videoVerifications: [],
  };
  const overlapSummary = await computeWorkspaceGovernanceSummary({ workspaceId: W, canonicalProjectIds: [], count: fakeCountExecutor(overlapData) });
  respond = () => ({ ok: true, status: 200, body: { ok: true, summary: overlapSummary } });
  const r = await mount(createElement(WorkspaceGovernanceSummary, { workspaceId: W }));
  for (const family of ["research", "research_adaptive"]) {
    const line = textOf(byTestId(r, `governance-overlap-${family}`)[0]);
    expect(line).toBe("Records with conflicting governance data (counted under their primary family): 1");
    expect(line).not.toMatch(/not counted|excluded/i);
  }
  // ...and each record really is counted once under its primary family.
  expect(textOf(byTestId(r, "governance-family-research")[0])).toContain("Research — 1 completed");
  expect(textOf(byTestId(r, "governance-family-research_adaptive")[0])).toContain("Structured research — 1 completed");
});

describe("audit page shell wiring", () => {
  it("flag off (prop false): no summary section and no governance-summary request", async () => {
    const r = await mount(createElement(WorkspaceAuditLogShell, { workspaceId: W, workspaceName: "WS", canReadMembers: true }));
    expect(byTestId(r, "governance-summary")).toHaveLength(0); // count only: a failing diff of ReactTestInstances (circular fiber graph) hangs the reporter
    expect(fetchCalls.some((c) => c.url.includes("governance-summary"))).toBe(false);
  });
  it("flag on (prop true): the summary section renders on the audit page", async () => {
    const r = await mount(createElement(WorkspaceAuditLogShell, { workspaceId: W, workspaceName: "WS", canReadMembers: true, showGovernanceSummary: true }));
    expect(byTestId(r, "governance-summary")).toHaveLength(1);
  });
});
