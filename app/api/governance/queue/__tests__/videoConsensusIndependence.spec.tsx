/**
 * Review of 0ca72b0, MINOR m3 / owner order B3 — the governance queue's VIDEO rows apply the independent-executing-model
 * requirement to the stored consensus score, exactly as claim and research rows already do:
 *  - one video model answered (the other failed) → score / evidence quality withheld ("insufficient");
 *  - execution identity not recorded (no / malformed modelResults) → withheld as UNVERIFIED;
 *  - two independent video models answered → stored score and evidence quality unchanged.
 * The stored record is never modified. Also NIT n1: a claim run with ≥ 2 independent models where only ONE has a
 * consistent verdict never yields "1/1 models say …".
 * Harness: GET route with a Firestore double that honours `.select()` projections (as verificationAgreementWording.spec).
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
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: null, authReady: false }) }));
jest.mock("@/hooks/useUserPlan", () => ({ useUserPlan: () => ({}) }));

let verRows: Array<{ id: string; data: Record<string, unknown> }> = [];
let vidRows: Array<{ id: string; data: Record<string, unknown> }> = [];
const projections: Record<string, string[][]> = { verifications: [], videoVerifications: [] };

/** A query double whose `.select(...fields)` really projects each document to those fields (Firestore semantics). */
function query(name: string, fields: string[] | null): any {
  const rows = () => (name === "verifications" ? verRows : name === "videoVerifications" ? vidRows : []);
  const project = (data: Record<string, unknown>) =>
    fields ? Object.fromEntries(fields.filter((f) => f in data).map((f) => [f, data[f]])) : data;
  return {
    where: () => query(name, fields),
    orderBy: () => query(name, fields),
    limit: () => query(name, fields),
    select: (...f: string[]) => {
      projections[name]?.push(f);
      return query(name, f);
    },
    get: async () => ({ docs: rows().map((r) => ({ id: r.id, data: () => project(r.data) })) }),
  };
}
const mockAdminDb: any = {
  collection: (name: string) =>
    name === "runs" || name === "verifications" || name === "videoVerifications"
      ? query(name, null)
      : { doc: () => ({ get: async () => ({ exists: false }) }) },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: async () => ({ status: "not_found" }) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";
import { queueConsensusText } from "@/components/governance/GovernanceDashboard";
import { CONSENSUS_WITHHELD_TEXT } from "@/lib/panel/independentVoices";

const vrow = (modelId: string, status: "ok" | "parse_error" | "failed", verdict: string, extra: Record<string, unknown> = {}) => ({
  modelId,
  status,
  verdict: status === "ok" ? verdict : status,
  confidence: "high",
  summary: `${modelId} summary`,
  correctParts: [],
  incorrectParts: [],
  unverifiableParts: [],
  ...extra,
});
const DS = { substituted: true, provider: "deepseek" };
const ver = (id: string, modelResults: unknown[] | undefined, selectedModels?: string[]) => ({
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
    ...(modelResults ? { modelResults } : {}),
    ...(selectedModels ? { selectedModels } : {}),
  },
});
const vid = (id: string, modelResults: unknown[]) => ({
  id,
  data: {
    userId: "owner-a",
    type: "video_verification",
    fileName: `${id}.mp4`,
    verdict: "authentic",
    consensusScore: 80,
    governanceStatus: "needs_review",
    governanceReasons: ["r1"],
    timestamp: { toMillis: () => Date.now() },
    modelResults,
  },
});
const LONG_A = "The structure was completed in March of that year by the original builders";
const LONG_B = "Opening ceremonies happened much later according to municipal archives";
const vidWith = (id: string, extra: Record<string, unknown>, modelResults?: unknown) => {
  const v = vid(id, modelResults as unknown[]);
  const data: Record<string, unknown> = { ...v.data, evidenceQuality: "strong", ...extra };
  if (modelResults === undefined) delete data.modelResults;
  return { id, data };
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  projections.verifications = [];
  projections.videoVerifications = [];
  verRows = [];
  vidRows = [];
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
});
afterEach(() => jest.restoreAllMocks());

async function rows(): Promise<Record<string, any>> {
  const res = await GET(new NextRequest("http://localhost/api/governance/queue"));
  expect(res.status).toBe(200);
  const json = await res.json();
  return Object.fromEntries(json.runs.map((r: any) => [r.runId, r]));
}

