/**
 * Order 5 Contract P — builder purity. The full adaptive pipeline (finalizeAdaptiveRun: validation, retry, alignment,
 * field alignment, scoring, consensus integrity, certainty, gate, synthesis report, trust summary, persisted envelope)
 * runs over the shared deterministic scenarios with every model call mocked, and is compared with the output the shipped
 * 2c17feee pipeline produced for the same inputs (hashes captured there, __fixtures__/baseline-2c17fee).
 *
 * The ONLY permitted difference is the optional presentation marker, presentation.disagreementPositionVersion === 1, on
 * eligible new reports (a builder-produced presentation over at least one row). It is removed before comparison;
 * everything else — alignment, statuses, scores, certainty, trust, gate, every stored string, the persisted envelope —
 * must hash identically, with the same model calls (count, order, arguments) and no input mutation.
 *
 * Order 5 Contract C1 (owner ruling O-P, claim-tie attribution): on a case whose rows include an eligible claim-origin
 * tie — decided by the test-side predicate (o5c/claimTieOracle.ts), never the candidate's — the trust summary is the
 * one permitted computed difference. There, and only there:
 *   1. every trust summary in the output is replaced by the frozen 625773767 algorithm's value over the output's own
 *      rows and results (claimTieOracle.legacyTrust), and the result must still hash to the unchanged 2c17feee
 *      baseline — every other byte is held exactly as before, and the oracle's fidelity is proven by the hash;
 *   2. the candidate's trust summary must exactly equal the independent claim-tie reference
 *      (claimTieOracle.claimTieReference), with attributionRule === "claim_tie_no_majority_credit_v1";
 *   3. it must not be more favourable than the oracle: per slot, overall, or grounding level.
 * Every other case is compared exactly as before, and must carry no attributionRule. builderHashes.json is never
 * re-captured.
 */
