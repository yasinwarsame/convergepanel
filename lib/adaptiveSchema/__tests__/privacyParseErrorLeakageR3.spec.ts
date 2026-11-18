/**
 * Privacy remediation R3 (review MAJOR-1) — adaptive-schema LLM call sites log
 * no model text when the model's output is not JSON or the call throws.
 *
 * Mechanism under test: `JSON.parse(stripJsonFences(result.rawText))` inside a
 * try, `logger.warn(..., { error: err?.message })` in the catch. V8's
 * SyntaxError message quotes the first ~10 characters of the text it failed
 * on, so a model reply beginning `SENTINELMO…` logged `"SENTINELMO"...`.
 * Two inputs per site: (a) a non-JSON model reply, (b) a thrown SyntaxError
 * carrying the excerpt. Every console method is spied (the shared logger
 * writes through console). Synthetic data only.
 */
const SENTINEL = "SENTINELMO";
const MODEL_REPLY = `${SENTINEL} the panel agrees the moon is hollow — not JSON`;

const mockCallGemini = jest.fn();
jest.mock("@/lib/connectors/gemini", () => ({ callGemini: (...a: unknown[]) => mockCallGemini(...a) }));

import { detectAdaptiveBiases } from "@/lib/adaptiveSchema/biasDetection";
import { auditPanelCoverage } from "@/lib/adaptiveSchema/coverageAudit";
import { alignClaims, type ModelClaims } from "@/lib/adaptiveSchema/alignment";
import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import type { Claim } from "@/lib/adaptiveSchema/types";

let spies: jest.SpyInstance[];
beforeEach(() => {
  mockCallGemini.mockReset();
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
});
afterEach(() => jest.restoreAllMocks());
const logged = () => JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map((a: unknown) => (a instanceof Error ? `${a.name}: ${a.message}` : a)))));

const okReply = async () => ({ modelId: "gemini", status: "ok", rawText: MODEL_REPLY, latencyMs: 1 });
const throwSyntax = async () => {
  try {
    JSON.parse(MODEL_REPLY);
  } catch (e) {
    throw e; // the real V8 SyntaxError, message quotes the excerpt
  }
  throw new Error("unreachable");
};
const MODES: Array<[string, () => Promise<unknown>]> = [
  ["non-JSON model reply", okReply],
  ["thrown SyntaxError", throwSyntax],
];

const claim = (id: string, text: string): Claim => ({ id, claim: text, stance: "asserts", confidence: "settled", evidenceType: "empirical" } as Claim);
const results = [
  { modelId: "chatgpt", status: "ok", rawText: "A long enough answer about tides and the moon for the panel.", latencyMs: 1 },
  { modelId: "claude", status: "ok", rawText: "Another long enough answer about tides and the moon for the panel.", latencyMs: 1 },
] as any[];

describe.each(MODES)("MAJOR-1 sites — %s", (_label, impl) => {
  beforeEach(() => mockCallGemini.mockImplementation(impl));

  it("biasDetection.ts: no model text in logs (control: the fallback is logged)", async () => {
    await detectAdaptiveBiases("Q", "generic" as any, results, ["chatgpt", "claude"] as any);
    expect(logged()).not.toContain(SENTINEL);
    expect(logged()).toMatch(/Bias detection/);
  });

  it("coverageAudit.ts: no model text in logs", async () => {
    await auditPanelCoverage("Q", "generic" as any, ["consensus-claim"]);
    expect(logged()).not.toContain(SENTINEL);
    expect(logged()).toMatch(/Coverage audit/);
  });

  it("alignment.ts (cluster + stance backfill): no model text in logs", async () => {
    const perModel: ModelClaims[] = [
      { modelId: "chatgpt", claims: [claim("tides-moon", "Tides are caused by the moon.")] } as any,
      { modelId: "claude", claims: [claim("lunar-tides", "The moon drives ocean tides.")] } as any,
      { modelId: "gemini", claims: [claim("wind-farms", "Wind farms cause tides.")] } as any,
    ];
    await alignClaims(perModel);
    expect(logged()).not.toContain(SENTINEL);
  });

  it("classifier.ts: no model text in logs", async () => {
    await classifyQuery("Are tides caused by the moon?");
    expect(logged()).not.toContain(SENTINEL);
  });

  it("synthesisReport.ts (narrative + regenerate): no model text in logs", async () => {
    await buildAdaptiveSynthesisReport("Q", "generic" as any, [], results);
    expect(logged()).not.toContain(SENTINEL);
  });
});
