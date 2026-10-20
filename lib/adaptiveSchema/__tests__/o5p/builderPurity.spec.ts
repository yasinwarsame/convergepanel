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
import { getResultSchema } from "@/lib/adaptiveSchema/schemaRegistry";
import { AdaptiveRetryUsageSink } from "@/lib/adaptiveSchema/retryCorrection";
import { CLASSIFICATION_BASE, DEFAULT_MODE, MockMode, SCENARIOS, SEEDED_SCHEMAS, SEEDS, geminiMockImpl, seededResults } from "./o5pScenarios";

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
    expect(sha(canon(value))).toBe(b.result);
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
