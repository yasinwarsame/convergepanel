/**
 * Adaptive Research Export, Phase 3 — DOCX composer schema-semantics
 * tests (Part 21/22). Uses the REAL, unmocked renderer + JSZip-based text
 * extraction (`extractDocxText`) so assertions reflect actual generated
 * content, not a mocked approximation — mirrors the discipline of the PDF
 * composer's own `AdaptiveResearchDocument.spec.tsx`, but against a real
 * package instead of a mocked element tree.
 */

import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { extractDocxText } from "./testUtils";

function baseRecord(overrides: Partial<AdaptiveResearchExportV1> = {}): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-test-1",
    runId: "run-test-1",
    schemaId: "comparison_matrix",
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-01-02T00:00:00.000Z",
    createdBy: "uid-test",
    format: "docx",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    reportSnapshot: {
      question: "Test question?",
      models: [{ modelId: "chatgpt" as any, ok: true }, { modelId: "claude" as any, ok: true }],
      reportTypeLabel: "Comparison Report",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      milestone2: {
        schemaId: "comparison_matrix",
        result: { tradeoffs: ["Trade-off A"], bestUseRecommendations: ["Use case A"] },
        meta: {} as any,
        decisionReceipt: {
          conclusion: "Test conclusion text.",
          basis: ["Basis item A"],
          assumptions: ["Assumption A"],
          uncertainties: ["Uncertainty A"],
          limitations: ["Limitation A"],
          sources: ["Source A"],
          sourceBacked: true,
          humanReviewNeeded: false,
        },
      },
    },
    exportMetadata: {
      exportId: "exp-test-1",
      runId: "run-test-1",
      schemaVersion: 1,
      exportedSections: ["reportSnapshot.milestone2"],
      createdAt: "2026-01-02T00:00:00.000Z",
      requestingUser: "uid-test",
      finalReportVersion: 1,
    },
    ...overrides,
  };
}

function legacyBase(): AdaptiveResearchExportV1 {
  return baseRecord({
    schemaFamily: "legacy",
    schemaId: "financial_valuation",
    governanceStatusAtExport: { family: "legacy", status: "needs_review" },
    reportSnapshot: {
      question: "Financial question?",
      models: [{ modelId: "chatgpt" as any, ok: true }, { modelId: "claude" as any, ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "weak",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        modelResponses: [
          { modelId: "chatgpt" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "GPT thesis", metrics: [{ label: "P/E", value: 18, unit: "x", asOf: "2026", source: "10-K" }] } },
          { modelId: "claude" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "Claude thesis", metrics: [{ label: "P/E", value: 22, unit: "x", asOf: "2026", source: "10-K" }] } },
        ],
      },
    },
  });
}

async function renderText(record: AdaptiveResearchExportV1): Promise<string> {
  const rendered = await renderAdaptiveResearchDocxV1(record);
  return extractDocxText(rendered.bytes);
}

describe("AdaptiveResearchDocxDocument — cover, status, provenance (shared across both families)", () => {
  it("includes report type, question, report version, export ID", async () => {
    const text = await renderText(baseRecord());
    expect(text).toContain("Comparison Report");
    expect(text).toContain("Test question?");
    expect(text).toMatch(/v1/);
    expect(text).toContain("exp-test-1");
  });

  it("includes the consensus/source-grounding semantic safeguard disclaimer — never omitted", async () => {
    const text = await renderText(baseRecord());
    expect(text).toMatch(/not factual correctness/i);
    expect(text).toMatch(/not evidence strength/i);
  });

  it("provenance block includes run ID, export ID, schema, and the frozen-snapshot notice", async () => {
    const text = await renderText(baseRecord());
    expect(text).toContain("run-test-1");
    expect(text).toContain("exp-test-1");
    expect(text).toContain("comparison_matrix");
    expect(text).toMatch(/frozen snapshot/i);
  });

  it("never includes a private reviewer comment field", async () => {
    const text = await renderText(baseRecord());
    expect(text).not.toMatch(/reviewer comment/i);
  });
});