describe("B3: video queue rows — consensus score requires two independent executing models", () => {
  // Phase 0 (L15, O14 = A): the DTO keeps the STORED score / evidence quality (35933c8); `consensusWithheld` is
  // additive and the dashboard presents the reason, never the number (queueConsensusText / queuePresentedScore).
  it("one executing model (one answered, one failed): stored score kept in the DTO, withheld at presentation, reason shown", async () => {
    const stored = vidWith("v-one", {}, [vrow("gemini", "ok", "authentic"), vrow("chatgpt", "failed", "")]);
    const before = JSON.stringify(stored.data);
    vidRows = [stored];
    const r = (await rows())["v-one"];
    // C-c (CC-12, PQ-2 (a) strict): video rows record no provider, so the shared gate reads every video record as
    // UNVERIFIED (was "insufficient" under the modelId rule).
    expect([r.consensusScore, r.evidenceQuality, r.consensusWithheld, r.modelIndependence]).toEqual([
      80,
      "strong",
      "independence_unverified",
      "unverified",
    ]);
    expect(queueConsensusText(r, false)).toBe(CONSENSUS_WITHHELD_TEXT.independence_unverified);
    expect(queueConsensusText(r, false)).not.toMatch(/\d/);
    // Stored record unchanged.
    expect(JSON.stringify(stored.data)).toBe(before);
  });

  it("the same model id in two ok rows is one executing model: withheld at presentation (stored score kept)", async () => {
    vidRows = [vidWith("v-dup", {}, [vrow("gemini", "ok", "authentic"), vrow("gemini", "ok", "authentic")])];
    const r = (await rows())["v-dup"];
    expect([r.consensusScore, r.consensusWithheld]).toEqual([80, "independence_unverified"]); // C-c CC-12 (was insufficient)
  });

  it("unknown provenance (no modelResults, or a row without model id / status): withheld at presentation as UNVERIFIED (stored score kept)", async () => {
    vidRows = [
      vidWith("v-none", {}, undefined),
      vidWith("v-bad", {}, [vrow("gemini", "ok", "authentic"), { status: "ok", verdict: "authentic" }]),
    ];
    const all = await rows();
    for (const id of ["v-none", "v-bad"]) {
      const r = all[id];
      expect([r.consensusScore, r.evidenceQuality, r.consensusWithheld, r.modelIndependence]).toEqual([80, "strong", "independence_unverified", "unverified"]);
      expect(queueConsensusText(r, false)).toBe(CONSENSUS_WITHHELD_TEXT.independence_unverified);
    }
  });

  it("C-c (CC-12, PQ-2 strict): two ok video rows with distinct modelIds are NOT inferred independent — unverified, stored score kept", async () => {
    vidRows = [vidWith("v-two", {}, [vrow("gemini", "ok", "authentic"), vrow("chatgpt", "ok", "authentic")])];
    const r = (await rows())["v-two"];
    expect([r.consensusScore, r.evidenceQuality, r.consensusWithheld, r.modelIndependence]).toEqual([80, "strong", "independence_unverified", "unverified"]);
    expect(queueConsensusText(r, false)).toBe(CONSENSUS_WITHHELD_TEXT.independence_unverified);
    expect(r.singleModelAssessment).toBeUndefined();
  });

  it("C-c (CC-12): the video rule is the shared gate — rows that recorded registered providers would verify (not a recorded shape today)", async () => {
    vidRows = [vidWith("v-prov", {}, [vrow("gemini", "ok", "authentic", { provider: "google" }), vrow("chatgpt", "ok", "authentic", { provider: "openai" })])];
    const r = (await rows())["v-prov"];
    expect(["consensusWithheld" in r, "modelIndependence" in r]).toEqual([false, false]);
  });

  it("no stored score: nothing to withhold (no reason attached)", async () => {
    const v = vidWith("v-noscore", {}, [vrow("gemini", "ok", "authentic"), vrow("chatgpt", "failed", "")]);
    delete v.data.consensusScore;
    delete v.data.evidenceQuality;
    vidRows = [v];
    const r = (await rows())["v-noscore"];
    expect([r.consensusScore, r.evidenceQuality]).toEqual([null, null]);
    expect("consensusWithheld" in r).toBe(false);
  });
});

