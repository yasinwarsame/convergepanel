/**
 * Phase 0 compatibility restoration — T-syn-route (inventory v3.4 H-10a; owner Option C, 2026-11-08).
 *
 * Decision equality through the REAL /api/synthesize-panel POST and GET handlers: for 15 stored-run scenarios (all
 * DeepSeek, partly DeepSeek, provider-less substitutes, independent control, the retained missing-key safeguard, and
 * multi-position syntheses) every decision output must equal 35933c8 — status, refusal reason, LLM call count, written
 * synthesisInputHash, prompt digest, synthesisConsensusSummary / policyConsensusSummary (and their count units), the
 * governance input and its classification by the real evaluateGovernance, the rows handed to synthesizeReport and to
 * computeSynthesisConsensusScoring (keys and values), the written field set, the response bodies, and the cached
 * re-POST (seeded with the 35933c8 hash) and GET.
 *
 * Harness: the fake Firestore / captured LLM of serverAuthoritativeInputs.spec.ts (scratch probe c22route, promoted).
 * Oracle (fixtures/phase0SynthesisRoute.golden.json): THIS file run unchanged in a git-archive export of 35933c8 with
 * PHASE0_GOLDEN_OUT set — never computed from the code under test.
 */
process.env.TZ = "UTC";
import { installDeletionTombstoneCollection } from "@/lib/workspaces/__tests__/helpers/deletionTombstoneCollection";
jest.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } }));
jest.mock("@/lib/env", () => ({ OPENAI_API_KEY: "test-key", ANTHROPIC_API_KEY: "test-key" }));
jest.mock("@/lib/firebase/auth-helpers", () => ({ verifySessionCookie: jest.fn().mockResolvedValue({ uid: "test-uid" }) }));
jest.mock("@/lib/firebase/auth", () => ({ verifyIdToken: jest.fn() }));
jest.mock("@/lib/security/rateLimit", () => ({ checkRateLimit: jest.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() }) }));

const runDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb = {
  runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
    const buffered: Array<() => Promise<unknown>> = [];
    const result = await fn({
      get: (ref: any) => ref.get(),
      update: (ref: any, f: unknown) => void buffered.push(() => ref.update(f)),
      set: (ref: any, f: unknown, o?: unknown) => void buffered.push(() => ref.set(f, o)),
      create: (ref: any, f: unknown) => void buffered.push(() => (ref.create ? ref.create(f) : ref.set(f))),
    });
    for (const w of buffered) await w();
    return result;
  },
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: jest.fn().mockImplementation(async () => {
        if (name === "users") return { exists: true, data: () => ({ email: "user@example.com" }) };
        const data = runDocs.get(id);
        return { exists: !!data, data: () => (data ? structuredClone(data) : undefined) };
      }),
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => { runDocs.set(id, { ...(runDocs.get(id) || {}), ...fields }); }),
      set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => { runDocs.set(id, { ...(opts?.merge ? runDocs.get(id) || {} : {}), ...fields }); }),
      collection: () => ({ add: jest.fn().mockResolvedValue({ id: "event-id" }), doc: () => ({ get: async () => ({ exists: false, data: () => undefined }), set: async () => {} }) }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
installDeletionTombstoneCollection(mockAdminDb);
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: jest.fn(async () => ({ classification: "legacy" })),
}));
const govCalls: any[] = [];
jest.mock("@/lib/governance/evaluateAndStore", () => ({
  evaluateAndStoreGovernance: (...args: unknown[]) => { govCalls.push(JSON.parse(JSON.stringify(args[0] ?? null))); return Promise.resolve({ governanceStatus: "needs_review" }); },
}));
// capture the rows the route hands to synthesizeReport / computeSynthesisConsensusScoring (L04 / L05 byte identity)
const rowShape = (r: any) => ({ keys: Object.keys(r).sort().join(","), modelId: r.modelId, status: r.status, provider: r.provider ?? null, textLen: String(r.rawText ?? r.text ?? "").length });
const synthArgs: any[][] = [];
jest.mock("@/lib/consensus", () => {
  const real = jest.requireActual("@/lib/consensus");
  return { ...real, synthesizeReport: (rows: any[], ...rest: unknown[]) => { synthArgs.push(rows.map(rowShape)); return real.synthesizeReport(rows, ...rest); } };
});
const scoringArgs: any[][] = [];
jest.mock("@/lib/verification/consensusScoring", () => {
  const real = jest.requireActual("@/lib/verification/consensusScoring");
  return { ...real, computeSynthesisConsensusScoring: (input: any) => { scoringArgs.push((input?.results ?? []).map(rowShape)); return real.computeSynthesisConsensusScoring(input); } };
});
const SYNTHESIS = {
  executiveSummary: "Synthesis.",
  keyFindings: [{ claim: "Zanzibar holds the answer.", confidence: "Medium", evidenceRefs: [], modelsSupporting: ["chatgpt", "claude", "gemini"] }],
  disagreements: [{ topic: "Which archive first", whyTheyDiffer: "w", positionsByModel: { chatgpt: "port", claude: "spice" } }],
  biasAndBlindSpots: [],
  openQuestions: [],
  methodology: "Cross-model comparison.",
};
// MJ-A: a multi-position LLM synthesis (two disagreements, >= 3 distinct positions, long topics)
const SYNTHESIS_MP = {
  ...SYNTHESIS,
  keyFindings: [
    { claim: "Zanzibar holds the answer.", confidence: "Medium", evidenceRefs: ["r1"], modelsSupporting: ["chatgpt", "claude", "gemini"] },
    { claim: "Archives are accessible.", confidence: "Low", evidenceRefs: [], modelsSupporting: ["grok"] },
  ],
  disagreements: [
    { topic: "Which archive should be consulted first for the study", whyTheyDiffer: "w", positionsByModel: { chatgpt: "port records", claude: "spice ledgers", gemini: "colonial maps" } },
    { topic: "Whether Madagascar should precede Zanzibar in the plan", whyTheyDiffer: "w", positionsByModel: { grok: "yes, first", perplexity: "no, second", claude: "in parallel" } },
  ],
};
let currentSynthesis: any = SYNTHESIS;
const prompts: string[] = [];
const mockCreate = jest.fn().mockImplementation(async (args: unknown) => {
  prompts.push(JSON.parse(JSON.stringify(args)).messages.map((m: { content: string }) => m.content).join("\n"));
  return { choices: [{ message: { content: JSON.stringify(currentSynthesis) } }] };
});
jest.mock("openai", () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: (...a: unknown[]) => mockCreate(...a) } } })));
jest.mock("@anthropic-ai/sdk", () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/synthesize-panel/route";

const GOLDEN = join(__dirname, "fixtures", "phase0SynthesisRoute.golden.json");
const GOLDEN_OUT = process.env.PHASE0_GOLDEN_OUT;
const Q = "Which island should we study first?";
const TEXTS = [
  "Zanzibar is the island the evidence points to, with a long and well documented trading history across the Indian Ocean.",
  "Zanzibar again stands out: its archives, its port records and its spice trade make it the strongest first candidate.",
  "Zanzibar is the strongest first candidate because its archives and port records are well documented and accessible.",
  "Madagascar should come first; its size and biodiversity records outweigh Zanzibar's trading archives for this study.",
  "Zanzibar first: the trading history across the Indian Ocean is documented in port records and archives.",
];
const IDS = ["chatgpt", "claude", "gemini", "grok", "perplexity"];
const ok = (i: number) => ({ modelId: IDS[i], status: "ok", rawTextTruncated: TEXTS[i], provider: IDS[i] });
const sub = (i: number) => ({ modelId: IDS[i], status: "substituted", rawTextTruncated: TEXTS[i], provider: "deepseek", substitutedFrom: IDS[i] });
const SCEN: Record<string, any[]> = {
  S1: [0, 1, 2, 3, 4].map(sub), // FC: 5 slots, all DeepSeek (1 EM)
  S8a: [0, 1].map(sub), // FC: 2 slots both DeepSeek
  S2: [sub(0), sub(1), ok(2), ok(3), ok(4)], // PC: 2 DeepSeek + 3 native (4 EM)
  S2b: [sub(0), sub(1), sub(2), sub(3), ok(4)], // PC: 4 DeepSeek + 1 native (2 EM)
  S4: [0, 1, 2, 3, 4].map(ok), // IND control (BI35)
  // missing-key safeguard (L08, retained): a not-configured slot is persisted as failed and never usable
  S7n: [{ modelId: "chatgpt", status: "failed", rawTextTruncated: "Model unavailable.", errorCode: "provider_not_configured" }, { modelId: "claude", status: "failed", rawTextTruncated: "Model unavailable.", errorCode: "provider_not_configured" }, sub(2), sub(3), ok(4)],
  SMK: [ok(0), { modelId: "claude", status: "failed", rawTextTruncated: "Model unavailable.", errorCode: "provider_not_configured" }],
  // UV / S3mn: substitutes whose provider is not recorded
  S2u: [{ ...sub(0), provider: undefined }, { ...sub(1), provider: undefined }, ok(2), ok(3), ok(4)],
  S3mn: [ok(0), ok(1), { ...sub(2), provider: undefined }],
};
// scenarios re-run with the multi-position LLM synthesis
for (const k of ["S1", "S2", "S2b", "S4", "S7n", "S2u"]) SCEN[`${k}-MP`] = SCEN[k];
const USABLE = (pm: any[]) => pm.filter((r) => r.status === "ok" || r.status === "substituted").length;
const DROP = new Set(["requestId", "timestamp", "generatedAt", "synthesizedAt", "durationMs", "timing", "latencyMs"]);
const strip = (x: any) => JSON.parse(JSON.stringify(x ?? null, (k, v) => (DROP.has(k) ? undefined : v)));
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
function post(runId: string) {
  return POST(new NextRequest("http://localhost/api/synthesize-panel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, question: "client q", results: [{ modelId: "chatgpt", text: "client", status: "ok" }, { modelId: "claude", text: "client2", status: "ok" }] }) }));
}
function get(runId: string) {
  return GET(new NextRequest(`http://localhost/api/synthesize-panel?runId=${runId}`, { method: "GET" }));
}

it("T-syn-route: every scenario's decision record equals 35933c8 (fresh POST, cached POST seeded with the 35933c8 hash, GET)", async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  const golden = !GOLDEN_OUT && existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : null;
  if (!GOLDEN_OUT) expect(golden).not.toBeNull();
  const oldHashes = golden ? golden.fresh : null;
  const out: any = { fresh: {}, cached: {} };
  for (const [name, perModel] of Object.entries(SCEN)) {
    // Phase 1: fresh POST
    currentSynthesis = name.endsWith("-MP") ? SYNTHESIS_MP : SYNTHESIS;
    runDocs.clear(); prompts.length = 0; mockCreate.mockClear(); govCalls.length = 0; synthArgs.length = 0; scoringArgs.length = 0;
    runDocs.set(`run-${name}`, { userId: "test-uid", question: Q, runDocument: { question: Q, perModel } });
    const res = await post(`run-${name}`);
    const body: any = await res.json();
    const doc: any = runDocs.get(`run-${name}`) ?? {};
    out.fresh[name] = {
      status: res.status, reason: body?.details?.reason ?? body?.reason ?? null, message: body?.error ?? body?.message ?? null,
      llmCalls: mockCreate.mock.calls.length,
      hash: doc.synthesisInputHash ?? null,
      promptDigest: prompts.length ? sha(prompts.join("\n").replace(/req_[a-z0-9-]+/gi, "")) : null,
      summary: doc.synthesisConsensusSummary ?? null,
      policy: doc.policyConsensusSummary ?? null,
      governanceInput: govCalls[0] ? { consensusScore: govCalls[0]?.input?.consensusScore ?? govCalls[0]?.consensusScore ?? null, evidenceQuality: govCalls[0]?.input?.evidenceQuality ?? govCalls[0]?.evidenceQuality ?? null, raw: govCalls[0] } : null,
      // m-1: COPIES per scenario (the c21 probe stored the shared arrays by reference)
      synthesizeReportRows: synthArgs.map((call) => call.map((r) => ({ ...r }))),
      scoringRows: scoringArgs.map((call) => call.map((r) => ({ ...r }))),
      body: strip(body),
      docFields: Object.keys(doc).sort(),
      units: doc.synthesisConsensusSummary
        ? { usableSlots: USABLE(perModel), modelsHealthy: doc.synthesisConsensusSummary.modelsHealthy ?? null, modelCount: doc.synthesisConsensusSummary.modelCount ?? null, policyModelsHealthy: doc.policyConsensusSummary?.modelsHealthy ?? null }
        : null,
      governanceClass: govCalls[0]
        ? (() => { const g = jest.requireActual("@/lib/governance/evaluateGovernance"); const r = g.evaluateGovernance(govCalls[0].input, g.getDefaultGovernancePolicy()); return { status: r.status, reasons: r.reasons }; })()
        : null,
      storedReport: doc.synthesizedStructuredReport ? { disagreements: (doc.synthesizedStructuredReport.disagreements ?? []).length, keyFindings: (doc.synthesizedStructuredReport.keyFindings ?? []).length } : null,
    };
    // Phase 2: stored run with a cached synthesis written under 35933c8 (S14 for PC/IND, S14-FC for FC)
    const seedHash = oldHashes?.[name]?.hash ?? out.fresh[name].hash;
    runDocs.clear(); prompts.length = 0; mockCreate.mockClear();
    runDocs.set(`run-${name}`, { userId: "test-uid", question: Q, runDocument: { question: Q, perModel }, synthesizedStructuredReport: currentSynthesis, schemaVersion: 1, synthesisInputHash: seedHash, synthesizedAt: "2026-11-01T00:00:00Z", synthesizedBy: "gpt-5.1" });
    const res2 = await post(`run-${name}`);
    const body2: any = await res2.json();
    const resG = await get(`run-${name}`);
    const bodyG: any = await resG.json().catch(() => null);
    out.cached[name] = { postStatus: res2.status, postCached: body2?.cached === true, postLlmCalls: mockCreate.mock.calls.length, getStatus: resG.status, getHasReport: !!(bodyG?.report ?? bodyG?.synthesizedStructuredReport ?? bodyG?.cached), postBody: strip(body2), getBody: strip(bodyG) };
  }
  expect(Object.keys(out.fresh).length).toBe(15);
  if (GOLDEN_OUT) {
    writeFileSync(GOLDEN_OUT, JSON.stringify(out, null, 1));
    return;
  }
  for (const name of Object.keys(SCEN)) {
    expect([name, out.fresh[name]]).toEqual([name, golden.fresh[name]]);
    expect([name, out.cached[name]]).toEqual([name, golden.cached[name]]);
  }
  // The decisions the scenarios were chosen for (35933c8 slot rule): all-DeepSeek runs synthesize; the summary counts slots.
  expect([out.fresh.S1.status, out.fresh.S8a.status, out.fresh.SMK.status]).toEqual([200, 200, 409]);
  expect(out.fresh.S2.units).toEqual({ usableSlots: 5, modelsHealthy: 5, modelCount: 5, policyModelsHealthy: out.fresh.S2.units.policyModelsHealthy });
  for (const call of out.fresh.S2.scoringRows) for (const r of call) expect(r.keys).toBe("modelId,rawText,status");
}, 600000);
