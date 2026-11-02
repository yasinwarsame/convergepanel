/**
 * Owner final ruling, option A (2026-11-02): GENERIC-ONLY classifier fallback.
 *
 * Pinned here:
 *   A. Any classifier failure (connector error, i.e. the Production HTTP 402, timeout, malformed, schema-invalid) → Generic.
 *   B. Clear public forecasts are Generic during an outage too.
 *   C. Procedure, decision, comparison, health, legal, financial and first-person questions → Generic.
 *   E. The independent risk check keeps high_stakes / safety_critical. That is not proof of safety; unlisted questions
 *      keep the default level.
 *   F. A successful model classification still selects every one of the 18 executing answer types, unchanged.
 *   No routing machinery remains in the risk module, failure fallbacks are never cached, and real classifications are.
 */
import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({ callGemini: jest.fn() }));
const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { classifyQuery } from "@/lib/adaptiveSchema/classifier";
import * as riskModule from "@/lib/adaptiveSchema/heuristicClassifier";
import { sensitiveTopic } from "@/lib/adaptiveSchema/heuristicClassifier";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";

/** The Production failure shape: the connector reports an error (Gemini answered HTTP 402). */
const providerError = { modelId: "gemini" as const, status: "error" as const, rawText: "Gemini request failed. Please try again.", errorMessage: "x", latencyMs: 200 };
const ok = (rawText: string) => ({ modelId: "gemini" as const, status: "ok" as const, rawText, latencyMs: 10 });
const modelAnswer = (o: Record<string, unknown>) =>
  JSON.stringify({ domain: "d", quantExpected: false, timeSensitivity: "low", userIntent: "get_answer", riskLevel: "professional", evidenceRequirement: "medium", freshness: "timeless", inputType: "text", verificationMethod: "cross_model_consistency", requestedCount: null, requiresClarification: false, clarificationQuestion: null, rationale: "r", ...o });

let n = 0;
/** A distinct query per call, so the module-level LRU never couples tests. */
const uniq = (q: string) => `${q} (#${++n})`;
const FORECAST_Q = "Will AI eliminate more jobs than it creates in the next 10 years?";

/** Every way the classifier can fail to complete, as the fallback sees it. */
const FAILURES: [string, () => void, string][] = [
  ["connector error (Production HTTP 402)", () => mockedCallGemini.mockResolvedValue(providerError), "connector_error"],
  ["malformed JSON", () => mockedCallGemini.mockResolvedValue(ok("not json")), "malformed_json"],
  ["schema-invalid answer", () => mockedCallGemini.mockResolvedValue(ok(JSON.stringify({ queryType: "nonsense" }))), "schema_invalid"],
];

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe("A/B/C: every classifier failure falls back to Generic, whatever the question", () => {
  const QUESTIONS = [
    ["clear public forecast", FORECAST_Q],
    ["clear public forecast (horizon)", `What will EV adoption look like by ${new Date().getUTCFullYear() + 5}?`],
    ["clear comparison", "Compare GPT, Claude and Gemini"],
    ["procedure", "How do I forecast revenue?"],
    ["decision", "Should we raise prices by 2030?"],
    ["decision behind a quote", '"Should we expand into Kenya?"'],
    ["business decision", "Should our company expand into Kenya?"],
    ["health without listed keywords", "Will this tumor grow in the next 6 months?"],
    ["legal without listed keywords", "Can my employer fire me for posting online?"],
    ["financial without listed keywords", "Will house prices fall in the next 2 years?"],
    ["first-person", "Will my lump grow in the next 6 months?"],
    ["ambiguous", "Tell me about the Roman Empire"],
  ];

  describe.each(FAILURES)("%s", (_label, arrange, reason) => {
    it.each(QUESTIONS)("%s → generic", async (_kind, q) => {
      arrange();
      const c = await classifyQuery(uniq(q));
      expect([c.queryType, c.answerShape, c.fallbackReason]).toEqual(["generic", SCHEMA_REGISTRY.generic.renderHint, reason]);
      expect(routeClassifiedQuery(c).kind).toBe("active");
    });
  });

  it("timeout → generic (a clear forecast included)", async () => {
    jest.useFakeTimers();
    mockedCallGemini.mockImplementation(() => new Promise(() => {}));
    const p = classifyQuery(uniq(FORECAST_Q));
    await jest.advanceTimersByTimeAsync(9000);
    const c = await p;
    expect([c.queryType, c.fallbackReason]).toEqual(["generic", "timeout"]);
  });

  it("the risk module exports no answer-type selection machinery (no rules, no classify function)", () => {
    expect(Object.keys(riskModule).sort()).toEqual(["SENSITIVE", "sensitiveTopic"]);
  });
});

