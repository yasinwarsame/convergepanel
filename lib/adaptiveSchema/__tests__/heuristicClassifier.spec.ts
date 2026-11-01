/**
 * D-2 (shared Adaptive Schema architecture, 2026-11-02): classification resilience.
 *
 * Pinned here:
 *   1. The deterministic fallback maps the owner's example questions to the EXISTING answer types, and leaves
 *      ambiguous questions generic (precision over recall).
 *   2. It runs only when the model classifier could not complete. It is marked as a fallback, never as verified,
 *      and its output passes routing as an active registry schema.
 *   3. Failure fallbacks are never cached: a recovered provider is asked again. A real classification and a
 *      low-confidence verdict are still cached.
 *   4. A low-confidence model verdict stays generic (the heuristic never overrides the model's own judgement).
 */
import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import { HEURISTIC_RULES, heuristicClassify } from "@/lib/adaptiveSchema/heuristicClassifier";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";

/** The Production failure shape: the connector reports an error (Gemini answered HTTP 402). */
const providerError = { modelId: "gemini" as const, status: "error" as const, rawText: "Gemini request failed. Please try again.", errorMessage: "x", latencyMs: 200 };
const ok = (rawText: string) => ({ modelId: "gemini" as const, status: "ok" as const, rawText, latencyMs: 10 });
const modelAnswer = (o: Record<string, unknown>) =>
  JSON.stringify({ domain: "d", quantExpected: false, timeSensitivity: "low", userIntent: "get_answer", riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless", inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, clarificationQuestion: null, rationale: "r", ...o });

let n = 0;
/** A distinct query per call, so the module-level LRU never couples tests. */
const uniq = (q: string) => `${q} [t${++n}]`;

afterEach(() => jest.clearAllMocks());

describe("heuristicClassify: the owner's example questions map to existing answer types", () => {
  it.each([
    ["Will AI eliminate more jobs than it creates in the next 10 years?", "forecast_speculative"],
    ["Will AI eliminate more jobs than it creates?", "forecast_speculative"],
    ["Should our company expand into Kenya?", "decision_support"],
    ["Compare GPT, Claude and Gemini", "comparison_matrix"],
    ["What caused inflation to rise?", "causal_explanation"],
    ["What are the risks of adopting AI agents?", "checklist_taxonomy"],
    ["How do I migrate a Postgres database to a new region?", "procedural"],
    ["What are the top 5 CRM tools for small businesses?", "ranked_enumeration"],
    ["Define regulatory capture", "definition_explanation"],
    ["GPT vs. Claude for coding", "comparison_matrix"],
  ])("%s → %s", (q, want) => {
    expect(heuristicClassify(q)?.queryType).toBe(want);
  });

  it.each([
    "Will this code compile?",
    "Will you help me write an email?",
    "What is the capital of France?",
    "Tell me about the Roman Empire",
    "",
    "   ",
  ])("ambiguous or unmatched → null (keep generic): %j", (q) => {
    expect(heuristicClassify(q)).toBeNull();
  });

  it("every rule targets an ACTIVE, executing registry schema: never a handoff, limitation or disabled type", () => {
    for (const rule of HEURISTIC_RULES) {
      const entry = SCHEMA_REGISTRY[rule.queryType];
      expect([rule.id, entry?.implementationStatus]).toEqual([rule.id, "active"]);
      expect(rule.queryType).not.toBe("graceful_limitation");
      expect(rule.queryType).not.toBe("generic");
    }
    expect(new Set(HEURISTIC_RULES.map((r) => r.id)).size).toBe(HEURISTIC_RULES.length);
  });

  it("the first matching rule wins (order pinned): a 'should we compare' question is a comparison", () => {
    expect(heuristicClassify("Should we compare vendors A and B?")?.ruleId).toBe("comparison");
  });
});

describe("classifyQuery: the heuristic runs only when classification could not complete", () => {
  it("provider error (the Production 402 shape) → heuristic answer type, marked as a fallback, routable to an active schema", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq("Should our company expand into Kenya?"));
    expect(c.queryType).toBe("decision_support");
    expect(c.answerShape).toBe(SCHEMA_REGISTRY.decision_support.renderHint);
    expect(c.classificationSource).toBe("heuristic");
    expect(c.heuristicRule).toBe("decision");
    expect(c.fallbackReason).toBe("connector_error");
    expect(c.confidence).toBe(0.4);
    expect(c.rationale).toMatch(/not a model classification/);
    const routed = routeClassifiedQuery(c);
    expect(routed.kind).toBe("active");
  });

  it.each([
    ["malformed JSON", () => ok("not json"), "malformed_json"],
    ["schema-invalid answer", () => ok(JSON.stringify({ queryType: "nonsense" })), "schema_invalid"],
  ])("%s → heuristic with that reason", async (_l, impl, reason) => {
    mockedCallGemini.mockResolvedValue(impl() as never);
    const c = await classifyQuery(uniq("What caused inflation to rise?"));
    expect([c.queryType, c.classificationSource, c.fallbackReason]).toEqual(["causal_explanation", "heuristic", reason]);
  });

  it("timeout → heuristic, reason timeout", async () => {
    jest.useFakeTimers();
    try {
      mockedCallGemini.mockImplementation(() => new Promise(() => {}));
      const p = classifyQuery(uniq("Compare GPT, Claude and Gemini"));
      await jest.advanceTimersByTimeAsync(9000);
      const c = await p;
      expect([c.queryType, c.classificationSource, c.fallbackReason]).toEqual(["comparison_matrix", "heuristic", "timeout"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("an unmatched question after a provider error stays generic: no heuristic marker, the default fallback", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq("Tell me about the Roman Empire"));
    expect(c.queryType).toBe("generic");
    expect(c.classificationSource).toBeUndefined();
    expect(c.fallbackReason).toBe("connector_error");
  });

  it("a successful model classification carries no heuristic marker and is used as-is", async () => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "comparison_matrix", answerShape: "comparison_grid", confidence: 0.95 })));
    const c = await classifyQuery(uniq("Should our company expand into Kenya?"));
    expect(c.queryType).toBe("comparison_matrix"); // the model's verdict wins over any rule
    expect(c.classificationSource).toBeUndefined();
    expect(c.fallbackReason).toBeUndefined();
  });

  it("a low-confidence model verdict stays generic: the heuristic never overrides the model's own judgement", async () => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "decision_support", answerShape: "decision_support_view", confidence: 0.2 })));
    const c = await classifyQuery(uniq("Should our company expand into Kenya?"));
    expect(c.queryType).toBe("generic");
    expect(c.fallbackReason).toBe("low_confidence");
    expect(c.classificationSource).toBeUndefined();
  });
});

