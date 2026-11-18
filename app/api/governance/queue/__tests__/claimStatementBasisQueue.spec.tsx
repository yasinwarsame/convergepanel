/**
 * Doc 14 PR-1, R4 owner rulings (2026-11-18) — the governance queue's claim wording, end to end (the REAL
 * `GET /api/governance/queue` over a Firestore double that honours `.select()` projections → the REAL dashboard row):
 *  - MAJOR-1 (reviewer repro): four slots answered by ONE DeepSeek substitute (accurate) + Perplexity (inaccurate) is two
 *    distinct models split 1–1 — never "4/5 models rate this as accurate" / "4/5 models say accurate";
 *  - per-row identity: the "Model verdicts" table names the executing model ("DeepSeek (substituting ChatGPT)"), never
 *    the slot family as if that model ran; MINOR-3: an own slot recording another provider is not its family's model;
 *  - pair multiplicity: one conflict per pair of DISTINCT executing models, named by them;
 *  - numeric qualifier: the score is not presented as independent corroboration without one model per slot;
 *  - control: a record whose slots are each their own model keeps the established DTO lines.
 * The full space is covered by lib/verification/__tests__/claimStatementInventoryGov*.spec.tsx; these are the named cases.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: async () => ({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" }),
}));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: async () => ({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" }),
  runOwnerVisibleInGovernance: () => true,
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));
let verRows: Array<{ id: string; data: Record<string, unknown> }> = [];
function query(name: string, fields: string[] | null): any {
  const rows = () => (name === "verifications" ? verRows : []);
  const project = (data: Record<string, unknown>) => (fields ? Object.fromEntries(fields.filter((f) => f in data).map((f) => [f, data[f]])) : data);
  return {
    where: () => query(name, fields),
    orderBy: () => query(name, fields),
    limit: () => query(name, fields),
    select: (...f: string[]) => query(name, f),
    get: async () => ({ docs: rows().map((r) => ({ id: r.id, data: () => project(r.data) })) }),
  };
}
const mockAdminDb: any = {
  collection: (name: string) =>
    name === "runs" || name === "verifications" || name === "videoVerifications" ? query(name, null) : { doc: () => ({ get: async () => ({ exists: false }) }) },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";
import { FragmentRow, queueConsensusText } from "@/components/governance/GovernanceDashboard";
import { textNodes } from "@/lib/verification/__tests__/claimStatementInventory.harness";

const OWN: Record<string, string> = { chatgpt: "openai", claude: "anthropic", gemini: "google", grok: "xai", perplexity: "perplexity" };
const PART = "The tower was completed in eighteen eighty nine for the exposition";
const row = (modelId: string, verdict: string, rec: { sub?: boolean; provider?: string } = {}) => ({
  modelId,
  status: "ok",
  verdict,
  confidence: "high",
  summary: `${modelId} says ${verdict}`,
  correctParts: verdict === "accurate" ? [PART] : [],
  incorrectParts: verdict === "inaccurate" ? [PART] : [],
  unverifiableParts: [],
  ...(rec.sub ? { substituted: true } : {}),
  provider: rec.provider ?? OWN[modelId],
});
const failed = (modelId: string) => ({ modelId, status: "failed", verdict: "failed", confidence: "low", summary: "x", correctParts: [], incorrectParts: [], unverifiableParts: [] });
const DS = { sub: true, provider: "deepseek" };
const ver = (id: string, modelResults: unknown[]) => ({
  id,
  data: {
    userId: "owner-a",
    type: "claim_verification",
    claim: id,
    verdict: "confirmed",
    consensusScore: 92,
    evidenceQuality: "strong",
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    timestamp: { toMillis: () => Date.now() },
    modelResults,
  },
});

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function rows(): Promise<Record<string, any>> {
  const res = await GET(new NextRequest("http://localhost/api/governance/queue?limit=50"));
  expect(res.status).toBe(200);
  const json = await res.json();
  return Object.fromEntries(json.runs.map((r: any) => [r.runId, r]));
}
function rendered(r: Record<string, unknown>): string[] {
  const noop = () => {};
  return textNodes(
    renderToStaticMarkup(
      createElement("table", null, createElement("tbody", null, createElement(FragmentRow as never, {
        row: r, chip: { wrap: "", label: "Review" }, mh: { text: "", cls: "", title: "" }, ev: { text: "", cls: "" }, exp: true, firstReason: "", more: "",
        consensusColor: () => "", expanded: new Set<string>(), setExpanded: noop, reviewBusyKey: null, onApprove: noop, onBlock: noop, onChanges: noop,
      } as never)))
    )
  );
}

describe("governance queue claim rows on the shared statement basis (R4)", () => {
  it("MAJOR-1 repro: 4 DeepSeek substitute slots (accurate) + Perplexity (inaccurate) → no '4/5 models', executing names, one pair, qualified score", async () => {
    verRows = [ver("S1", [row("chatgpt", "accurate", DS), row("claude", "accurate", DS), row("gemini", "accurate", DS), row("grok", "accurate", DS), row("perplexity", "inaccurate")])];
    const r = (await rows())["S1"];
    const json = JSON.stringify(r);
    const units = rendered(r);
    // No count of slots presented as models, anywhere in the DTO or the rendered row.
    expect(json).not.toMatch(/4\/5 models/);
    expect(units.join(" | ")).not.toMatch(/\d+\/\d+ models/);
    // The DTO omits the key (no agreement line about models); asserted as state, without masking (Quality Gate preflight).
    expect(r.agreementPoints).toBeUndefined();
    expect(r.agreementSummary).toBeUndefined();
    // Per-row executing identity.
    expect(r.modelVerdicts.map((m: any) => m.label ?? m.modelId)).toEqual([
      "DeepSeek (substituting ChatGPT)",
      "DeepSeek (substituting Claude)",
      "DeepSeek (substituting Gemini)",
      "DeepSeek (substituting Grok)",
      "perplexity",
    ]);
    expect(units).toEqual(expect.arrayContaining(["DeepSeek (substituting ChatGPT)", "Perplexity"]));
    expect(units).not.toContain("ChatGPT");
    // The split stated between the two distinct executing models.
    expect(r.disagreementPoints).toEqual([
      "DeepSeek (substituting ChatGPT, Claude, Gemini, Grok) rated as accurate (others disagree)",
      "Perplexity rated as inaccurate (others disagree)",
    ]);
    // One conflict observation for the one pair of distinct executing models (was four), named by the executing models
    // (R5 MINOR-4: was "(chatgpt) vs (perplexity) [DeepSeek (substituting …), Perplexity]").
    expect(r.disagreements).toEqual(["Conflicting assessments: DeepSeek (substituting ChatGPT, Claude, Gemini, Grok) vs Perplexity"]);
    expect(units.filter((u) => u.startsWith("Conflicting assessments"))).toHaveLength(1);
    // The score is not independent corroboration.
    expect(r.consensusBasis).toBe("slot_responses");
    expect(queueConsensusText(r as never, false)).toBe("92 (computed over panel slot responses, not independent corroboration)");
    expect(units).toContain("92 (computed over panel slot responses, not independent corroboration)");
  });

  it("MINOR-3: an own slot recording another provider without the substituted flag is not named as its family", async () => {
    verRows = [ver("M3", [row("chatgpt", "accurate", { provider: "deepseek" }), row("claude", "accurate"), row("gemini", "accurate"), row("grok", "accurate"), row("perplexity", "inaccurate")])];
    const r = (await rows())["M3"];
    expect(r.modelVerdicts[0]).toEqual(expect.objectContaining({ modelId: "chatgpt", label: "ChatGPT slot (executing model not identified)" }));
    expect(rendered(r)).toContain("ChatGPT slot (executing model not identified)");
  });

  it("one substitute answered alone: the single-model assessment names the executing model, not the slot family", async () => {
    verRows = [ver("ONE", [row("chatgpt", "accurate", DS), failed("claude"), failed("gemini")])];
    const r = (await rows())["ONE"];
    expect(r.singleModelAssessment).toBe("One independent model's assessment (DeepSeek (substituting ChatGPT)): accurate — not agreement between models");
  });

  it("control: five own models keep the established lines; no label, no score qualifier", async () => {
    verRows = [ver("OWN", [row("chatgpt", "accurate"), row("claude", "accurate"), row("gemini", "accurate"), row("grok", "accurate"), row("perplexity", "inaccurate")])];
    const r = (await rows())["OWN"];
    expect(r.agreementPoints).toEqual(["4/5 models rate this as accurate"]);
    expect(r.agreementSummary).toBe("4/5 models say accurate");
    expect(r.disagreementPoints).toEqual(["Perplexity rated as inaccurate (others disagree)"]);
    expect(r.modelVerdicts.some((m: any) => "label" in m)).toBe(false);
    expect(r.consensusBasis).toBeUndefined();
    expect(queueConsensusText(r as never, false)).toBe("92");
  });
});
