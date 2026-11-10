/**
 * Fresh review of 0d4f6c9, MAJOR — GET /api/governance/queue research rows present stored disagreement lines as
 * "Key disagreements" / "Where synthesis flags disagreements" only when independent executing models wrote them
 * (lib/panel/storedDisagreementIndependence.ts). Every other stored line is returned in `qualifiedDisagreements` with
 * its reason — never erased, never as a cross-model split. Stored documents are not modified.
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

const deepseek = { provider: "deepseek" };
const FOUNDING = { topic: "Founding date", positionsByModel: { chatgpt: "1789", claude: "1792" }, whyTheyDiffer: "ChatGPT says 1789, Claude says 1792" };
const VS_GROK = { topic: "Founder", positionsByModel: { chatgpt: "A merchant", grok: "A banker" }, whyTheyDiffer: "Different sources" };
const report = (disagreements: unknown[]) => ({ synthesizedStructuredReport: { keyFindings: [{ claim: "Founded in the 1790s." }], disagreements }, structuredSynthesis: { keyFindings: ["Founded in the 1790s."], disagreements } });

describe("GET /api/governance/queue — research disagreements vs executing-model independence", () => {
  // Phase 0 (L15, O14 = A): `disagreements` / `disagreementPoints` are the 35933c8 DTO fields — every stored line,
  // capped at 3, unpartitioned. `qualifiedDisagreements` / `modelIndependence` are additive: GovernanceDashboard lists the
  // qualified lines under their own heading and drops them from "Key disagreements" (queueResearchDisagreementLines).
  it("two DeepSeek substitutions: the stored line stays in the DTO (35933c8) and is also returned qualified as one independent model", async () => {
    runRows = [run("two-deepseek", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek)], report([FOUNDING]))];
    const r = (await rows())["two-deepseek"];
    expect(r.disagreements).toEqual(["Founding date: ChatGPT says 1789, Claude says 1792"]);
    expect(r.disagreementPoints).toEqual(["Founding date"]);
    expect(r.qualifiedDisagreements).toEqual([{ text: "Founding date: ChatGPT says 1789, Claude says 1792", basis: "single_independent_model" }, { text: "Founding date", basis: "single_independent_model" }]);
    expect(r.modelIndependence).toBe("insufficient");
  });

  it("one independent model: the same", async () => {
    runRows = [run("one", [row("chatgpt", "ok", { provider: "openai" }), row("claude", "failed", { rawTextTruncated: "" })], report(["Founding date: models differ"]))];
    const r = (await rows())["one"];
    expect(r.disagreements).toEqual(["Founding date: models differ"]);
    expect(r.qualifiedDisagreements).toEqual([{ text: "Founding date: models differ", basis: "single_independent_model" }]);
  });

  it("two genuinely independent models: genuine disagreement preserved, nothing qualified, no modelIndependence", async () => {
    runRows = [run("two", [row("chatgpt", "ok", { provider: "openai" }), row("claude", "ok", { provider: "anthropic" })], report([FOUNDING]))];
    const r = (await rows())["two"];
    expect(r.disagreements).toEqual(["Founding date: ChatGPT says 1789, Claude says 1792"]);
    expect(r.disagreementPoints).toEqual(["Founding date"]);
    expect(r.qualifiedDisagreements).toBeUndefined();
    expect("modelIndependence" in r).toBe(false);
  });

  it("DeepSeek×2 + Grok: every stored line in the DTO (35933c8); DeepSeek-vs-DeepSeek additionally qualified as the same executing model", async () => {
    runRows = [run("mixed", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek), row("grok", "ok", { provider: "xai" })], report([FOUNDING, VS_GROK]))];
    const r = (await rows())["mixed"];
    expect(r.disagreements).toEqual(["Founding date: ChatGPT says 1789, Claude says 1792", "Founder: Different sources"]);
    expect(r.disagreementPoints).toEqual(["Founding date", "Founder"]);
    expect(r.qualifiedDisagreements).toEqual([
      { text: "Founding date: ChatGPT says 1789, Claude says 1792", basis: "same_executing_model" },
      { text: "Founding date", basis: "same_executing_model" },
    ]);
    expect("modelIndependence" in r).toBe(false);
  });

  it("missing provenance (no persisted rows): the stored line stays in the DTO (35933c8), additionally qualified as independence unverified", async () => {
    runRows = [run("legacy", undefined, { consensusScore: 88, ...report([FOUNDING]) })];
    const r = (await rows())["legacy"];
    expect(r.disagreements).toEqual(["Founding date: ChatGPT says 1789, Claude says 1792"]);
    expect(r.disagreementPoints).toEqual(["Founding date"]);
    expect(r.qualifiedDisagreements?.map((q: any) => q.basis)).toEqual(["independence_unverified", "independence_unverified"]);
    expect(r.modelIndependence).toBe("unverified");
  });

  // The 35933c8 DTO caps the stored lines at 3 before any classification, so the genuine fifth line is not in the DTO
  // (exactly as at 35933c8). C-c (CC-16, D-2): the qualified list is no longer capped — every same-model line, bullet
  // and point forms, is listed once (was capped at 3).
  it("the DTO keeps the 35933c8 cap of 3 stored lines; the qualified list lists every non-genuine stored line", async () => {
    const same = [1, 2, 3, 4].map((i) => ({ ...FOUNDING, topic: `Same ${i}` }));
    runRows = [run("cap", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek), row("grok", "ok", { provider: "xai" })], report([...same, VS_GROK]))];
    const r = (await rows())["cap"];
    expect(r.disagreements).toEqual([1, 2, 3].map((i) => `Same ${i}: ChatGPT says 1789, Claude says 1792`));
    expect(r.qualifiedDisagreements.map((q: any) => q.text)).toEqual([
      ...[1, 2, 3, 4].map((i) => `Same ${i}: ChatGPT says 1789, Claude says 1792`),
      ...[1, 2, 3, 4].map((i) => `Same ${i}`),
    ]);
    expect(r.qualifiedDisagreements.every((q: any) => q.basis === "same_executing_model")).toBe(true);
  });

  it("stored run documents are not modified", async () => {
    const doc = run("frozen", [row("chatgpt", "substituted", deepseek), row("claude", "substituted", deepseek)], report([FOUNDING]));
    const before = JSON.stringify(doc.data);
    runRows = [doc];
    await rows();
    expect(JSON.stringify(doc.data)).toBe(before);
  });
});