describe("classifyQuery: failure fallbacks are never cached", () => {
  it("after a provider error, the next request for the same question asks the provider again, and a recovery is used", async () => {
    const q = uniq("Should our company expand into Kenya?");
    mockedCallGemini.mockResolvedValueOnce(providerError);
    const first = await classifyQuery(q);
    expect(first.classificationSource).toBe("heuristic");
    mockedCallGemini.mockResolvedValueOnce(ok(modelAnswer({ queryType: "decision_support", answerShape: "decision_support_view", confidence: 0.9 })));
    const second = await classifyQuery(q);
    expect(mockedCallGemini).toHaveBeenCalledTimes(2);
    expect(second.queryType).toBe("decision_support");
    expect(second.classificationSource).toBeUndefined();
  });

  it.each([
    ["malformed JSON", () => ok("not json")],
    ["schema-invalid answer", () => ok(JSON.stringify({ queryType: "nonsense" }))],
  ])("%s is not cached either", async (_l, impl) => {
    const q = uniq("What caused inflation to rise?");
    mockedCallGemini.mockResolvedValue(impl() as never);
    await classifyQuery(q);
    await classifyQuery(q);
    expect(mockedCallGemini).toHaveBeenCalledTimes(2);
  });

  it("a real classification is still cached (unchanged)", async () => {
    const q = uniq("Compare GPT, Claude and Gemini");
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "comparison_matrix", answerShape: "comparison_grid", confidence: 0.9 })));
    await classifyQuery(q);
    await classifyQuery(q);
    expect(mockedCallGemini).toHaveBeenCalledTimes(1);
  });
});
