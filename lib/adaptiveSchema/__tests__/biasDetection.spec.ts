/**
 * Bias & Blind Spots Detection Tests (A3)
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { detectAdaptiveBiases } from "@/lib/adaptiveSchema/biasDetection";
import { ModelResult } from "@/lib/types";

function usableResult(modelId: string, rawText: string): ModelResult {
  return { modelId: modelId as any, status: "ok", rawText, latencyMs: 500 };
}

describe("detectAdaptiveBiases", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns [] with emptyReason 'insufficient_models' without calling the model when fewer than 2 usable responses exist", async () => {
    const results = [usableResult("chatgpt", "some text")];
    const result = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any]);
    expect(result.findings).toEqual([]);
    expect(result.emptyReason).toBe("insufficient_models");
    expect(mockedCallGemini).not.toHaveBeenCalled();
  });

  it("returns parsed, roster-filtered findings capped at MAX_BIAS_FINDINGS on success", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({
        biasAndBlindSpots: [
          {
            biasType: "Western-centric framing",
            description: "Models default to US/EU regulatory examples.",
            modelsImplicated: ["chatgpt", "invented-model"],
            evidence: [
              { modelId: "chatgpt", excerpt: "In the US and EU...", rationale: "Only cites Western examples" },
              { modelId: "invented-model", excerpt: "n/a", rationale: "not a real model in this run" },
            ],
            likelyCauses: ["Training data skew"],
            impact: "Understates non-Western approaches.",
            mitigationSteps: ["Ask explicitly for non-Western examples."],
          },
        ],
      }),
      latencyMs: 5,
    });

    const results = [usableResult("chatgpt", "In the US and EU, policy works."), usableResult("claude", "Policy works generally.")];
    const result = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any]);

    expect(result.findings).toHaveLength(1);
    expect(result.emptyReason).toBeNull();
    expect(result.findings[0].biasType).toBe("Western-centric framing");
    // "invented-model" is filtered out of both modelsImplicated and evidence — never trust the model's own IDs blindly.
    expect(result.findings[0].modelsImplicated).toEqual(["chatgpt"]);
    expect(result.findings[0].evidence).toHaveLength(1);
    expect(result.findings[0].evidence[0].modelId).toBe("chatgpt");
  });

  it("drops a finding entirely if roster-filtering leaves no valid evidence", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({
        biasAndBlindSpots: [
          {
            biasType: "Hallucinated bias",
            description: "Attributed only to a model outside the roster.",
            modelsImplicated: ["not-in-roster"],
            evidence: [{ modelId: "not-in-roster", excerpt: "x", rationale: "y" }],
            likelyCauses: [],
            impact: "n/a",
            mitigationSteps: [],
          },
        ],
      }),
      latencyMs: 5,
    });

    const results = [usableResult("chatgpt", "text"), usableResult("claude", "text")];
    const result = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any]);
    expect(result.findings).toEqual([]);
    // Roster-filtering left nothing — the call itself succeeded and returned a shape, so this is a genuine null result, not a call failure.
    expect(result.emptyReason).toBe("below_threshold");
  });

  it("degrades to [] with emptyReason 'call_failed' on timeout/error, never throws", async () => {
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "boom", latencyMs: 5 });
    const results = [usableResult("chatgpt", "text"), usableResult("claude", "text")];
    const result = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any]);
    expect(result.findings).toEqual([]);
    expect(result.emptyReason).toBe("call_failed");
  });

  it("degrades to [] with emptyReason 'call_failed' on unparseable JSON, never throws", async () => {
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: "not json at all", latencyMs: 5 });
    const results = [usableResult("chatgpt", "text"), usableResult("claude", "text")];
    const result = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any]);
    expect(result.findings).toEqual([]);
    expect(result.emptyReason).toBe("call_failed");
  });

  it("degrades to [] with emptyReason 'invalid_response' when the JSON parses but doesn't match the expected shape", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({ someOtherField: "not the biasAndBlindSpots shape at all" }),
      latencyMs: 5,
    });
    const results = [usableResult("chatgpt", "text"), usableResult("claude", "text")];
    const result = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any]);
    expect(result.findings).toEqual([]);
    expect(result.emptyReason).toBe("invalid_response");
  });
});