jest.mock("@/lib/env", () => ({ ADAPTIVE_VERIFICATION_ENABLED: true, GEMINI_API_KEY: "k" }));
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const connectorMap: Record<string, jest.Mock> = {};
jest.mock("@/lib/connectors", () => ({ CONNECTOR_MAP: connectorMap }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { callGemini } from "@/lib/connectors/gemini";
import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import { CLASSIFICATION_BASE, DEFAULT_MODE, MockMode, SCENARIOS, SEEDED_SCHEMAS, SEEDS, geminiMockImpl, seededResults } from "./o5pScenarios";
import { GROUNDING_RANK, claimTieReference, groundingTier, legacyTrust, oracleIsEligibleClaimTie } from "../o5c/claimTieOracle";

const gem = callGemini as unknown as jest.Mock;
const baseline: Record<string, { schemaId: string; result: string; geminiCalls: string; connectorCalls: string; geminiCallCount: number; inputMutated: boolean }> = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "baseline-2c17fee", "builderHashes.json"), "utf8")
);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** Sorted-key JSON, the canonical form the 2c17feee hashes were taken over. */
const canon = (x: any): string =>
  Array.isArray(x)
    ? `[${x.map(canon).join(",")}]`
    : x && typeof x === "object"
      ? `{${Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(x[k])}`).join(",")}}`
      : JSON.stringify(x);
const MARKER = "disagreementPositionVersion";

async function run(schemaId: string, input: any[], mode: MockMode, retry?: { modelId: string; data: unknown }[]) {
  gem.mockReset();
  gem.mockImplementation(geminiMockImpl(mode));
  for (const k of Object.keys(connectorMap)) delete connectorMap[k];
  for (const r of retry ?? []) connectorMap[r.modelId] = jest.fn(async () => ({ modelId: r.modelId, status: "ok", rawText: JSON.stringify(r.data), latencyMs: 5, tokenUsage: { totalTokens: 9, promptTokens: 5, completionTokens: 4 } }));
  const before = JSON.stringify(input);
  const retryContext = retry
    ? { apiKeys: {}, promptOverrides: Object.fromEntries(input.map((r) => [r.modelId, "BASE PROMPT"])), context: null, budget: { startedAtMonoMs: 0, budgetMs: 300_000 }, usageSink: new AdaptiveRetryUsageSink(), now: () => 1_000 }
    : undefined;
  const res: any = await finalizeAdaptiveRun(getResultSchema(schemaId as any), input, "Does raising the minimum wage reduce employment?", retryContext as any, { ...CLASSIFICATION_BASE, queryType: schemaId, answerShape: getResultSchema(schemaId as any).renderHint } as any);
  return {
    res,
    geminiCalls: gem.mock.calls.map((c: any[]) => [c[0], c[3]?.systemPromptOverride ?? null, c[3]?.maxOutputTokens ?? null]),
    connectorCalls: Object.fromEntries(Object.entries(connectorMap).map(([k, m]) => [k, m.mock.calls.map((c: any[]) => [c[0], c[1], c[3]?.systemPromptOverride ?? null])])),
    inputMutated: JSON.stringify(input) !== before,
  };
}

/** The result as compared: JSON form, persisted timestamp normalized, the permitted marker removed (and counted). */
function comparable(res: any): { value: any; markers: number[] } {
  const value = JSON.parse(JSON.stringify(res));
  const markers: number[] = [];
  if (value?.persistedLegacyOutput?.generatedAt) value.persistedLegacyOutput.generatedAt = "<normalized>";
  for (const p of [value?.synthesisReport?.presentation, value?.persistedLegacyOutput?.synthesisReport?.presentation]) {
    if (p && MARKER in p) {
      markers.push(p[MARKER]);
      delete p[MARKER];
    }
  }
  return { value, markers };
}

const CASES: { name: string; schemaId: string; input: () => any[]; mode: MockMode; retry?: { modelId: string; data: unknown }[] }[] = [
  ...SCENARIOS.map((s) => ({ name: s.name, schemaId: s.schemaId, input: s.results, mode: { ...DEFAULT_MODE, ...(s.mode ?? {}) }, retry: s.retry })),
  ...SEEDED_SCHEMAS.flatMap((schemaId) => SEEDS.map((seed) => ({ name: `seeded:${schemaId}:${seed}`, schemaId, input: () => seededResults(schemaId, seed), mode: DEFAULT_MODE }))),
];

describe("Contract P builder purity vs the 2c17feee pipeline", () => {
  it("covers every baseline case", () => {
    expect(CASES.map((c) => c.name).sort()).toEqual(Object.keys(baseline).sort());
  });

  it.each(CASES.map((c) => c.name))("%s: zero computed delta outside the presentation marker", async (name) => {
    const c = CASES.find((x) => x.name === name)!;
    const b = baseline[name];
    const out = await run(c.schemaId, c.input(), c.mode, c.retry);
    const { value, markers } = comparable(out.res);
    const rows = out.res.alignedClaims ?? [];
    const results = out.res.adaptiveResults ?? [];
    const claimTie = rows.some((r: any) => oracleIsEligibleClaimTie(r, results));
    if (!claimTie) {
      expect(sha(canon(value))).toBe(b.result);
      expect(JSON.stringify(value)).not.toContain("attributionRule");
    } else {
      const schema = getResultSchema(c.schemaId as any) as any;
      const oracle = JSON.parse(JSON.stringify(legacyTrust(schema, results, rows)));
      const { ties: _ties, ...reference } = claimTieReference(schema, results, rows);
      const copies = [value, value?.persistedLegacyOutput].filter((v) => v && v.trustSummary);
      expect(copies.length).toBeGreaterThan(0);
      for (const holder of copies) {
        const candidate = holder.trustSummary;
        expect(candidate.attributionRule).toBe("claim_tie_no_majority_credit_v1");
        const { attributionRule: _rule, ...candidateValues } = candidate;
        expect(candidateValues).toEqual(JSON.parse(JSON.stringify(reference)));
        const byId = new Map(oracle.perModel.map((m: any) => [m.modelId, m]));
        for (const m of candidate.perModel) {
          const o: any = byId.get(m.modelId);
          expect(m.trustScore).toBeLessThanOrEqual(o.trustScore + 1e-12);
          expect(m.capped && !o.capped).toBe(false);
        }
        expect(candidate.overallTrust).toBeLessThanOrEqual(oracle.overallTrust + 1e-12);
        expect(GROUNDING_RANK[groundingTier(candidate.overallTrust)]).toBeLessThanOrEqual(GROUNDING_RANK[groundingTier(oracle.overallTrust)]);
        holder.trustSummary = oracle;
      }
      expect(sha(canon(value))).toBe(b.result);
    }
    // The marker is the number 1, on the live report and its persisted copy, exactly when the builder produced a
    // presentation over at least one row; nowhere else.
    const eligible = !!out.res.synthesisReport?.presentation && (out.res.alignedClaims?.length ?? 0) > 0;
    const copies = [out.res.synthesisReport, out.res.persistedLegacyOutput?.synthesisReport].filter(Boolean).length;
    expect(markers).toEqual(eligible ? Array(copies).fill(1) : []);
    expect(JSON.stringify(value)).not.toContain(MARKER);
    expect(out.geminiCalls.length).toBe(b.geminiCallCount);
    expect(sha(canon(out.geminiCalls))).toBe(b.geminiCalls);
    expect(sha(canon(out.connectorCalls))).toBe(b.connectorCalls);
    expect(out.inputMutated).toBe(false);
    expect(b.inputMutated).toBe(false);
  });
});

describe("marker eligibility at the real builder placement", () => {
  it("a report built over zero rows is not marked; over one row it is, with every other presentation field unchanged", async () => {
    gem.mockReset();
    gem.mockImplementation(geminiMockImpl(DEFAULT_MODE));
    const results = [{ modelId: "chatgpt", status: "ok", rawText: "{}", latencyMs: 1 }, { modelId: "claude", status: "ok", rawText: "{}", latencyMs: 1 }] as any[];
    const empty = await buildAdaptiveSynthesisReport("Q?", "generic", [], results);
    expect(empty.presentation).toBeDefined();
    expect(MARKER in (empty.presentation as object)).toBe(false);
    const row = { id: "r", claimText: "C", cells: [{ modelId: "chatgpt", stance: "agrees", rawStance: "asserts", confidence: "settled", origin: { kind: "claim", field: null, fieldClass: "unclassified" }, excerpt: "e" }, null], agreementScore: 1, certaintyScore: 1, status: "single_source" } as any;
    const one = await buildAdaptiveSynthesisReport("Q?", "generic", [row], results);
    expect((one.presentation as any)[MARKER]).toBe(1);
  });
});
