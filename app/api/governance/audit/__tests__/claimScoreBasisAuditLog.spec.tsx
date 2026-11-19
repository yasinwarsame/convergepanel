/**
 * R5 (review record 16, section F, MINOR-1) — the governance Audit Log "N/100" badge of a CLAIM event is presented on the
 * same shared claim score basis as every other claim surface (lib/verification/claimConsensusPresentation.ts
 * `claimScoreText`): the recorded score is withheld with its reason when the verification's persisted rows do not prove
 * >= 2 independent executing models, and carries the R4 slot-response qualifier when they do but the slots are not each a
 * distinct identified model. The stored audit event, its `consensusScore` field and every governance decision are
 * unchanged — the route adds presentation-only keys (`consensusWithheld`, `consensusBasis`). Research and video events
 * are not claim records and are left as they were.
 */
const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: (v: string[] | null, o: string) => v === null || v.includes(o),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({ validateRunWorkspaceAssociation: jest.fn(async () => ({ classification: "legacy" })) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

const parents = new Map<string, Record<string, unknown>>();
let auditRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let failClaimRowReads = false;

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "admin_audit_logs") {
      const snap = () => ({ docs: auditRows.map((r) => ({ id: r.id, data: () => r.data })) });
      return {
        where: (_f: string, _op: string, runId: string) => ({
          limit: () => ({ select: () => ({ get: async () => ({ docs: auditRows.filter((r) => r.data.runId === runId).map((r) => ({ id: r.id, data: () => r.data })) }) }) }),
        }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap() }) }) }),
        limit: () => ({ select: () => ({ get: async () => snap() }) }),
      };
    }
    return {
      doc: (id: string) => ({
        __path: `${name}/${id}`,
        get: async () => {
          const data = parents.get(`${name}/${id}`);
          return { exists: !!data, data: () => data };
        },
        collection: () => ({
          orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
          get: async () => ({ docs: [] }),
        }),
      }),
    };
  },
  getAll: async (...args: any[]) => {
    const last = args[args.length - 1];
    const hasOpts = last && typeof last === "object" && "fieldMask" in last;
    const refs = hasOpts ? args.slice(0, -1) : args;
    const mask: string[] | undefined = hasOpts ? last.fieldMask : undefined;
    if (failClaimRowReads && mask && mask.includes("modelResults")) throw new Error("claim row read failed");
    return refs.map((ref: any) => {
      if (ref.__path.startsWith("users/")) return { exists: true, data: () => ({ email: "owner@example.com" }) };
      const full = parents.get(ref.__path);
      if (!full) return { exists: false, data: () => undefined };
      const masked: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(full)) if (!mask || mask.includes(k)) masked[k] = v;
      return { exists: true, data: () => masked };
    });
  },
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/audit/route";
import { AuditLogEventCard } from "@/components/governance/GovernanceDashboard";

const CREATOR = "creator-uid";
const VIEWER = "legacy-reviewer";
const QUALIFIED = "92/100 (computed over panel slot responses, not independent corroboration)";
const RETAINED_INSUFFICIENT = "92/100 (fewer than two independent models, not independent corroboration)";
const RETAINED_UNVERIFIED = "92/100 (unverified: model independence not recorded)";
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
const ALL_DS = [row("chatgpt", "accurate", DS), row("claude", "accurate", DS), row("gemini", "accurate", DS)];
const OWN_TWO = [row("chatgpt", "accurate"), row("claude", "accurate")];

function claimParent(id: string, modelResults: unknown[] | undefined) {
  parents.set(`verifications/${id}`, {
    userId: CREATOR,
    type: "claim_verification",
    ...(modelResults ? { modelResults, selectedModels: (modelResults as Array<{ modelId: string }>).map((r) => r.modelId) } : {}),
  });
}
function event(id: string, collection: string, runId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    data: { action: "approved", byUid: VIEWER, byEmail: "r@example.com", at: `2026-09-10T00:00:${id.slice(-2)}.000Z`, collection, runId, runOwnerUid: CREATOR, question: `q ${runId}`, consensusScore: 92, ...extra },
  };
}
function asViewer() {
  mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: true, uid: VIEWER, email: `${VIEWER}@example.com` });
  mockedResolveVisibleUserIds.mockResolvedValueOnce({ ok: true, visibleUserIds: [CREATOR] });
}
async function get(qs: string) {
  const res = await GET(new NextRequest(`http://localhost/api/governance/audit${qs}`));
  return { status: res.status, body: await res.json() };
}
const card = (ev: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(AuditLogEventCard as any, {
      ev,
      inlineTrail: { eventId: "", runId: "", collection: "runs", events: [], loading: false, error: null },
      onToggleTrail: () => undefined,
      viewer: { uid: VIEWER, email: null },
    })
  ).replace(/<!-- -->/g, "");

beforeEach(() => {
  jest.clearAllMocks();
  parents.clear();
  auditRows = [];
  failClaimRowReads = false;
});

