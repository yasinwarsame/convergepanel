/**
 * bias_blindspot_audit alignment/aggregation tests (Milestone 2).
 *
 * Covers: model-specific attribution preserved (Tier 1, via reused
 * `detectAdaptiveBiases`), unsupported attribution stays empty, panel
 * omissions merge correctly (Tier 2, reused `auditPanelCoverage` + self-
 * reported gaps), shared assumptions dedupe, missing stakeholders remain
 * distinct, source concentration stays separate from geographic bias
 * (Tier 3), Tier 3 diagnostics compute correctly, the homogeneity flag
 * fires above threshold and not on mixed agreement, Tier 2 renders when
 * Tier 1 is empty, Tier 3 renders when Tier 1 and Tier 2 are empty, failed
 * models remain in the denominator, and malformed/empty input fails
 * safely.
 *
 * `callGemini` is mocked at the connector level — both reused tier calls
 * (`detectAdaptiveBiases`, `auditPanelCoverage`) go through it.
 */

import { callGemini } from "@/lib/connectors/gemini";

jest.mock("@/lib/connectors/gemini", () => ({
  callGemini: jest.fn(),
}));

const mockedCallGemini = callGemini as jest.MockedFunction<typeof callGemini>;

import { buildBiasBlindspotAuditResult, BiasBlindspotFields } from "@/lib/adaptiveSchema/biasBlindspotAlignment";
import { ModelResult } from "@/lib/types";
import { ModelId } from "@/lib/types";

function fields(overrides: Partial<BiasBlindspotFields> = {}): BiasBlindspotFields {
  return {
    summary: "",
    omittedDimensions: [],
    sharedAssumptions: [],
    missingStakeholders: [],
    geographicBiases: [],
    sourceConcentrationConcerns: [],
    evidenceTypeConcerns: [],
    followUpQuestions: [],
    sources: [],
    ...overrides,
  };
}

function perModel(entries: [string, BiasBlindspotFields][]) {
  return entries.map(([modelId, f]) => ({ modelId: modelId as ModelId, fields: f }));
}

function rawResults(modelIds: string[]): ModelResult[] {
  return modelIds.map((modelId) => ({ modelId: modelId as ModelId, status: "ok", rawText: "some raw response text", latencyMs: 5 }));
}

/**
 * Routes by request CONTENT (the system prompt), not call order — the two
 * reused tier calls run in `Promise.all`, and `auditPanelCoverage` silently
 * skips the network call entirely when it has no claim texts (e.g. every
 * model's `summary` is empty), so a FIFO `mockResolvedValueOnce` queue
 * would leave an unconsumed mock that leaks into the NEXT test and
 * misaligns it — the same class of bug as the classifier's documented
 * LRU-cache test carryover. Content-based routing is immune to that.
 */
function mockTierCalls(opts: { biasFindings?: any[]; coverageGaps?: any[] } = {}) {
  mockedCallGemini.mockImplementation(async (_question, _context, _apiKey, callOpts) => {
    const prompt = callOpts?.systemPromptOverride || "";
    if (prompt.includes("biases and blind spots")) {
      return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ biasAndBlindSpots: opts.biasFindings ?? [] }), latencyMs: 5 };
    }
    return { modelId: "gemini", status: "ok", rawText: JSON.stringify({ gaps: opts.coverageGaps ?? [] }), latencyMs: 5 };
  });
}

describe("buildBiasBlindspotAuditResult — Tier 1 (attributed bias)", () => {
  afterEach(() => jest.clearAllMocks());

  it("preserves model-specific attribution from the reused detectAdaptiveBiases call", async () => {
    mockTierCalls({
      biasFindings: [
        {
          biasType: "Western-centric framing",
          description: "The analysis assumes a US regulatory context.",
          modelsImplicated: ["chatgpt"],
          evidence: [{ modelId: "chatgpt", excerpt: "Under US law, this would typically...", rationale: "Assumes US jurisdiction by default." }],
          likelyCauses: ["Training data skew"],
          impact: "May mislead non-US readers.",
          mitigationSteps: ["Clarify jurisdiction"],
        },
      ],
    });
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(perModel([["chatgpt", fields()], ["claude", fields()]]), 2, "q", results);

    expect(result.attributedBiases).toHaveLength(1);
    expect(result.attributedBiases[0].modelsImplicated).toEqual(["chatgpt"]);
    expect(result.biasEmptyReason).toBeNull();
  });

  it("stays empty (with a reason, never fabricated) when attribution is not justified", async () => {
    mockTierCalls({ biasFindings: [] });
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(perModel([["chatgpt", fields()], ["claude", fields()]]), 2, "q", results);

    expect(result.attributedBiases).toEqual([]);
    expect(result.biasEmptyReason).toBe("below_threshold");
  });

  it("Tier 1 attribution comes only from the reused audit call — a self-reported field never fabricates a finding", async () => {
    mockTierCalls({ biasFindings: [] });
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: "I might be biased toward US framing." })],
        ["claude", fields()],
      ]),
      2,
      "q",
      results
    );
    expect(result.attributedBiases).toEqual([]);
  });
});

