/**
 * Adaptive Synthesis Report Tests (R1e, extended by Synthesis Report Polish Part A)
 *
 * Covers: the always-present sections, the deterministic (never
 * model-generated) Unified Answer/Panel Verdict/Verdict Card, the
 * degraded-path template fallback when the narrative model call fails, and
 * the new narrative layer (executive summary, disagreements, model-name
 * validation).
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { buildAdaptiveSynthesisReport } from "@/lib/adaptiveSchema/synthesisReport";
import { AlignedClaim, AlignedClaimCell } from "@/lib/adaptiveSchema/types";
import { ModelResult } from "@/lib/types";

function cell(modelId: string, stance: AlignedClaimCell["stance"] = "agrees", excerpt = "x"): AlignedClaimCell {
  return { modelId: modelId as any, stance, rawStance: "asserts", confidence: "settled", excerpt };
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

function results(modelIds: string[]): ModelResult[] {
  return modelIds.map((modelId) => ({ modelId: modelId as any, status: "ok", rawText: "{}", latencyMs: 5 }));
}

function narrativeResponse(overrides: Partial<Record<string, any>> = {}) {
  return JSON.stringify({
    executiveSummary: "Carbon pricing reduces emissions. Models broadly agree on this.",
    whereModelsAgreeNarrative: ["Models broadly agree carbon pricing reduces emissions."],
    whyModelsDisagree: [],
    disagreementStakes: [],
    certaintyAssessment: "High certainty given strong consensus.",
    narrativeSections: [{ title: "Metrics spread", body: "Values cluster tightly." }],
    ...overrides,
  });
}

describe("buildAdaptiveSynthesisReport", () => {
  afterEach(() => jest.clearAllMocks());

  it("always includes all required sections, even with an empty claim set", async () => {
    const report = await buildAdaptiveSynthesisReport("What happened?", "generic", [], results(["chatgpt", "claude"]));
    expect(report.unifiedAnswer).toBeTruthy();
    expect(report.panelVerdict).toBeTruthy();
    expect(typeof report.gate).toBe("string");
    expect(typeof report.runCertainty).toBe("number");
    expect(Array.isArray(report.whereModelsAgree)).toBe(true);
    expect(Array.isArray(report.whereModelsDisagree)).toBe(true);
    expect(report.certaintyAssessment).toBeTruthy();
    expect(report.executiveSummary).toBeTruthy();
    expect(Array.isArray(report.disagreements)).toBe(true);
    expect(Array.isArray(report.biasAndBlindSpots)).toBe(true);
    expect(report.verdictCard).toBeTruthy();
    expect(report.verdictCard.question).toBe("What happened?");
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
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(["chatgpt", "claude", "grok", "perplexity", "gemini"]));

    expect(report.degraded).toBe(true);
    expect(report.unifiedAnswer).toContain("Consensus claim");
    expect(report.whereModelsAgree).toContain("Consensus claim");
    // Never a blank executive summary, even in the degraded template path.
    expect(report.executiveSummary).toBeTruthy();
  });

  it("uses the model's narrative when the call succeeds, but keeps Unified Answer/Verdict/Verdict Card deterministic", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: narrativeResponse(),
      latencyMs: 5,
    });

    const rows = [row("Carbon pricing reduces emissions", "consensus", [cell("chatgpt"), cell("claude"), cell("grok")])];
    const report = await buildAdaptiveSynthesisReport(
      "Does carbon pricing work?",
      "generic",
      rows,
      results(["chatgpt", "claude", "grok", "perplexity", "gemini"])
    );

    expect(report.degraded).toBe(false);
    expect(report.whereModelsAgree).toEqual(["Models broadly agree carbon pricing reduces emissions."]);
    expect(report.narrativeSections).toEqual([{ title: "Metrics spread", body: "Values cluster tightly." }]);
    expect(report.executiveSummary).toContain("Carbon pricing reduces emissions");
    // Deterministic fields still computed in code, not sourced from the mock response.
    expect(report.unifiedAnswer).toContain("Carbon pricing reduces emissions");
    expect(report.panelVerdict).toMatch(/^3\/5 models converge/);
    expect(report.verdictCard.topConsensus).toBe("Carbon pricing reduces emissions");
  });

  it("on gate fail, Unified Answer AND Executive Summary never read as confident even if the narrative call succeeds", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: narrativeResponse({
        executiveSummary: "Everything is settled and certain.", // model tries to sound confident despite the fail gate
        whyModelsDisagree: ["Models disagree sharply on the core claim."],
        disagreementStakes: ["decision-critical"],
      }),
      latencyMs: 5,
    });

    const rows = [row("Contested claim", "split", [cell("chatgpt", "disputes"), cell("claude", "agrees")])];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(["chatgpt", "claude", "grok", "perplexity", "gemini"]));

    expect(report.gate).toBe("fail");
    expect(report.unifiedAnswer).toContain("Panel could not converge");
    expect(report.executiveSummary).not.toContain("Everything is settled and certain");
    expect(report.executiveSummary).toBe(report.unifiedAnswer);
  });

  it("builds deterministic disagreements from real AlignedClaimCell excerpts, with model-generated whyTheyDiffer/stakes", async () => {
    mockedCallGemini.mockResolvedValue({
      modelId: "gemini",
      status: "ok",
      rawText: narrativeResponse({
        whyModelsDisagree: ["Models disagree on whether cap-and-trade matches carbon tax effectiveness."],
        disagreementStakes: ["important"],
      }),
      latencyMs: 5,
    });

    const rows = [
      row("Cap-and-trade vs carbon tax effectiveness", "split", [
        cell("grok", "disputes", "Cap-and-trade achieves similar reductions"),
        cell("perplexity", "agrees", "Carbon taxes often outperform ETS"),
      ]),
    ];
    const report = await buildAdaptiveSynthesisReport("Q", "contested_empirical", rows, results(["grok", "perplexity"]));

    expect(report.disagreements).toHaveLength(1);
    const d = report.disagreements[0];
    expect(d.topic).toBe("Cap-and-trade vs carbon tax effectiveness");
    expect(d.whyTheyDiffer).toContain("cap-and-trade matches carbon tax effectiveness");
    expect(d.stakes).toBe("important");
    expect(d.positions).toEqual([
      { modelId: "grok", position: "Cap-and-trade achieves similar reductions" },
      { modelId: "perplexity", position: "Carbon taxes often outperform ETS" },
    ]);
  });

  it("regenerates once, then strips, when the narrative call hallucinates a model name not in the roster", async () => {
    // Call order inside buildAdaptiveSynthesisReport: bias detection first,
    // then the narrative call, then (if hallucination is found) one regenerate.
    mockedCallGemini
      .mockResolvedValueOnce({ modelId: "gemini", status: "error", rawText: null, errorMessage: "n/a", latencyMs: 5 }) // bias detection
      .mockResolvedValueOnce({
        modelId: "gemini",
        status: "ok",
        rawText: narrativeResponse({ executiveSummary: "Gemini 3 Pro and GPT 5.2 agree on this." }),
        latencyMs: 5,
      }) // narrative, 1st attempt — hallucinates
      .mockResolvedValueOnce({
        modelId: "gemini",
        status: "ok",
        rawText: narrativeResponse({ executiveSummary: "Gemini 3 Pro and GPT 5.2 agree on this, still." }),
        latencyMs: 5,
      }); // narrative, regenerate attempt — still hallucinates

    const rows = [row("Consensus claim", "consensus", [cell("chatgpt"), cell("gemini")])];
    // Roster only has "chatgpt"/"gemini" — the raw modelIds, not any prose name like "Gemini 3 Pro".
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, results(["chatgpt", "gemini"]));

    expect(mockedCallGemini).toHaveBeenCalledTimes(3); // bias + narrative + one regenerate
    expect(report.executiveSummary).not.toContain("Gemini 3 Pro"); // stripped after regenerate still failed
    // "GPT 5.2" is left alone — it's chatgpt's REAL roster display name, not a hallucination.
    expect(report.executiveSummary).toContain("GPT 5.2");
  });

  it("returns bias findings and threads them into the verdict card's caveat", async () => {
    mockedCallGemini
      // Bias detection call (fires first inside buildAdaptiveSynthesisReport).
      .mockResolvedValueOnce({
        modelId: "gemini",
        status: "ok",
        rawText: JSON.stringify({
          biasAndBlindSpots: [
            {
              biasType: "Evidence-base skew",
              description: "Models over-rely on Western regulatory examples.",
              modelsImplicated: ["chatgpt"],
              evidence: [{ modelId: "chatgpt", excerpt: "In the EU and US...", rationale: "Only cites Western jurisdictions" }],
              likelyCauses: ["Training data skew"],
              impact: "May understate non-Western policy approaches.",
              mitigationSteps: ["Ask for non-Western examples explicitly."],
            },
          ],
        }),
        latencyMs: 5,
      })
      // Narrative call.
      .mockResolvedValueOnce({ modelId: "gemini", status: "ok", rawText: narrativeResponse(), latencyMs: 5 });

    const rows = [row("Consensus claim", "consensus", [cell("chatgpt"), cell("claude")])];
    const rawResults: ModelResult[] = [
      { modelId: "chatgpt" as any, status: "ok", rawText: "In the EU and US, policy X works.", latencyMs: 5 },
      { modelId: "claude" as any, status: "ok", rawText: "Policy X generally works.", latencyMs: 5 },
    ];
    const report = await buildAdaptiveSynthesisReport("Q", "generic", rows, rawResults);

    expect(report.biasAndBlindSpots).toHaveLength(1);
    expect(report.biasAndBlindSpots[0].biasType).toBe("Evidence-base skew");
    expect(report.verdictCard.caveat).toBe("Models over-rely on Western regulatory examples.");
  });
});
