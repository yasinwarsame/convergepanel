/**
 * R5 (review record 16, section F, MINOR-1) — the admin runs tab's claim "Consensus" column and detail line are presented
 * on the shared claim score basis (lib/verification/claimConsensusPresentation.ts `claimScoreText`), never as a bare
 * stored number: withheld with its reason below two independent executing models (or unverified provenance), and
 * qualified as slot responses when the slots are not each a distinct identified model. The list DTO keeps the stored
 * `consensusScore`; `consensusWithheld` / `consensusBasis` are additive presentation keys. Research and video rows are
 * not claim records and are unchanged.
 */
const mockedRequireAdminApiAccess = jest.fn();
jest.mock("@/lib/admin/privilegedAccess", () => ({
  ...jest.requireActual("@/lib/admin/privilegedAccess"),
  requirePrivilegedAccess: (...args: any[]) => mockedRequireAdminApiAccess(...args),
}));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useAdminPortalAccess", () => ({ useAdminPortalAccess: () => ({}) }));

let verRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let runRows: Array<{ id: string; data: Record<string, unknown> }> = [];
/** Honours `.select()` so the route must project every field it presents from. */
function query(rows: () => Array<{ id: string; data: Record<string, unknown> }>, fields: string[] | null): any {
  const project = (d: Record<string, unknown>) => (fields ? Object.fromEntries(fields.filter((f) => f in d).map((f) => [f, d[f]])) : d);
  return {
    orderBy: () => query(rows, fields),
    limit: () => query(rows, fields),
    select: (...f: string[]) => query(rows, f),
    get: async () => ({ docs: rows().map((r) => ({ id: r.id, data: () => project(r.data) })) }),
  };
}
const mockAdminDb: any = {
  collection: (name: string) => (name === "verifications" ? query(() => verRows, null) : name === "runs" ? query(() => runRows, null) : query(() => [], null)),
  getAll: async (...refs: any[]) => refs.map(() => ({ data: () => ({ email: "u@example.com" }) })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/runs/route";
import { adminRunConsensusText, adminRunDetailConsensusText } from "@/components/admin/AdminRunsTab";

const QUALIFIER = "computed over panel slot responses, not independent corroboration";
const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", gemini: "google", grok: "xai", perplexity: "perplexity" };
const row = (modelId: string, verdict: string, rec: { sub?: boolean; provider?: string } = {}) => ({
  modelId,
  status: "ok",
  verdict,
  confidence: "high",
  summary: `${modelId} says ${verdict}`,
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...(rec.sub ? { substituted: true } : {}),
  provider: rec.provider ?? OWN[modelId],
});
const DS = { sub: true, provider: "deepseek" };
const MIX = [row("chatgpt", "accurate", DS), row("claude", "accurate", DS), row("gemini", "accurate", DS), row("grok", "accurate", DS), row("perplexity", "inaccurate")];
const ALL_DS = [row("chatgpt", "accurate", DS), row("claude", "accurate", DS)];
const OWN_TWO = [row("chatgpt", "accurate"), row("claude", "accurate")];
const ver = (id: string, modelResults: unknown[] | undefined, at: number) => ({
  id,
  data: {
    userId: "u1",
    userEmail: "u1@example.com",
    type: "claim_verification",
    claim: `claim ${id}`,
    consensusScore: 92,
    verdict: "confirmed",
    timestamp: { toMillis: () => at },
    ...(modelResults ? { modelResults, selectedModels: (modelResults as Array<{ modelId: string }>).map((r) => r.modelId) } : {}),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedRequireAdminApiAccess.mockResolvedValue({ ok: true, actor: { uid: "admin-uid", email: "admin@example.com", tier: "ADMIN_PORTAL" } });
  verRows = [ver("v-mix", MIX, 5), ver("v-ds", ALL_DS, 4), ver("v-own", OWN_TWO, 3), ver("v-none", undefined, 2)];
  runRows = [{ id: "r1", data: { userId: "u1", userEmail: "u1@example.com", question: "q", createdAt: "2026-01-01T00:00:00.000Z", consensusScore: 92 } }];
});

describe("admin runs tab — claim consensus column on the shared claim score basis (R5)", () => {
  it("list DTO: stored score kept; withheld / basis keys added for claim rows only", async () => {
    const res = await GET(new NextRequest("http://localhost/api/admin/runs?type=all&limit=50"));
    const body = await res.json();
    const by = Object.fromEntries(body.runs.map((r: any) => [r.runId, r]));
    for (const id of ["v-mix", "v-ds", "v-own", "v-none", "r1"]) expect([id, by[id].consensusScore]).toEqual([id, 92]);
    expect([by["v-mix"].consensusBasis, by["v-mix"].consensusWithheld]).toEqual(["slot_responses", undefined]);
    expect([by["v-ds"].consensusBasis, by["v-ds"].consensusWithheld]).toEqual([undefined, "insufficient_independent_models"]);
    expect(["consensusBasis" in by["v-own"], "consensusWithheld" in by["v-own"]]).toEqual([false, false]);
    expect(by["v-none"].consensusWithheld).toBe("independence_unverified");
    expect(["consensusBasis" in by.r1, "consensusWithheld" in by.r1]).toEqual([false, false]);
    // The list never ships the per-model rows themselves.
    expect(JSON.stringify(body)).not.toContain("modelResults");

    expect(adminRunConsensusText(by["v-mix"])).toBe(`92 (${QUALIFIER})`);
    expect(adminRunConsensusText(by["v-ds"])).toBe("No consensus score (fewer than two independent models)");
    expect(adminRunConsensusText(by["v-none"])).toBe("Consensus score withheld (model independence not recorded)");
    expect(adminRunConsensusText(by["v-own"])).toBe("92");
    expect(adminRunConsensusText(by.r1)).toBe("92");
    expect(adminRunConsensusText({ ...by.r1, consensusScore: null })).toBe("—");
  });

  it("detail line: a claim's raw document is presented on the same basis; research / video unchanged", () => {
    const claim = { runType: "claim" } as const;
    expect(adminRunDetailConsensusText(claim, ver("x", MIX, 1).data)).toBe(`92 (${QUALIFIER})`);
    expect(adminRunDetailConsensusText(claim, ver("x", ALL_DS, 1).data)).toBe("No consensus score (fewer than two independent models)");
    expect(adminRunDetailConsensusText(claim, ver("x", undefined, 1).data)).toBe("Consensus score withheld (model independence not recorded)");
    expect(adminRunDetailConsensusText(claim, ver("x", OWN_TWO, 1).data)).toBe("92");
    expect(adminRunDetailConsensusText({ runType: "research" }, { consensusScore: 92 })).toBe("92");
    expect(adminRunDetailConsensusText({ runType: "video" }, { consensusScore: 70 })).toBe("70");
    expect(adminRunDetailConsensusText({ runType: "research" }, {})).toBe("—");
  });
});