describe("AdaptiveResearchDocxDocument — governance status representation", () => {
  it.each([
    ["approved", /Reviewed and approved/],
    ["changes_requested", /Changes requested/],
    ["rejected", /Rejected/],
  ] as const)("Milestone-2 status '%s' renders its own distinct label", async (kind, expected) => {
    const record = baseRecord({ governanceStatusAtExport: { family: "milestone2", kind, isOwnerOverride: false } });
    const text = await renderText(record);
    expect(text).toMatch(expected);
  });

  it("owner override is shown combined with its real underlying status", async () => {
    const record = baseRecord({ governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: true } });
    const text = await renderText(record);
    expect(text).toMatch(/Owner override.*Reviewed and approved/);
  });

  it.each([
    ["approved", /Reviewed and approved/],
    ["needs_review", /Needs review/],
    ["blocked", /Blocked by policy/],
    [null, /Not yet evaluated/],
  ] as const)("legacy family status '%s' uses its own 3-value vocabulary, never the Milestone-2 labels", async (status, expected) => {
    const record = legacyBase();
    record.governanceStatusAtExport = { family: "legacy", status };
    const text = await renderText(record);
    expect(text).toMatch(expected);
  });
});

describe("AdaptiveResearchDocxDocument — comparison_matrix (Milestone-2)", () => {
  it("renders decisionReceipt fields and the comparison_matrix enrichment (trade-offs/best-use recommendations)", async () => {
    const text = await renderText(baseRecord());
    expect(text).toContain("Test conclusion text.");
    expect(text).toContain("Basis item A");
    expect(text).toContain("Trade-off A");
    expect(text).toContain("Use case A");
  });

  it("never fabricates a decisionReceipt when none exists — shows an honest 'not reviewed' notice instead", async () => {
    const record = baseRecord({ reportSnapshot: { ...baseRecord().reportSnapshot, milestone2: { schemaId: "comparison_matrix", result: {}, meta: {} as any, decisionReceipt: undefined } } });
    const text = await renderText(record);
    expect(text).toMatch(/no governance record exists/i);
    expect(text).not.toContain("Test conclusion text.");
  });
});

describe("AdaptiveResearchDocxDocument — evidence_review (Milestone-2)", () => {
  function evidenceReviewRecord(): AdaptiveResearchExportV1 {
    return baseRecord({
      schemaId: "evidence_review",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
      reportSnapshot: {
        ...baseRecord().reportSnapshot,
        reportTypeLabel: "Evidence Review",
        milestone2: {
          schemaId: "evidence_review",
          result: {},
          meta: {} as any,
          decisionReceipt: {
            conclusion: "Evidence coverage is broad but individual sources are weak.",
            basis: ["12 sources reviewed across 3 domains"],
            assumptions: [],
            uncertainties: ["Coverage does not guarantee reliability"],
            limitations: [],
            sources: ["Source A", "Source B"],
            sourceBacked: true,
            humanReviewNeeded: false,
          },
        },
      },
    });
  }

  it("shares the same coverage-not-strength safeguard as every other schema (schema-agnostic status summary, never schema-specific relabeling)", async () => {
    const text = await renderText(evidenceReviewRecord());
    expect(text).toMatch(/citation coverage, not evidence strength/i);
    expect(text).toContain("Evidence coverage is broad but individual sources are weak.");
  });
});