describe("E: independent risk flags are preserved on the generic fallback, and do not overclaim", () => {
  it.each([
    ["Should I stop taking my insulin?", "high_stakes"],
    ["Is it legal to break my lease early?", "high_stakes"],
    ["How should I invest my retirement savings?", "high_stakes"],
    ["I want to end my life", "safety_critical"],
    ["How do I hurt myself without anyone noticing?", "safety_critical"],
  ])("%j → generic with riskLevel %s, evidence high, the risk check recorded", async (q, level) => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq(q));
    expect([c.queryType, c.riskLevel, c.evidenceRequirement, c.classificationSource, c.heuristicRule, c.fallbackReason]).toEqual([
      "generic",
      level,
      "high",
      "heuristic",
      "sensitive_topic",
      "connector_error",
    ]);
    expect(c.rationale).toMatch(/not a model classification/);
  });

  it("an unlisted sensitive question keeps the DEFAULT level: generic is not presented as proof of safety", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    const c = await classifyQuery(uniq("Will this tumor grow in the next 6 months?"));
    expect([c.queryType, c.riskLevel, c.classificationSource, c.heuristicRule]).toEqual(["generic", "professional", undefined, undefined]);
  });

  it("not every fallback is high-stakes", async () => {
    mockedCallGemini.mockResolvedValue(providerError);
    expect((await classifyQuery(uniq(FORECAST_Q))).riskLevel).toBe("professional");
  });

  it.each(["How do I diagnose a memory leak in Node?", "How do I resurface a basketball court?", "How do I pay down technical debt in a legacy codebase?"])(
    "an ambiguous word alone does not raise a flag: %j",
    (q) => {
      expect(sensitiveTopic(q)).toBeNull();
    }
  );
});

describe("F: a successful model classification still selects every executing answer type, unchanged", () => {
  const EXECUTING = (Object.keys(SCHEMA_REGISTRY) as (keyof typeof SCHEMA_REGISTRY)[]).filter(
    (id) => SCHEMA_REGISTRY[id].implementationStatus === "active" && id !== "graceful_limitation"
  );
  it("covers all 18", () => expect(EXECUTING).toHaveLength(18));
  it.each(EXECUTING)("%s", async (id) => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: id, answerShape: SCHEMA_REGISTRY[id].renderHint, confidence: 0.9 })));
    const c = await classifyQuery(uniq(`question for ${id}`));
    expect([c.queryType, c.fallbackReason, c.classificationSource]).toEqual([id, undefined, undefined]);
  });

  it("a low-confidence model verdict stays generic (unchanged)", async () => {
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "forecast_speculative", answerShape: SCHEMA_REGISTRY.forecast_speculative.renderHint, confidence: 0.2 })));
    const c = await classifyQuery(uniq(FORECAST_Q));
    expect([c.queryType, c.fallbackReason]).toEqual(["generic", "low_confidence"]);
  });
});

describe("caching: failure fallbacks never cached; real classifications cached as before", () => {
  it("after a provider error the provider is asked again for the same question, and a recovery is used", async () => {
    const q = uniq(FORECAST_Q);
    mockedCallGemini.mockResolvedValueOnce(providerError);
    expect((await classifyQuery(q)).queryType).toBe("generic");
    mockedCallGemini.mockResolvedValueOnce(ok(modelAnswer({ queryType: "forecast_speculative", answerShape: SCHEMA_REGISTRY.forecast_speculative.renderHint, confidence: 0.9 })));
    expect((await classifyQuery(q)).queryType).toBe("forecast_speculative");
    expect(mockedCallGemini).toHaveBeenCalledTimes(2);
  });

  it("a real classification is still cached", async () => {
    const q = uniq("Compare GPT, Claude and Gemini");
    mockedCallGemini.mockResolvedValue(ok(modelAnswer({ queryType: "comparison_matrix", answerShape: "comparison_grid", confidence: 0.9 })));
    await classifyQuery(q);
    await classifyQuery(q);
    expect(mockedCallGemini).toHaveBeenCalledTimes(1);
  });
});