describe("governance Audit Log — claim score badge on the shared claim score basis (R5)", () => {
  it("global list: collapsed slots → qualified; one substitute only → withheld; own models → plain; research/video untouched", async () => {
    claimParent("v-mix", MIX);
    claimParent("v-ds", ALL_DS);
    claimParent("v-own", OWN_TWO);
    claimParent("v-none", undefined);
    parents.set("runs/r1", { userId: CREATOR });
    parents.set("videoVerifications/vid1", { userId: CREATOR });
    auditRows = [
      event("e06", "verifications", "v-mix"),
      event("e05", "verifications", "v-ds"),
      event("e04", "verifications", "v-own"),
      event("e03", "verifications", "v-none"),
      event("e02", "runs", "r1"),
      event("e01", "videoVerifications", "vid1"),
    ];
    asViewer();
    const r = await get("?limit=20");
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.events.map((e: any) => [e.id, e]));
    // The recorded score is unchanged in the DTO; the presentation keys are additive.
    for (const id of ["e06", "e05", "e04", "e03", "e02", "e01"]) expect([id, by[id].consensusScore]).toEqual([id, 92]);
    expect([by.e06.consensusBasis, by.e06.consensusWithheld]).toEqual(["slot_responses", undefined]);
    expect([by.e05.consensusBasis, by.e05.consensusWithheld]).toEqual([undefined, "insufficient_independent_models"]);
    expect(["consensusBasis" in by.e04, "consensusWithheld" in by.e04]).toEqual([false, false]);
    expect([by.e03.consensusBasis, by.e03.consensusWithheld]).toEqual([undefined, "independence_unverified"]);
    for (const id of ["e02", "e01"]) expect([id, "consensusBasis" in by[id], "consensusWithheld" in by[id]]).toEqual([id, false, false]);

    expect(card(by.e06)).toContain(`>${QUALIFIED}</span>`);
    // R6 owner decision B2: the Audit Log RETAINS the valid recorded number, qualified — never withheld, never bare.
    expect(card(by.e05)).toContain(`>${RETAINED_INSUFFICIENT}</span>`);
    expect(card(by.e05)).not.toContain("No consensus score");
    expect(card(by.e05)).not.toContain(">92/100<");
    expect(card(by.e03)).toContain(`>${RETAINED_UNVERIFIED}</span>`);
    expect(card(by.e03)).not.toContain("Consensus score withheld");
    expect(card(by.e03)).not.toContain(">92/100<");
    expect(card(by.e04)).toContain(">92/100</span>");
    expect(card(by.e04)).not.toContain("slot responses");
    expect(card(by.e02)).toContain(">92/100</span>");
  });

  it("global list: the claim-row read fails → every claim score withheld as unverified (fail closed)", async () => {
    claimParent("v-mix", MIX);
    auditRows = [event("e06", "verifications", "v-mix")];
    failClaimRowReads = true;
    asViewer();
    const r = await get("?limit=20");
    expect(r.status).toBe(200);
    expect(r.body.events[0].consensusWithheld).toBe("independence_unverified");
    // R6 B2: the number is kept, explicitly unverified — never presented as independent agreement.
    expect(card(r.body.events[0])).toContain(`>${RETAINED_UNVERIFIED}</span>`);
    expect(card(r.body.events[0])).not.toContain(">92/100<");
  });

  it("selectedModels is read: a requested model without a row makes otherwise-independent rows unverified (review M17)", async () => {
    parents.set("verifications/v-req", { userId: CREATOR, type: "claim_verification", modelResults: OWN_TWO, selectedModels: ["chatgpt", "claude", "grok"] });
    claimParent("v-own", OWN_TWO);
    auditRows = [event("e02", "verifications", "v-req"), event("e01", "verifications", "v-own")];
    asViewer();
    const r = await get("?limit=20");
    const by = Object.fromEntries(r.body.events.map((e: any) => [e.id, e]));
    expect(by.e02.consensusWithheld).toBe("independence_unverified");
    expect("consensusWithheld" in by.e01).toBe(false);
  });

  it("drilldown (?runId=&collection=verifications): the trail rows carry the same presentation keys", async () => {
    claimParent("v-mix", MIX);
    auditRows = [event("e06", "verifications", "v-mix")];
    asViewer();
    const r = await get("?runId=v-mix&collection=verifications");
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: any) => [e.id, e.consensusScore, e.consensusBasis])).toEqual([["e06", 92, "slot_responses"]]);
  });

  it("R6 B2: the badge carries no aria-label / title of its own — its accessible name is the qualified visible text", () => {
    const html = card({ id: "x", action: "approved", at: "2026-09-10T00:00:00.000Z", collection: "verifications", runId: "v", consensusScore: 92, consensusWithheld: "insufficient_independent_models" });
    const badge = /<span[^>]*>92\/100[^<]*<\/span>/.exec(html)?.[0] ?? "";
    expect(badge).toContain(`>${RETAINED_INSUFFICIENT}</span>`);
    expect(badge).not.toMatch(/aria-label=|title=/);
    // A non-claim (research) event keeps its bare recorded score.
    expect(card({ id: "y", action: "approved", at: "2026-09-10T00:00:00.000Z", collection: "runs", runId: "r", consensusScore: 92 })).toContain(">92/100</span>");
  });
});
