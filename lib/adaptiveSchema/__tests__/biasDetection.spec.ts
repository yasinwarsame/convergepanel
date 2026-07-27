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

  it("returns [] without calling the model when fewer than 2 usable responses exist", async () => {
    const results = [usableResult("chatgpt", "some text")];
    const findings = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any]);
    expect(findings).toEqual([]);
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
    const findings = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any]);

    expect(findings).toHaveLength(1);
    expect(findings[0].biasType).toBe("Western-centric framing");
    // "invented-model" is filtered out of both modelsImplicated and evidence — never trust the model's own IDs blindly.
    expect(findings[0].modelsImplicated).toEqual(["chatgpt"]);
    expect(findings[0].evidence).toHaveLength(1);
    expect(findings[0].evidence[0].modelId).toBe("chatgpt");
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
    const findings = await detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any]);
    expect(findings).toEqual([]);
  });

  it("degrades to [] on timeout/error, never throws", async () => {
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "error", rawText: null, errorMessage: "boom", latencyMs: 5 });
    const results = [usableResult("chatgpt", "text"), usableResult("claude", "text")];
    await expect(detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any])).resolves.toEqual([]);
  });

  it("degrades to [] on malformed JSON, never throws", async () => {
    mockedCallGemini.mockResolvedValue({ modelId: "gemini", status: "ok", rawText: "not json at all", latencyMs: 5 });
    const results = [usableResult("chatgpt", "text"), usableResult("claude", "text")];
    await expect(detectAdaptiveBiases("Q", "generic", results, ["chatgpt" as any, "claude" as any])).resolves.toEqual([]);
  });
});
