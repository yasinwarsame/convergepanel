/**
 * Adaptive Synthesis Report Tests (R1e)
 *
 * Covers: the always-present 5 sections, the deterministic (never
 * model-generated) Unified Answer + Panel Verdict, and the degraded-path
 * template fallback when the narrative model call fails.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";

function cell(modelId: string, stance: AlignedClaimCell["stance"] = "agrees"): AlignedClaimCell {
  return { modelId: modelId as any, stance, rawStance: "asserts", confidence: "settled", excerpt: "x" };
}

function row(id: string, status: AlignedClaim["status"], cells: AlignedClaimCell[]): AlignedClaim {
  return {
    id,
    claimText: id,
    cells,
    agreementScore: status === "split" ? 0.2 : 0.9,
    certaintyScore: status === "split" ? 0.2 : 0.9,
    status,
  };
}

describe("buildAdaptiveSynthesisReport", () => {
  afterEach(() => jest.clearAllMocks());

  it("always includes all 5 required sections, even with an empty claim set", async () => {
    const report = await buildAdaptiveSynthesisReport("What happened?", "generic", [], 5);
    expect(report.unifiedAnswer).toBeTruthy();
    expect(report.panelVerdict).toBeTruthy();
    expect(typeof report.gate).toBe("string");
    expect(typeof report.runCertainty).toBe("number");
    expect(Array.isArray(report.whereModelsAgree)).toBe(true);
    expect(Array.isArray(report.whereModelsDisagree)).toBe(true);
    expect(report.certaintyAssessment).toBeTruthy();
  });

  it("degrades to the template report when the narrative call fails, without crashing", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "error",
      rawText: null,
      errorMessage: "boom",
      latencyMs: 5,
    });

    const rows = [row("Consensus claim", "consensus", [cell("chatgpt"), cell("claude")])];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, 5);

    expect(report.degraded).toBe(true);
    expect(report.unifiedAnswer).toContain("Consensus claim");
    expect(report.whereModelsAgree).toContain("Consensus claim");
  });

  it("uses the model's narrative when the call succeeds, but keeps Unified Answer/Verdict deterministic", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({
        whereModelsAgreeNarrative: ["Models broadly agree carbon pricing reduces emissions."],
        whereModelsDisagreeNarrative: [],
        certaintyAssessment: "High certainty given strong consensus.",
        narrativeSections: [{ title: "Metrics spread", body: "Values cluster tightly." }],
      }),
      latencyMs: 5,
    });

    const rows = [row("Carbon pricing reduces emissions", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")])];
    const report = await buildAdaptiveSynthesisReport("Does carbon pricing work?", "generic", rows, 5);

    expect(report.degraded).toBe(false);
    expect(report.whereModelsAgree).toEqual(["Models broadly agree carbon pricing reduces emissions."]);
    expect(report.narrativeSections).toEqual([{ title: "Metrics spread", body: "Values cluster tightly." }]);
    // Deterministic fields still computed in code, not sourced from the mock response.
    expect(report.unifiedAnswer).toContain("Carbon pricing reduces emissions");
    expect(report.panelVerdict).toMatch(/^3\/5 models converge/);
  });

  it("on gate fail, Unified Answer never reads as confident even if the narrative call succeeds", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: JSON.stringify({
        whereModelsAgreeNarrative: [],
        whereModelsDisagreeNarrative: ["Models disagree sharply on the core claim."],
        certaintyAssessment: "Low certainty.",
        narrativeSections: [],
      }),
      latencyMs: 5,
    });

    const rows = [row("Contested claim", "split", [cell("chatgpt", "disputes"), cell("claude", "agrees")])];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, 5);

    expect(report.gate).toBe("fail");
    expect(report.unifiedAnswer).toContain("Panel could not converge");
  });
});
