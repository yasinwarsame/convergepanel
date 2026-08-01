/**
 * One-shot retry-with-error-feedback test.
 *
 * When a model's first response leaves required fields invalid even after
 * enum coercion + field-level salvage, finalizeAdaptiveRun re-prompts that
 * model exactly once with the validation errors appended, then merges
 * whatever the retry recovers onto the original salvage. This must never
 * loop — a still-broken retry response is accepted as final, not retried
 * again.
 */

jest.mock("@/lib/env", () => ({
  ADAPTIVE_VERIFICATION_ENABLED: false,
  GEMINI_API_KEY: "test-key",
}));

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { finalizeAdaptiveRun } from "@/lib/adaptiveSchema/orchestrate";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { ModelResult } from "@/lib/types";

describe("finalizeAdaptiveRun retry-with-error-feedback", () => {
  afterEach(() => jest.clearAllMocks());

  const schema = SCHEMA_REGISTRY.factual_lookup; // answer/source/caveat — all scalar, no clustering LLM call involved

  const firstAttemptRawText = JSON.stringify({ answer: "42", source: "reference" }); // missing caveat

  const results: ModelResult[] = [
    { modelId: "gemini", status: "ok", rawText: firstAttemptRawText, latencyMs: 500 },
  ];

  const retryContext = {
    apiKeys: { gemini: "test-key" },
    promptOverrides: { gemini: "BASE SYSTEM PROMPT" },
    context: null,
  };

  it("re-calls the connector exactly once and merges the recovered field onto the original salvage", async () => {
    mockedCallGemini.mockResolvedValueOnce({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({ answer: "42", source: "reference", caveat: "none" }),
      latencyMs: 5,
    });

    const output = await finalizeAdaptiveRun(schema, results, "What is the answer?", retryContext);
    const geminiResult = output.adaptiveResults.find((r) => r.modelId === "gemini")!;

    expect(mockedCallGemini).toHaveBeenCalledTimes(1);
    // The retry prompt carries the original prompt plus the validation errors.
    const [, , , opts] = mockedCallGemini.mock.calls[0];
    expect(opts?.systemPromptOverride).toContain("BASE SYSTEM PROMPT");
    expect(opts?.systemPromptOverride).toContain("caveat");
    expect(opts?.systemPromptOverride?.toLowerCase()).toContain("correct these fields");

    expect(geminiResult.ok).toBe(true);
    expect(geminiResult.retried).toBe(true);
    expect(geminiResult.data?.caveat).toBe("none");
    expect(geminiResult.invalidFields).toBeUndefined();
  });

  it("does not loop: a still-invalid retry response is accepted as final after exactly one call", async () => {
    mockedCallGemini.mockResolvedValueOnce({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({ answer: "42", source: "reference" }), // still missing caveat
      latencyMs: 5,
    });

    const output = await finalizeAdaptiveRun(schema, results, "What is the answer?", retryContext);
    const geminiResult = output.adaptiveResults.find((r) => r.modelId === "gemini")!;

    expect(mockedCallGemini).toHaveBeenCalledTimes(1); // no second retry attempt
    expect(geminiResult.ok).toBe(true); // answer + source still salvaged from the first attempt
    expect(geminiResult.retried).toBe(true);
    expect(geminiResult.invalidFields).toEqual(["caveat"]);
    expect(geminiResult.data?.answer).toBe("42");
  });

  it("keeps the first attempt's salvage and does not retry a second time when the retry call itself errors", async () => {
    mockedCallGemini.mockResolvedValueOnce({
      modelId: "gemini",
      status: "error",
      rawText: null,
      errorMessage: "rate limited",
      latencyMs: 5,
    });

    const output = await finalizeAdaptiveRun(schema, results, "What is the answer?", retryContext);
    const geminiResult = output.adaptiveResults.find((r) => r.modelId === "gemini")!;

    expect(mockedCallGemini).toHaveBeenCalledTimes(1);
    expect(geminiResult.ok).toBe(true);
    expect(geminiResult.retried).toBeUndefined(); // connector call failed — original (unretried) salvage is kept as-is
    expect(geminiResult.invalidFields).toEqual(["caveat"]);
  });

  it("skips retry entirely when the first attempt already validates cleanly", async () => {
    const cleanResults: ModelResult[] = [
      {
        modelId: "gemini",
        status: "ok",
        rawText: JSON.stringify({ answer: "42", source: "reference", caveat: "none" }),
        latencyMs: 500,
      },
    ];

    const output = await finalizeAdaptiveRun(schema, cleanResults, "What is the answer?", retryContext);

    expect(mockedCallGemini).not.toHaveBeenCalled();
    expect(output.adaptiveResults[0].ok).toBe(true);
    expect(output.adaptiveResults[0].retried).toBeUndefined();
  });
});
