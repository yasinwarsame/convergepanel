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
import { HEURISTIC_RULES, heuristicClassify, sensitiveTopic } from "@/lib/adaptiveSchema/heuristicClassifier";
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
    // Ruling A: a business decision is never routed to Decision Support by the fallback.
    "Should our company expand into Kenya?",
    "Should I stop taking my insulin?",
    "Is it legal to break my lease early?",
    // Review MINOR-2: incidental "comparing"/"compare" and past years are not comparisons or forecasts.
    "Write a poem comparing love and war",
    "Is this video real? compare frames",
    "Is the claim that inflation fell true? Compare sources",
    "What happened to the economy by 2020?",
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

  it("the first matching rule wins (order pinned): a comparison that asks about risks is a comparison", () => {
    expect(heuristicClassify("Compare the risks of vendors A and B")?.ruleId).toBe("comparison");
  });

  it.each([
    ["How should I invest my retirement savings?", "procedure"],
    ["Compare the side effects of two blood-pressure medications", "comparison"],
    ["What are the risks of stopping insulin?", "risks_or_tradeoffs"],
    ["What caused my symptoms to get worse?", "causal"],
  ])("Ruling A: a sensitive question that WOULD match the %s rule is never routed by it", (q, wouldMatch) => {
    // Precondition: without the sensitivity guard this question matches a rule, so the guard is what keeps it generic.
    expect(HEURISTIC_RULES.find((r) => r.id === wouldMatch)!.test(q)).toBe(true);
    expect(heuristicClassify(q)).toBeNull();
  });

  it.each([
    "What are the risks of taking ibuprofen every day?",
    "top 5 pills for depression",
    "Why does my chest hurt when I breathe?",
    "Bitcoin vs Ethereum",
    "How do I bring down a fever fast?",
    "How do I file for divorce?",
    "How do I get custody of my kids?",
    "How do I stop an eviction?",
    "How can I get out of debt?",
    "How do I lower my blood pressure?",
  ])("review R2 MINOR-B: an everyday sensitive question is never routed by a rule: %j", (q) => {
    expect(sensitiveTopic(q)).not.toBeNull();
    expect(heuristicClassify(q)).toBeNull();
  });

  it.each([
    "How do I diagnose a memory leak in Node?",
    "Compare smart contracts on Solana and Ethereum",
    "How do I resurface a basketball court?",
    "How do I integrate the Visa API?",
    "What did Sue say about the roadmap?",
  ])("review R2 NIT-1: an ordinary question is not flagged sensitive by an ambiguous word: %j", (q) => {
    if (q.includes("Ethereum")) {
      // Ethereum is a finance term on purpose; the point here is that "contracts" alone no longer flags.
      expect(sensitiveTopic("Compare smart contracts on Solana and Cardano")).toBeNull();
    } else {
      expect(sensitiveTopic(q)).toBeNull();
    }
  });

  it("Ruling A: no rule can ever choose decision_support", () => {
    expect(HEURISTIC_RULES.map((r) => r.queryType)).not.toContain("decision_support");
    for (const q of ["Should our company expand into Kenya?", "Should we hire a CFO?", "Is it worth refinancing now?", "Would it be wise to sell?"]) {
      expect([q, heuristicClassify(q)?.queryType ?? null]).not.toEqual([q, "decision_support"]);
    }
  });

  it("a future-year horizon is a forecast, a past one is not; 'top N' carries its count", () => {
    const next = new Date().getUTCFullYear() + 5;
    expect(heuristicClassify(`What will EV adoption look like by ${next}?`)?.queryType).toBe("forecast_speculative");
    expect(heuristicClassify("What did EV adoption look like by 2019?")).toBeNull();
    expect(heuristicClassify("What are the top 5 CRM tools for small businesses?")).toEqual({ queryType: "ranked_enumeration", ruleId: "ranking", requestedCount: 5 });
  });

  it.each([
    ["Should I stop taking my insulin?", "high_stakes"],
    ["Is it legal to break my lease early?", "high_stakes"],
    ["How should I invest my retirement savings?", "high_stakes"],
    ["I keep thinking about suicide, what should I do?", "safety_critical"],
    ["Compare GPT, Claude and Gemini", null],
  ])("sensitiveTopic(%j) → %s", (q, want) => {
    expect(sensitiveTopic(q)).toBe(want);
  });
});

describe("classifyQuery: the heuristic runs only when classification could not complete", () => {
  it("provider error (the Production 402 shape) → heuristic answer type, marked as a fallback, routable to an active schema", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq("What caused the 2008 financial crisis?"));
    expect(c.queryType).toBe("causal_explanation");
    expect(c.answerShape).toBe(SCHEMA_REGISTRY.causal_explanation.renderHint);
    expect(c.classificationSource).toBe("heuristic");
    expect(c.heuristicRule).toBe("causal");
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
    const q = uniq("Compare GPT, Claude and Gemini");
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

describe("Ruling A: sensitive questions stay generic WITH their risk signal; a fallback never starts Decision Support", () => {
  it("medical question after a provider failure → generic, riskLevel high_stakes, marked as a fallback, never downgraded to 'professional'", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq("Should I stop taking my insulin?"));
    expect(c.queryType).toBe("generic");
    expect(c.riskLevel).toBe("high_stakes");
    expect(c.evidenceRequirement).toBe("high");
    expect(c.classificationSource).toBe("heuristic");
    expect(c.heuristicRule).toBe("sensitive_topic");
    expect(c.fallbackReason).toBe("connector_error");
    expect(routeClassifiedQuery(c).kind).toBe("active");
  });

  it("acute danger → safety_critical", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    expect((await classifyQuery(uniq("I am thinking about an overdose"))).riskLevel).toBe("safety_critical");
  });

  it("a non-sensitive unmatched question keeps the default generic fallback (no heuristic marker, riskLevel unchanged)", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq("Tell me about the Roman Empire"));
    expect([c.queryType, c.riskLevel, c.classificationSource]).toEqual(["generic", "professional", undefined]);
  });

  it("a VALIDATED model classification may still choose decision_support through its established path (the restriction is fallback-only)", async () => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "decision_support", answerShape: "decision_support_view", confidence: 0.9 })));
    const c = await classifyQuery(uniq("Should our company expand into Kenya?"));
    expect([c.queryType, c.classificationSource]).toEqual(["decision_support", undefined]);
  });
});