describe("AdaptiveResearchDocxDocument — legacy primary content", () => {
  it("renders per-model theses, both remaining distinct and attributed", async () => {
    const text = await renderText(legacyBase());
    expect(text).toContain("GPT thesis");
    expect(text).toContain("Claude thesis");
  });

  it("preserves each model's own metric value side by side in a real table — never averaged into one number", async () => {
    const text = await renderText(legacyBase());
    expect(text).toMatch(/18/);
    expect(text).toMatch(/22/);
    expect(text).not.toMatch(/\b20\b/);
  });

  it("financial_valuation: units and 'as of' dates survive alongside the value, never dropped", async () => {
    const text = await renderText(legacyBase());
    expect(text).toContain("P/E");
    expect(text).toContain("x");
    expect(text).toContain("2026");
    expect(text).toContain("10-K");
  });

  it("creative_generative (no synthesisReport): never fabricates a panel conclusion, shows the honest no-consensus notice; Consensus/Source grounding both read 'Not scored'", async () => {
    const record = legacyBase();
    record.schemaId = "creative_generative";
    record.reportSnapshot.reportTypeLabel = "Creative Output";
    record.reportSnapshot.consensusLevel = "unscored";
    record.reportSnapshot.sourceGroundingLevel = "unscored";
    record.reportSnapshot.legacy = {
      schemaId: "creative_generative",
      alignedClaims: [],
      modelResponses: [
        { modelId: "chatgpt" as any, schemaId: "creative_generative", ok: true, data: { output: "Option A." } },
        { modelId: "claude" as any, schemaId: "creative_generative", ok: true, data: { output: "Option B." } },
      ],
    };
    const text = await renderText(record);
    expect(text).toMatch(/does not produce a single synthesized panel conclusion/i);
    expect(text).not.toMatch(/models agree/i);
    expect(text).not.toMatch(/models disagree/i);
    const notScoredCount = (text.match(/Not scored/g) || []).length;
    expect(notScoredCount).toBeGreaterThanOrEqual(2);
    expect(text).toContain("Option A.");
    expect(text).toContain("Option B.");
  });

  it("forecast_speculative: scenarios remain distinct entries, never blended into a single fabricated probability; base rates and uncertainties stay separate fields", async () => {
    const record = legacyBase();
    record.schemaId = "forecast_speculative";
    record.reportSnapshot.reportTypeLabel = "Forecast";
    record.reportSnapshot.legacy = {
      schemaId: "forecast_speculative",
      alignedClaims: [],
      modelResponses: [
        {
          modelId: "chatgpt" as any,
          schemaId: "forecast_speculative",
          ok: true,
          data: {
            scenarios: [
              { name: "Bull case", probability: 0.3, description: "Rapid adoption." },
              { name: "Base case", probability: 0.5, description: "Steady growth." },
              { name: "Bear case", probability: 0.2, description: "Stagnation." },
            ],
            baseRates: ["Historical category growth: 8%/yr"],
            keyUncertainties: ["Regulatory response"],
          },
        },
      ],
    };
    const text = await renderText(record);
    expect(text).toContain("Bull case");
    expect(text).toContain("Base case");
    expect(text).toContain("Bear case");
    expect(text).toContain("Historical category growth: 8%/yr");
    expect(text).toContain("Regulatory response");
    // Never a single invented aggregate probability/prediction string —
    // the composer only ever echoes the model's own per-scenario data.
    expect(text).not.toMatch(/overall probability/i);
    expect(text).not.toMatch(/predicted outcome/i);
  });
});

describe("AdaptiveResearchDocxDocument — security", () => {
  it("HTML/script content in model output renders as literal (escaped) text, never interpreted", async () => {
    const record = legacyBase();
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).thesis = "<script>alert(1)</script>";
    const text = await renderText(record);
    expect(text).toContain("<script>alert(1)</script>");
  });

  it("an extremely long field value does not crash generation", async () => {
    const record = legacyBase();
    const huge = "x".repeat(20_000);
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).thesis = huge;
    await expect(renderAdaptiveResearchDocxV1(record)).resolves.toBeDefined();
  });

  it("a large number of model responses does not crash generation (resource-exhaustion smoke check)", async () => {
    const record = legacyBase();
    record.reportSnapshot.legacy!.modelResponses = Array.from({ length: 30 }, (_, i) => ({
      modelId: "chatgpt" as any,
      schemaId: "financial_valuation" as const,
      ok: true,
      data: { thesis: `Thesis ${i}`, metrics: [{ label: "P/E", value: i, unit: "x", asOf: "2026", source: "10-K" }] },
    }));
    await expect(renderAdaptiveResearchDocxV1(record)).resolves.toBeDefined();
  });
});