describe("buildBiasBlindspotAuditResult — Tier 2 (panel omissions)", () => {
  afterEach(() => jest.clearAllMocks());

  it("merges the reused audit's gaps with the panel's own self-reported omissions", async () => {
    mockTierCalls({
      coverageGaps: [{ dimension: "International comparisons", whyItMatters: "Only domestic data was covered.", followUpQuestion: "How does this compare internationally?" }],
    });
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: "Domestic inflation drivers were covered in depth.", omittedDimensions: ["Long-term consequences"] })],
        ["claude", fields({ summary: "The panel focused on short-term domestic price data." })],
      ]),
      2,
      "q",
      results
    );

    expect(result.panelBlindSpots).toHaveLength(2);
    const dims = result.panelBlindSpots.map((b) => b.missingDimension);
    expect(dims).toContain("International comparisons");
    expect(dims).toContain("Long-term consequences");
  });

  it("merges overlapping audited and self-reported gaps into one entry, keeping the audited whyItMatters", async () => {
    mockTierCalls({
      coverageGaps: [{ dimension: "International comparisons", whyItMatters: "Only domestic data was covered.", followUpQuestion: "How does this compare internationally?" }],
    });
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: "Domestic inflation drivers were covered in depth.", omittedDimensions: ["International comparisons are missing"] })],
        ["claude", fields({ summary: "The panel focused on short-term domestic price data." })],
      ]),
      2,
      "q",
      results
    );

    expect(result.panelBlindSpots).toHaveLength(1);
    expect(result.panelBlindSpots[0].whyItMatters).toBe("Only domestic data was covered.");
    expect(result.panelBlindSpots[0].coverageReason).toMatch(/independent coverage audit/);
    expect(result.panelBlindSpots[0].coverageReason).toMatch(/1 of 2 models/);
  });

  it("Tier 2 renders (is non-empty) even when Tier 1 is empty", async () => {
    mockTierCalls({ biasFindings: [], coverageGaps: [{ dimension: "X", whyItMatters: "y", followUpQuestion: "z" }] });
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: "A summary of findings." })],
        ["claude", fields({ summary: "Another summary of findings." })],
      ]),
      2,
      "q",
      results
    );

    expect(result.attributedBiases).toEqual([]);
    expect(result.panelBlindSpots).toHaveLength(1);
  });
});

describe("buildBiasBlindspotAuditResult — shared assumptions and stakeholders", () => {
  afterEach(() => jest.clearAllMocks());

  it("deduplicates near-duplicate shared assumptions", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ sharedAssumptions: ["All panelists assume stable interest rates"] })],
        ["claude", fields({ sharedAssumptions: ["The panel assumes stable interest rates"] })],
      ]),
      2,
      "q",
      results
    );
    expect(result.sharedAssumptions).toHaveLength(1);
  });

  it("keeps materially distinct missing stakeholders separate", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([["chatgpt", fields({ missingStakeholders: ["Renters", "Small business owners"] })]]),
      1,
      "q",
      results
    );
    expect(result.missingStakeholders).toEqual(["Renters", "Small business owners"]);
  });
});

describe("buildBiasBlindspotAuditResult — Tier 3 (structural diagnostics)", () => {
  afterEach(() => jest.clearAllMocks());

  it("computes citation coverage correctly", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ sources: ["Federal Reserve report"] })],
        ["claude", fields()],
      ]),
      2,
      "q",
      results
    );
    expect(result.structuralDiagnostics.citationCoverage).toEqual({ modelsWithSources: 1, totalModels: 2, ratio: 0.5 });
  });

  it("keeps source concentration separate from geographic bias concerns", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        [
          "chatgpt",
          fields({
            sourceConcentrationConcerns: ["All sources are from the same research group"],
            geographicBiases: ["Analysis is US-centric"],
          }),
        ],
      ]),
      1,
      "q",
      results
    );
    expect(result.structuralDiagnostics.sourceConcentrationConcerns).toEqual(["All sources are from the same research group"]);
    expect(result.structuralDiagnostics.geographicBiasConcerns).toEqual(["Analysis is US-centric"]);
  });

  it("computes source concentration ratio from cited sources", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt", "claude", "grok"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ sources: ["Federal Reserve report"] })],
        ["claude", fields({ sources: ["Federal Reserve report"] })],
        ["grok", fields({ sources: ["World Bank data"] })],
      ]),
      3,
      "q",
      results
    );
    expect(result.structuralDiagnostics.sourceConcentration).toEqual({
      distinctSources: 2,
      totalCitations: 3,
      concentrationRatio: 2 / 3,
    });
  });

  it("flags homogeneity when models' summaries are near-identical, above threshold", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt", "claude", "grok", "perplexity"]);
    const identical = "Inflation is primarily driven by demand-side pressures in this period.";
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: identical })],
        ["claude", fields({ summary: identical })],
        ["grok", fields({ summary: identical })],
        ["perplexity", fields({ summary: identical })],
      ]),
      4,
      "q",
      results
    );
    expect(result.structuralDiagnostics.homogeneityFlag).toBe(true);
    expect(result.structuralDiagnostics.homogeneityMessage).toMatch(/not independent verification/);
  });

  it("does not flag homogeneity on genuinely mixed agreement", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: "Inflation is primarily driven by demand-side pressures." })],
        ["claude", fields({ summary: "Rising energy costs are the dominant explanation this cycle." })],
      ]),
      2,
      "q",
      results
    );
    expect(result.structuralDiagnostics.homogeneityFlag).toBe(false);
  });

  it("Tier 3 renders (has real diagnostics) even when Tier 1 and Tier 2 are both empty", async () => {
    mockTierCalls({ biasFindings: [], coverageGaps: [] });
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ sources: ["A report"] })],
        ["claude", fields()],
      ]),
      2,
      "q",
      results
    );
    expect(result.attributedBiases).toEqual([]);
    expect(result.panelBlindSpots).toEqual([]);
    expect(result.structuralDiagnostics.citationCoverage.modelsWithSources).toBe(1);
  });
});