describe("NIT n1: never '1/1 models say …'", () => {
  it("≥ 2 independent models, only one with a consistent verdict (DeepSeek answered two slots differently)", async () => {
    verRows = [
      ver("n1", [
        vrow("chatgpt", "ok", "accurate", DS),
        vrow("claude", "ok", "inaccurate", DS),
        // C-b (CB-01): the own-provider row records its provider, so the shared gate verifies the record.
        vrow("grok", "ok", "accurate", { provider: "xai" }),
      ]),
    ];
    const r = (await rows())["n1"];
    expect(r.modelIndependence).toBeUndefined();
    // R4 owner ruling (MAJOR-1): the 35933c8 slot tally "2/3 models say accurate" counted 3 SLOTS of 2 executing
    // models; with DeepSeek inconsistent across its slots nothing is stated about models — the slot responses are
    // listed as a qualified signal. Never "1/1".
    expect(r.agreementSummary).toBeUndefined();
    expect(r.qualifiedDisagreements).toEqual(expect.arrayContaining([
      { text: "Panel slot responses: 2 accurate, 1 inaccurate. These counts are of panel slot responses, not of agreeing models (2 answered by a substitute model; 2 distinct executing providers).", basis: "same_executing_model" },
    ]));
    expect(JSON.stringify(r)).not.toMatch(/\b1\/1 models/);
  });

  it("control: two consistent independent models keep their tally", async () => {
    verRows = [ver("n1c", [vrow("chatgpt", "ok", "accurate"), vrow("claude", "ok", "accurate")])];
    const r = (await rows())["n1c"];
    expect(r.agreementSummary).toBe("2/2 models say accurate");
  });
});

describe("NIT n2: same-executing-model digest pair in a run with ≥ 2 independent models", () => {
  it("DeepSeek×2 + Grok: the chatgpt-vs-claude conflict is qualified (same executing model), never a genuine disagreement", async () => {
    // Doc 14 PR-1 (D-5): the pair is on OPPOSITE sides (accurate vs inaccurate) so the digest still reports it and this
    // test keeps exercising the same-executing-model qualification. Before PR-1 both rows were "accurate"; two models
    // on the same side are no longer a conflict (asserted in the next test).
    verRows = [
      ver("n2", [
        vrow("chatgpt", "ok", "accurate", { ...DS, incorrectParts: [LONG_A] }),
        vrow("claude", "ok", "inaccurate", { ...DS, incorrectParts: [LONG_B] }),
        // C-b (CB-01): the own-provider row records its provider, so the shared gate verifies the record.
        vrow("grok", "ok", "accurate", { provider: "xai" }),
      ]),
    ];
    const r = (await rows())["n2"];
    expect(r.modelIndependence).toBeUndefined();
    // With the pair on opposite sides the existing verdict-dissent qualification of one executing model also applies
    // (as in verificationAgreementWording.spec.tsx "two responses from the same DeepSeek fallback").
    expect(r.qualifiedDisagreements).toEqual([
      { text: "DeepSeek (substituting ChatGPT, Claude) rated as accurate; inaccurate — repeated outputs from one executing model", basis: "same_executing_model" },
      { text: "Conflicting assessments: (chatgpt) vs (claude)", basis: "same_executing_model" },
      { text: "Panel slot responses: 2 accurate, 1 inaccurate. These counts are of panel slot responses, not of agreeing models (2 answered by a substitute model; 2 distinct executing providers).", basis: "same_executing_model" },
    ]);
    // R4 owner ruling (MAJOR-1): the same-executing-model pair is no longer ALSO kept in the "Where models disagree"
    // digest lines (the 35933c8 DTO kept it there); it is listed only as qualified.
    expect(r.disagreements).toBeUndefined();
  });

  it("doc 14 PR-1 (D-5): the same DeepSeek pair on the SAME side (both accurate) is no conflict at all", async () => {
    verRows = [
      ver("n2s", [
        vrow("chatgpt", "ok", "accurate", { ...DS, incorrectParts: [LONG_A] }),
        vrow("claude", "ok", "accurate", { ...DS, incorrectParts: [LONG_B] }),
        vrow("grok", "ok", "accurate", { provider: "xai" }),
      ]),
    ];
    const r = (await rows())["n2s"];
    expect(r.qualifiedDisagreements).toBeUndefined();
    expect("disagreements" in r).toBe(false);
  });
});
