/**
 * D-2 + owner final ruling (2026-11-02, PR #275 closeout): classification resilience with conservative fallback.
 *
 * Pinned here:
 *   1. The fallback runs only when the model classifier could not complete. It may select ONLY Forecast or Generic,
 *      is marked as a fallback (never as verified) and routes as an active registry schema.
 *   2. Every fallback target is presentation-only: a legacy-active schema, never Milestone-2. A Milestone-2 envelope
 *      creates governance records, receipts and Team review, which is why Comparison falls back to Generic.
 *   3. Sensitive questions stay generic with their independent risk flag preserved, never suppressed.
 *   4. Failure fallbacks are never cached; validated classifications and low-confidence verdicts are cached as before.
 *   5. A validated model classification is unchanged, Decision Support included.
 */
import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import { HEURISTIC_RULES, heuristicClassify, sensitiveTopic } from "@/lib/adaptiveSchema/heuristicClassifier";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { SCHEMA_ANSWER_SHAPE, isPersistedLegacyAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";

/** The Production failure shape: the connector reports an error (Gemini answered HTTP 402). */
const providerError = { modelId: "gemini" as const, status: "error" as const, rawText: "Gemini request failed. Please try again.", errorMessage: "x", latencyMs: 200 };
const ok = (rawText: string) => ({ modelId: "gemini" as const, status: "ok" as const, rawText, latencyMs: 10 });
const modelAnswer = (o: Record<string, unknown>) =>
  JSON.stringify({ domain: "d", quantExpected: false, timeSensitivity: "low", userIntent: "get_answer", riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless", inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, clarificationQuestion: null, rationale: "r", ...o });

let n = 0;
/** A distinct query per call, so the module-level LRU never couples tests. */
const uniq = (q: string) => `${q} [t${++n}]`;
const FORECAST_Q = "Will AI eliminate more jobs than it creates in the next 10 years?";

afterEach(() => jest.clearAllMocks());

describe("final fallback boundaries: Forecast or Generic only", () => {
  it("the only rule is forecast; every target is presentation-only (legacy-active, never Milestone-2)", () => {
    expect(HEURISTIC_RULES.map((r) => [r.id, r.queryType])).toEqual([["forecast", "forecast_speculative"]]);
    for (const rule of HEURISTIC_RULES) {
      expect(SCHEMA_REGISTRY[rule.queryType].implementationStatus).toBe("active");
      expect(isPersistedLegacyAdaptiveSchemaId(rule.queryType)).toBe(true);
      expect(Object.keys(SCHEMA_ANSWER_SHAPE)).not.toContain(rule.queryType);
    }
  });

  it.each([
    [FORECAST_Q, "forecast_speculative"],
    ["Will AI eliminate more jobs than it creates?", "forecast_speculative"],
    [`What will EV adoption look like by ${new Date().getUTCFullYear() + 5}?`, "forecast_speculative"],
    ["Give me a forecast of global solar capacity", "forecast_speculative"],
  ])("clear forecast → forecast: %j", (q, want) => {
    expect(heuristicClassify(q)?.queryType).toBe(want);
  });

  it.each([
    // Clear comparisons: Milestone-2 governance side effects, so Generic (owner constraint).
    "Compare GPT, Claude and Gemini",
    "GPT vs. Claude for coding",
    "What are the differences between REST and GraphQL?",
    // Procedure / causal / risks / ranking / definition / decision shapes.
    "How do I migrate a Postgres database to a new region?",
    "Why does my build fail on CI?",
    "What caused inflation to rise?",
    "What are the risks of adopting AI agents?",
    "What are the top 5 CRM tools for small businesses?",
    "Define regulatory capture",
    "Should our company expand into Kenya?",
    // Ambiguous or unmatched.
    "Will this code compile?",
    "Will you help me write an email?",
    "What happened to the economy by 2019?",
    "Tell me about the Roman Empire",
    "",
  ])("everything else → generic (null): %j", (q) => {
    expect(heuristicClassify(q)).toBeNull();
  });

  it.each([
    // Health, legal and financial questions WITHOUT any listed keyword: generic by construction (no rule matches).
    "Why do I feel dizzy every time I stand up?",
    "How do I tell if my mole is getting worse?",
    "Can my employer fire me for posting online?",
    "How do I get out from under what I owe my brother?",
    "How do I make it stop hurting?",
  ])("an unlisted sensitive question still ends up generic, because no specialised rule exists for it: %j", (q) => {
    expect(heuristicClassify(q)).toBeNull();
  });

  it.each([
    "Will my insulin dose increase in the next 5 years?",
    "Will mortgage rates rise in the next 2 years?",
  ])("a sensitive forecast is kept generic by the risk guard: %j", (q) => {
    // Precondition: the forecast rule alone would match, so the guard is what keeps it generic.
    expect(HEURISTIC_RULES[0].test(q)).toBe(true);
    expect(sensitiveTopic(q)).not.toBeNull();
    expect(heuristicClassify(q)).toBeNull();
  });
});

describe("independent risk flags (sensitiveTopic) are preserved, not suppressed", () => {
  it.each([
    ["How do I hurt myself without anyone noticing?", "safety_critical"],
    ["I want to end my life", "safety_critical"],
    ["I don't want to live anymore", "safety_critical"],
    ["I keep thinking about suicide, what should I do?", "safety_critical"],
    ["Should I stop taking my insulin?", "high_stakes"],
    ["Is it legal to break my lease early?", "high_stakes"],
    ["How should I invest my retirement savings?", "high_stakes"],
    ["Compare GPT, Claude and Gemini", null],
  ])("sensitiveTopic(%j) → %s", (q, want) => {
    expect(sensitiveTopic(q)).toBe(want);
  });

  it.each([
    "How do I diagnose a memory leak in Node?",
    "Compare smart contracts on Solana and Cardano",
    "How do I resurface a basketball court?",
    "How do I integrate the Visa API?",
    "What did Sue say about the roadmap?",
    "How do I configure Kubernetes health checks?",
    "How do I pay down technical debt in a legacy codebase?",
  ])("an ambiguous word alone does not raise a risk flag: %j", (q) => {
    expect(sensitiveTopic(q)).toBeNull();
  });
});

describe("classifyQuery: the fallback runs only when classification could not complete", () => {
  it("provider error (the Production 402 shape) on a clear forecast → forecast, marked as a fallback, routable", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq(FORECAST_Q));
    expect([c.queryType, c.answerShape, c.classificationSource, c.heuristicRule, c.fallbackReason, c.confidence]).toEqual([
      "forecast_speculative",
      SCHEMA_REGISTRY.forecast_speculative.renderHint,
      "heuristic",
      "forecast",
      "connector_error",
      0.4,
    ]);
    expect(c.rationale).toMatch(/not a model classification/);
    expect(routeClassifiedQuery(c).kind).toBe("active");
  });

  it.each([
    ["a clear comparison", "Compare GPT, Claude and Gemini"],
    ["a procedure", "How do I migrate a Postgres database?"],
    ["a causal question", "Why does my build fail on CI?"],
    ["a business decision", "Should our company expand into Kenya?"],
  ])("provider error on %s → the default generic fallback (no heuristic marker)", async (_l, q) => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq(q));
    expect([c.queryType, c.classificationSource, c.fallbackReason, c.riskLevel]).toEqual(["generic", undefined, "connector_error", "professional"]);
  });

  it.each([
    ["malformed JSON", () => ok("not json"), "malformed_json"],
    ["schema-invalid answer", () => ok(JSON.stringify({ queryType: "nonsense" })), "schema_invalid"],
  ])("%s → heuristic forecast with that reason", async (_l, impl, reason) => {
    mockedCallGemini.mockResolvedValue(impl() as never);
    const c = await classifyQuery(uniq(FORECAST_Q));
    expect([c.queryType, c.classificationSource, c.fallbackReason]).toEqual(["forecast_speculative", "heuristic", reason]);
  });

  it("timeout → heuristic forecast, reason timeout", async () => {
    jest.useFakeTimers();
    try {
      mockedCallGemini.mockImplementation(() => new Promise(() => {}));
      const p = classifyQuery(uniq(FORECAST_Q));
      await jest.advanceTimersByTimeAsync(9000);
      const c = await p;
      expect([c.queryType, c.classificationSource, c.fallbackReason]).toEqual(["forecast_speculative", "heuristic", "timeout"]);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ["Should I stop taking my insulin?", "high_stakes"],
    ["I want to end my life", "safety_critical"],
  ])("sensitive question after a provider failure → generic with its risk flag kept: %j → %s", async (q, level) => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq(q));
    expect([c.queryType, c.riskLevel, c.evidenceRequirement, c.classificationSource, c.heuristicRule]).toEqual(["generic", level, "high", "heuristic", "sensitive_topic"]);
    expect(routeClassifiedQuery(c).kind).toBe("active");
  });

  it("a validated model classification is used as-is, including decision_support (the restriction is fallback-only)", async () => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "decision_support", answerShape: "decision_support_view", confidence: 0.9 })));
    const c = await classifyQuery(uniq("Should our company expand into Kenya?"));
    expect([c.queryType, c.classificationSource, c.fallbackReason]).toEqual(["decision_support", undefined, undefined]);
  });

  it("a validated comparison classification is unchanged too", async () => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "comparison_matrix", answerShape: "comparison_grid", confidence: 0.95 })));
    const c = await classifyQuery(uniq("Compare GPT, Claude and Gemini"));
    expect([c.queryType, c.classificationSource]).toEqual(["comparison_matrix", undefined]);
  });

  it("a low-confidence model verdict stays generic: the heuristic never overrides the model's own judgement", async () => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "forecast_speculative", answerShape: "scenario_tree", confidence: 0.2 })));
    const c = await classifyQuery(uniq(FORECAST_Q));
    expect([c.queryType, c.fallbackReason, c.classificationSource]).toEqual(["generic", "low_confidence", undefined]);
  });
});

describe("classifyQuery: failure fallbacks are never cached", () => {
  it("after a provider error, the next request for the same question asks the provider again, and a recovery is used", async () => {
    const q = uniq(FORECAST_Q);
    mockedCallGemini.mockResolvedValueOnce(providerError);
    expect((await classifyQuery(q)).classificationSource).toBe("heuristic");
    mockedCallGemini.mockResolvedValueOnce(ok(modelAnswer({ queryType: "forecast_speculative", answerShape: "scenario_tree", confidence: 0.9 })));
    const second = await classifyQuery(q);
    expect(mockedCallGemini).toHaveBeenCalledTimes(2);
    expect([second.queryType, second.classificationSource]).toEqual(["forecast_speculative", undefined]);
  });

  it.each([
    ["malformed JSON", () => ok("not json")],
    ["schema-invalid answer", () => ok(JSON.stringify({ queryType: "nonsense" }))],
  ])("%s is not cached either", async (_l, impl) => {
    const q = uniq(FORECAST_Q);
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