describe("buildBiasBlindspotAuditResult — producer canonicalization (absent vs. explicit-undefined own-property)", () => {
  afterEach(() => jest.clearAllMocks());

  it("omits sourceConcentration and homogeneityMessage as genuinely absent keys when no model cites sources / summaries aren't homogeneous", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ summary: "Inflation is primarily driven by demand-side pressures." })],
        ["claude", fields({ summary: "Rising energy costs are the dominant explanation this cycle." })],
      ]),
      2,
      "q",
      results
    );
    expect(Object.prototype.hasOwnProperty.call(result.structuralDiagnostics, "sourceConcentration")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.structuralDiagnostics, "homogeneityMessage")).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(result.structuralDiagnostics)))).not.toEqual(
      expect.arrayContaining(["sourceConcentration", "homogeneityMessage"])
    );
  });

  it("preserves sourceConcentration and homogeneityMessage as real own-properties when sources are cited / homogeneity is flagged", async () => {
    mockTierCalls();
    const identical = "Inflation is primarily driven by demand-side pressures in this period.";
    const results = rawResults(["chatgpt", "claude", "grok", "perplexity"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ sources: ["Federal Reserve report"], summary: identical })],
        ["claude", fields({ sources: ["Federal Reserve report"], summary: identical })],
        ["grok", fields({ summary: identical })],
        ["perplexity", fields({ summary: identical })],
      ]),
      4,
      "q",
      results
    );
    expect(Object.prototype.hasOwnProperty.call(result.structuralDiagnostics, "sourceConcentration")).toBe(true);
    expect(result.structuralDiagnostics.sourceConcentration).toEqual({ distinctSources: 1, totalCitations: 2, concentrationRatio: 1 });
    expect(Object.prototype.hasOwnProperty.call(result.structuralDiagnostics, "homogeneityMessage")).toBe(true);
    expect(result.structuralDiagnostics.homogeneityMessage).toMatch(/not independent verification/);
  });
});

describe("buildBiasBlindspotAuditResult — coverage denominator and malformed input", () => {
  afterEach(() => jest.clearAllMocks());

  it("keeps failed models in the totalModels denominator", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt"]);
    const result = await buildBiasBlindspotAuditResult(perModel([["chatgpt", fields({ sources: ["x"] })]]), 3, "q", results);
    expect(result.structuralDiagnostics.citationCoverage.totalModels).toBe(3);
    expect(result.totalModels).toBe(3);
  });

  it("never throws and returns an empty-but-valid result when no model produced usable data", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult([], 2, "q", []);
    expect(result.attributedBiases).toEqual([]);
    expect(result.panelBlindSpots).toEqual([]);
    expect(result.sharedAssumptions).toEqual([]);
    expect(result.structuralDiagnostics.homogeneityFlag).toBe(false);
    expect(result.totalModels).toBe(2);
  });
});

describe("buildBiasBlindspotAuditResult — sources (Phase 10D.1)", () => {
  afterEach(() => jest.clearAllMocks());

  it("preserves every model's own sources, exact-string deduplicated, independent of Tier 3's citation-COUNT diagnostics", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt", "claude"]);
    const result = await buildBiasBlindspotAuditResult(
      perModel([
        ["chatgpt", fields({ sources: ["https://example.com/a", "World Bank data"] })],
        ["claude", fields({ sources: ["https://example.com/a", "https://example.com/b"] })],
      ]),
      2,
      "q",
      results
    );
    expect(result.sources).toEqual(["https://example.com/a", "World Bank data", "https://example.com/b"]);
  });

  it("is an empty array when no model cited a source", async () => {
    mockTierCalls();
    const results = rawResults(["chatgpt"]);
    const result = await buildBiasBlindspotAuditResult(perModel([["chatgpt", fields()]]), 1, "q", results);
    expect(result.sources).toEqual([]);
  });

  it("is an empty array for a totally empty perModel input", async () => {
    mockTierCalls();
    const result = await buildBiasBlindspotAuditResult([], 2, "q", []);
    expect(result.sources).toEqual([]);
  });
});
