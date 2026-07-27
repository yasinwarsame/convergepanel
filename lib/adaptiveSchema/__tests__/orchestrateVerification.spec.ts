/**
 * Orchestration Integration Test: ADAPTIVE_VERIFICATION_ENABLED=true path.
 *
 * The plain integration.spec.ts covers the flag-off path (unscored matrix
 * only, preserving pre-restoration behavior). This covers the full R1–R3
 * restored pipeline end to end on the carbon-tax fixture: dense matrix, run
 * certainty score, gate result, and a synthesis report containing Unified
 * Answer + Panel Verdict, per the corrective spec's R5.3 integration test
 * requirement.
 */

jest.mock("@/lib/env", () => ({
  ADAPTIVE_VERIFICATION_ENABLED: true,
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

function carbonTaxResponse(id: string, claimText: string, stance: "asserts" | "disputes" | "uncertain") {
  return JSON.stringify({
    summary: "Economists debate the relative effectiveness of carbon pricing mechanisms.",
    settledClaims: [
      {
        id: "carbon-pricing-reduces-emissions",
        claim: "Carbon pricing reduces emissions relative to no policy.",
        stance: "asserts",
        confidence: "settled",
        evidenceType: "empirical",
      },
    ],
    disputedClaims: [
      {
        id,
        claim: claimText,
        stance,
        confidence: "contested",
        evidenceType: "theoretical",
      },
    ],
    keyMetrics: [],
    openQuestions: [],
  });
}

describe("finalizeAdaptiveRun with ADAPTIVE_VERIFICATION_ENABLED=true (carbon-tax fixture)", () => {
  afterEach(() => jest.clearAllMocks());

  it("produces a dense scored matrix, run certainty, gate result, and a synthesis report with Unified Answer + Panel Verdict", async () => {
    const schema = SCHEMA_REGISTRY.contested_empirical;

    const results: ModelResult[] = [
      { modelId: "chatgpt", status: "ok", rawText: carbonTaxResponse("tax-design-quality-matters", "Design quality matters more than mechanism choice.", "uncertain"), latencyMs: 500 },
      { modelId: "claude", status: "ok", rawText: carbonTaxResponse("flexibility-favors-cap-and-trade", "Cap-and-trade is more flexible for firms.", "asserts"), latencyMs: 500 },
      { modelId: "grok", status: "ok", rawText: carbonTaxResponse("similar-reduction-outcomes", "Cap-and-trade achieves similar emissions reductions to a carbon tax.", "asserts"), latencyMs: 500 },
      { modelId: "perplexity", status: "ok", rawText: carbonTaxResponse("pricing-mechanism-comparison", "Carbon taxes often outperform emissions trading systems in reducing emissions.", "asserts"), latencyMs: 500 },
      { modelId: "gemini", status: "ok", rawText: carbonTaxResponse("renewable-investment-primary-driver", "Renewable investment matters more than pricing mechanism choice.", "uncertain"), latencyMs: 500 },
    ];

    // Cluster call: merge the 5 distinct disputed-claim slugs into one
    // proposition cluster (mirrors the R3 regression fixture), keeping the
    // shared "carbon-pricing-reduces-emissions" settled claim untouched
    // (it already merges via identical slugs in pass 1, no call needed for it).
    mockedCallGemini.mockImplementation(async (userMessage: any) => {
      const text = String(userMessage);
      if (text.includes("c0:")) {
        // Pass-1 groups (in nodes order): c0 = the settled claim, already
        // merged across all 5 models by identical slug (5-member group);
        // c1..c5 = each model's disputed claim, still singletons (distinct
        // self-assigned slugs — the original under-clustering bug).
        return {
          modelId: "gemini",
          status: "ok",
          rawText: JSON.stringify({
            clusters: [
              {
                canonicalText: "Carbon pricing reduces emissions relative to no policy",
                members: [{ key: "c0", stance: "agrees", excerpt: "Baseline consensus claim" }],
              },
              {
                canonicalText: "Carbon taxes are more effective than cap-and-trade at reducing emissions",
                members: [
                  { key: "c1", stance: "partial", excerpt: "Design quality matters more than mechanism" }, // chatgpt
                  { key: "c2", stance: "disputes", excerpt: "Cap-and-trade is more flexible for firms" }, // claude
                  { key: "c3", stance: "disputes", excerpt: "Cap-and-trade achieves similar reductions" }, // grok
                  { key: "c4", stance: "agrees", excerpt: "Carbon taxes often outperform ETS" }, // perplexity
                  { key: "c5", stance: "unclear", excerpt: "Renewable investment matters more" }, // gemini
                ],
              },
            ],
          }),
          latencyMs: 5,
        };
      }
      // Synthesis narrative call — degrade to template (return an error) to
      // keep this test focused on the scoring/gate pipeline, not the prose.
      return { modelId: "gemini", status: "error", rawText: null, errorMessage: "n/a", latencyMs: 5 };
    });

    const output = await finalizeAdaptiveRun(schema, results, "Do carbon taxes outperform cap-and-trade?");

    expect(output.alignedClaims).toBeDefined();
    const rows = output.alignedClaims!;

    // Dense matrix: every row should have every cell scored (agreementScore/certaintyScore are numbers).
    for (const row of rows) {
      expect(typeof row.agreementScore).toBe("number");
      expect(typeof row.certaintyScore).toBe("number");
    }

    const pricingRow = rows.find((r) => r.claimText.includes("Carbon taxes are more effective"));
    expect(pricingRow).toBeDefined();
    // All 5 models landed in one row (no silent singletons) -> >=60% non-null, matching the R3 bar.
    expect(pricingRow!.cells.filter(Boolean).length).toBeGreaterThanOrEqual(3);

    const grokCell = pricingRow!.cells.find((c) => c?.modelId === "grok");
    const perplexityCell = pricingRow!.cells.find((c) => c?.modelId === "perplexity");
    expect(grokCell).toMatchObject({ stance: "disputes" });
    expect(perplexityCell).toMatchObject({ stance: "agrees" });

    // Gate result present and well-formed.
    expect(output.gate).toBeDefined();
    expect(["pass", "caution", "fail"]).toContain(output.gate!.status);

    // Synthesis report present with all required sections.
    expect(output.synthesisReport).toBeDefined();
    expect(output.synthesisReport!.unifiedAnswer).toBeTruthy();
    expect(output.synthesisReport!.panelVerdict).toMatch(/models converge on/);
    expect(typeof output.synthesisReport!.runCertainty).toBe("number");

    // Trust summary present for all 5 models.
    expect(output.trustSummary).toBeDefined();
    expect(output.trustSummary!.perModel).toHaveLength(5);
    expect(output.trustSummary!.perModel.map((m) => m.modelId).sort()).toEqual(
      ["chatgpt", "claude", "gemini", "grok", "perplexity"].sort()
    );
    expect(typeof output.trustSummary!.overallTrust).toBe("number");

    // Restored narrative layer: executive summary + a real disagreement card
    // built from the dense pricing-mechanism row's actual excerpts, plus a
    // deterministic verdict card restating the question.
    expect(output.synthesisReport!.executiveSummary).toBeTruthy();
    const pricingDisagreement = output.synthesisReport!.disagreements.find((d) =>
      d.topic.includes("Carbon taxes are more effective")
    );
    expect(pricingDisagreement).toBeDefined();
    expect(pricingDisagreement!.positions.length).toBeGreaterThanOrEqual(3);
    expect(pricingDisagreement!.positions.some((p) => p.modelId === "grok" && p.position.includes("Cap-and-trade"))).toBe(
      true
    );
    expect(output.synthesisReport!.verdictCard).toBeTruthy();
    expect(output.synthesisReport!.verdictCard.question).toBe("Do carbon taxes outperform cap-and-trade?");
  });
});
