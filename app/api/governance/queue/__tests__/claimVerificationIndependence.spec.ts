/**
 * Review of 8584211, MAJOR — a claim verification's stored consensus score (the canonical record behind a legacy Team
 * claim-verification row) is listed by GET /api/governance/queue only when its stored per-model rows prove ≥ 2
 * independent executing models with a usable answer (lib/panel/storedVerificationIndependence.ts). Otherwise the score
 * and its evidence quality are withheld with the reason. Stored documents are not modified.
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

let verRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const mockAdminDb: any = {
  collection: (name: string) => {
    const rowsFor = name === "verifications" ? () => verRows : () => [];
    const snap = () => ({ docs: rowsFor().map((r) => ({ id: r.id, data: () => r.data })) });
    if (name === "runs" || name === "verifications" || name === "videoVerifications") {
      return {
        where: () => ({
          select: () => ({ limit: () => ({ get: async () => snap() }) }),
          orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap() }) }) }),
        }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap() }) }) }),
        limit: () => ({ select: () => ({ get: async () => snap() }) }),
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

const vrow = (modelId: string, status: "ok" | "parse_error" | "failed", extra: Record<string, unknown> = {}) => ({
  modelId,
  status,
  verdict: status === "ok" ? "accurate" : status,
  confidence: "high",
  summary: `${modelId} summary`,
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...extra,
});
const ver = (id: string, modelResults: unknown[] | undefined, selectedModels?: string[]) => ({
  id,
  data: {
    userId: "owner-a",
    type: "claim_verification",
    claim: id,
    verdict: "accurate",
    consensusScore: 92,
    evidenceQuality: "strong",
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    timestamp: { toMillis: () => Date.now() },
    ...(modelResults ? { modelResults } : {}),
    ...(selectedModels ? { selectedModels } : {}),
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
});

async function rows(): Promise<Record<string, any>> {
  const res = await GET(new NextRequest("http://localhost/api/governance/queue"));
  expect(res.status).toBe(200);
  const json = await res.json();
  return Object.fromEntries(json.runs.filter((r: any) => r.collection === "verifications").map((r: any) => [r.runId, r]));
}

describe("GET /api/governance/queue — claim verification consensus vs independent executing models", () => {
  // Phase 0 (L15, O14 = A; owner Option C): the queue DTO's consensusScore / evidenceQuality are the STORED values, as at
  // 35933c8 (governance-queue metadata); `consensusWithheld` / `modelIndependence` are additive presentation keys that
  // tell the dashboard to show the reason instead of the number (GovernanceDashboard queuePresentedScore).
  it("three requested, one answered → stored score + evidence quality kept; withheld reason additive (insufficient)", async () => {
    // C-b (CB-01): the answering row records its provider (the shared gate verifies it).
    verRows = [ver("one", [vrow("chatgpt", "ok", { provider: "openai" }), vrow("claude", "failed"), vrow("grok", "parse_error")], ["chatgpt", "claude", "grok"])];
    const r = (await rows())["one"];
    expect([r.consensusScore, r.evidenceQuality, r.consensusWithheld, r.modelIndependence]).toEqual([
      92,
      "strong",
      "insufficient_independent_models",
      "insufficient",
    ]);
  });

  it("two slots answered by DeepSeek → one model → stored score kept, withheld reason additive", async () => {
    verRows = [
      ver("ds", [vrow("chatgpt", "ok", { substituted: true, provider: "deepseek" }), vrow("claude", "ok", { substituted: true, provider: "deepseek" })], ["chatgpt", "claude"]),
    ];
    const r = (await rows())["ds"];
    expect([r.consensusScore, r.consensusWithheld]).toEqual([92, "insufficient_independent_models"]);
  });

  it("two independent models answered → score shown, no withheld reason", async () => {
    verRows = [ver("two", [vrow("chatgpt", "ok", { provider: "openai" }), vrow("claude", "ok", { provider: "anthropic" }), vrow("grok", "failed")], ["chatgpt", "claude", "grok"])];
    const r = (await rows())["two"];
    expect([r.consensusScore, r.evidenceQuality, "consensusWithheld" in r, "modelIndependence" in r]).toEqual([92, "strong", false, false]);
  });

  it("C-b (CB-01): provider-less own-provider rows, an unrecorded substitute, or no answer → unverified (never independent / one model)", async () => {
    verRows = [
      ver("pl-two", [vrow("chatgpt", "ok"), vrow("claude", "ok"), vrow("grok", "failed")], ["chatgpt", "claude", "grok"]),
      ver("pl-one", [vrow("chatgpt", "ok"), vrow("claude", "failed"), vrow("grok", "parse_error")], ["chatgpt", "claude", "grok"]),
      ver("unrec", [vrow("chatgpt", "ok", { substituted: true }), vrow("claude", "ok", { substituted: true })], ["chatgpt", "claude"]),
      ver("allfail", [vrow("chatgpt", "failed"), vrow("claude", "parse_error")], ["chatgpt", "claude"]),
    ];
    const by = await rows();
    for (const id of ["pl-two", "pl-one", "unrec", "allfail"]) {
      expect([id, by[id].consensusScore, by[id].consensusWithheld, by[id].modelIndependence, "singleModelAssessment" in by[id]]).toEqual([id, 92, "independence_unverified", "unverified", false]);
    }
  });

  it("missing / incomplete attribution → stored score kept, withheld reason additive (unverified)", async () => {
    verRows = [
      ver("none", undefined),
      ver("partial", [vrow("chatgpt", "ok"), vrow("claude", "ok")], ["chatgpt", "claude", "grok"]),
    ];
    const by = await rows();
    for (const id of ["none", "partial"]) {
      expect([id, by[id].consensusScore, by[id].consensusWithheld, by[id].modelIndependence]).toEqual([id, 92, "independence_unverified", "unverified"]);
    }
  });

  it("stored verification documents are not modified", async () => {
    const doc = ver("frozen", [vrow("chatgpt", "ok"), vrow("claude", "failed")], ["chatgpt", "claude"]);
    const before = JSON.stringify(doc.data);
    verRows = [doc];
    await rows();
    expect(JSON.stringify(doc.data)).toBe(before);
  });
});
