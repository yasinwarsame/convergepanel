/**
 * M2 — GET /api/governance/queue (GovernanceDashboard queue table / review modal "Consensus" and evidence chip): a
 * research row lists its stored consensus score and the cross-model evidence quality only when the run's persisted rows
 * prove at least two independent executing models. Otherwise both are null and `consensusWithheld` gives the reason.
 * Display only: the stored run and the governance status / reasons are untouched.
 */
const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));

let runRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "runs") {
      const snap = () => ({ docs: runRows.map((r) => ({ id: r.id, data: () => r.data })) });
      return {
        where: () => ({ orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap() }) }) }) }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap() }) }) }),
        limit: () => ({ select: () => ({ get: async () => snap() }) }),
      };
    }
    if (name === "verifications" || name === "videoVerifications") {
      const empty = { docs: [] };
      return {
        where: () => ({ select: () => ({ limit: () => ({ get: async () => empty }) }) }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => empty }) }) }),
        limit: () => ({ select: () => ({ get: async () => empty }) }),
      };
    }
    return { doc: () => ({ get: async () => ({ exists: false }) }) };
  },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";

const row = (modelId: string, status: string, extra: Record<string, unknown> = {}) => ({ modelId, status, rawTextTruncated: `${modelId} text`, ...extra });
const STRONG = { overallConsensusScore: 90, lowEvidenceClaims: 0, aggregateSupportRatio: 1 };
const run = (id: string, perModel: unknown[] | undefined, extra: Record<string, unknown> = {}) => ({
  id,
  data: {
    userId: "owner-a",
    question: id,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    createdAt: new Date(),
    synthesisConsensusSummary: STRONG,
    policyConsensusSummary: { evidenceQuality: "strong" },
    ...(perModel ? { runDocument: { perModel } } : {}),
    ...extra,
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
});

async function rows(): Promise<Record<string, any>> {
  const res = await GET(new NextRequest("http://localhost/api/governance/queue"));
  expect(res.status).toBe(200);
  const json = await res.json();
  return Object.fromEntries(json.runs.map((r: any) => [r.runId, r]));
}

describe("GET /api/governance/queue — research consensus score vs independent executing models", () => {
  // Phase 0 (L15, O14 = A; owner Option C): the queue DTO's consensusScore / evidenceQuality are the STORED values, as at
  // 35933c8 (governance-queue metadata); `consensusWithheld` / `modelIndependence` are additive presentation keys that
  // tell the dashboard to show the reason instead of the number (GovernanceDashboard queuePresentedScore).
  it("keeps the stored score + evidence quality; marks them withheld below two independent models and without execution identity", async () => {
    const deepseek = { provider: "deepseek" };
    runRows = [
      run("two-deepseek", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek)]),
      run("one-independent", [row("chatgpt", "ok"), row("claude", "failed", { rawTextTruncated: "" })]),
      run("missing-credentials", [row("chatgpt", "failed", { rawTextTruncated: "" }), row("grok", "ok")]),
      run("legacy-no-perModel", undefined, { consensusScore: 88 }),
      run("two-independent", [row("chatgpt", "ok"), row("grok", "ok")]),
    ];
    const by = await rows();
    for (const k of ["two-deepseek", "one-independent", "missing-credentials"]) {
      expect([k, by[k].consensusScore, by[k].evidenceQuality, by[k].consensusWithheld]).toEqual([k, 90, "strong", "insufficient_independent_models"]);
    }
    expect([by["legacy-no-perModel"].consensusScore, by["legacy-no-perModel"].evidenceQuality, by["legacy-no-perModel"].consensusWithheld]).toEqual([
      88,
      "strong",
      "independence_unverified",
    ]);
    expect([by["two-independent"].consensusScore, by["two-independent"].evidenceQuality]).toEqual([90, "strong"]);
    expect("consensusWithheld" in by["two-independent"]).toBe(false);
    // Governance status / reasons are display data from the stored run and are not altered.
    for (const r of Object.values(by)) expect([r.governanceStatus, r.governanceReasons]).toEqual(["needs_review", ["r1"]]);
  });

  it("a research run with no stored score is not marked withheld", async () => {
    runRows = [{ id: "no-score", data: { userId: "owner-a", question: "q", governanceStatus: "needs_review", createdAt: new Date(), runDocument: { perModel: [row("chatgpt", "ok")] } } }];
    const by = await rows();
    expect([by["no-score"].consensusScore, "consensusWithheld" in by["no-score"]]).toEqual([null, false]);
  });
});
