/**
 * Query Classifier Tests
 *
 * Covers the fallback contract: classifyQuery() must never throw and must
 * always resolve to a QueryClassification, falling back to "generic" on
 * timeout, provider error, malformed JSON, or low self-reported confidence.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

// Import after mocking so classifier.ts picks up the mocked connector.
import { classifyQuery } from "@/lib/adaptiveSchema/classifier";

function okResult(rawText: string) {
  return { modelId: "gemini" as const, status: "ok" as const, rawText, latencyMs: 10 };
}

describe("classifyQuery", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("falls back to generic when the classifier call times out, and tags the fallback reason", async () => {
    jest.useFakeTimers();
    mockedCallGemini.mockImplementation(() => new Promise(() => {})); // never resolves

    const promise = classifyQuery("will this ever resolve in time?");
    await jest.advanceTimersByTimeAsync(8100);
    const result = await promise;

    expect(result.queryType).toBe("generic");
    expect(result.answerShape).toBe("generic_sections");
    expect(result.fallbackReason).toBe("timeout");
  });

  it("does NOT fall back when the classifier call is slow but resolves within the timeout budget", async () => {
    // Regression test: CLASSIFIER_TIMEOUT_MS was previously 3000ms — far
    // tighter than every other Gemini call in this module — and under
    // concurrent production load, real classifier latency exceeded that
    // budget, silently misclassifying legitimately contested_empirical
    // questions as "generic". Budget is now 8000ms; a 5s response must
    // still classify correctly.
    jest.useFakeTimers();
    mockedCallGemini.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve(
                okResult(
                  JSON.stringify({
                    queryType: "contested_empirical",
                    domain: "macroeconomics",
                    answerShape: "consensus_map",
                    quantExpected: false,
                    timeSensitivity: "low",
                    userIntent: "understand_debate",
                    confidence: 0.9,
                  })
                )
              ),
            5000
          );
        })
    );

    const promise = classifyQuery("slow but successful classifier call");
    await jest.advanceTimersByTimeAsync(5100);
    const result = await promise;

    expect(result.queryType).toBe("contested_empirical");
    expect(result.fallbackReason).toBeUndefined();
  });

  it("falls back to generic when confidence is below threshold, and tags the fallback reason", async () => {
    mockedCallGemini.mockResolvedValue(
      okResult(
        JSON.stringify({
          queryType: "financial_valuation",
          domain: "equities",
          answerShape: "metrics_grid",
          quantExpected: true,
          timeSensitivity: "medium",
          userIntent: "make_decision",
          confidence: 0.42,
        })
      )
    );

    const result = await classifyQuery("is this stock a buy? (low confidence case)");

    expect(result.queryType).toBe("generic");
    expect(result.confidence).toBe(0.42);
    expect(result.fallbackReason).toBe("low_confidence");
  });

  it("falls back to generic on malformed JSON, and tags the fallback reason", async () => {
    mockedCallGemini.mockResolvedValue(okResult("this is not json"));

    const result = await classifyQuery("malformed json case");

    expect(result.queryType).toBe("generic");
    expect(result.fallbackReason).toBe("malformed_json");
  });

  it("falls back to generic when the connector returns a non-ok status, and tags the fallback reason", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "error",
      rawText: null,
      errorMessage: "boom",
      latencyMs: 5,
    });

    const result = await classifyQuery("connector error case");

    expect(result.queryType).toBe("generic");
    expect(result.fallbackReason).toBe("connector_error");
  });

  it("classifies the reported regression question as contested_empirical (required case)", async () => {
    // Literal question from the reported bug: the classifier silently fell
    // through to "generic" for this exact question in production because
    // CLASSIFIER_TIMEOUT_MS (3000ms) was too tight under concurrent load.
    mockedCallGemini.mockResolvedValue(
      okResult(
        JSON.stringify({
          queryType: "contested_empirical",
          domain: "macroeconomics",
          answerShape: "consensus_map",
          quantExpected: false,
          timeSensitivity: "low",
          userIntent: "understand_debate",
          confidence: 0.93,
        })
      )
    );

    const result = await classifyQuery(
      "What are the main causes of inflation in the US, and where do economists disagree?"
    );

    expect(result.queryType).toBe("contested_empirical");
    expect(result.fallbackReason).toBeUndefined();
  });

  it("returns the classification for a valid, high-confidence response", async () => {
    mockedCallGemini.mockResolvedValue(
      okResult(
        JSON.stringify({
          queryType: "procedural",
          domain: "personal finance",
          answerShape: "step_diff",
          quantExpected: false,
          timeSensitivity: "low",
          userIntent: "learn_process",
          confidence: 0.88,
        })
      )
    );

    const result = await classifyQuery("how do I open a brokerage account?");

    expect(result).toEqual({
      queryType: "procedural",
      domain: "personal finance",
      answerShape: "step_diff",
      quantExpected: false,
      timeSensitivity: "low",
      userIntent: "learn_process",
      confidence: 0.88,
    });
  });

  it("strips markdown fences before parsing", async () => {
    mockedCallGemini.mockResolvedValue(
      okResult(
        "```json\n" +
          JSON.stringify({
            queryType: "creative_generative",
            domain: "marketing copy",
            answerShape: "gallery",
            quantExpected: false,
            timeSensitivity: "low",
            userIntent: "generate_content",
            confidence: 0.95,
          }) +
          "\n```"
      )
    );

    const result = await classifyQuery("write me a tagline (fenced json case)");

    expect(result.queryType).toBe("creative_generative");
  });

  it("caches classification for a repeated query", async () => {
    mockedCallGemini.mockResolvedValue(
      okResult(
        JSON.stringify({
          queryType: "factual_lookup",
          domain: "history",
          answerShape: "verdict_card",
          quantExpected: false,
          timeSensitivity: "low",
          userIntent: "get_answer",
          confidence: 0.99,
        })
      )
    );

    const query = "what year was the treaty signed? (cache test)";
    await classifyQuery(query);
    await classifyQuery(query);

    expect(mockedCallGemini).toHaveBeenCalledTimes(1);
  });
});
