/**
 * Adaptive Research Export, Phase 1 — PDF structural content tests.
 * Walks the react-pdf element tree directly (see testUtils.ts) rather than
 * re-parsing generated PDF bytes or doing pixel-perfect snapshots.
 */

import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { extractPdfElementText } from "./testUtils";

// @react-pdf/renderer ships ESM-only compiled output (import.meta-free but
// still `import`/`export` syntax) that ts-jest's commonjs transform can't
// load from node_modules. The real package exports Document/Page/View/Text
// as plain string tags (confirmed: `require("@react-pdf/renderer").View ===
// "VIEW"`) — this mock reproduces exactly that shape so
// AdaptiveResearchDocument.tsx's JSX compiles to the same element tree
// shape extractPdfElementText already knows how to walk, with no real PDF
// rendering involved (this test never generates actual PDF bytes).
jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";

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
    format: "pdf",
    artifactStatus: "generating",
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
        synthesisReport: {
          unifiedAnswer: "Panel could not converge on a reliable answer.",
          panelVerdict: "x",
          gate: "caution",
          runCertainty: 0.5,
          whereModelsAgree: [],
          whereModelsDisagree: [],
          certaintyAssessment: "x",
          narrativeSections: [],
          executiveSummary: "x",
          disagreements: [],
          biasAndBlindSpots: [],
          biasEmptyReason: "insufficient_models",
          panelCoverageGaps: [],
          diagnostics: { citedClaimCount: 0, totalClaimCount: 0, evidenceMix: { empirical: 0, theoretical: 0, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.5 },
          verdictCard: {
            question: "q",
            topConsensus: "Forward Revenue Multiple",
            consensusModelCount: 1,
            keyDisagreement: null,
            disagreementDetail: null,
            disagreementModelCount: 0,
            caveat: null,
            recommendedNextSteps: [],
          },
          degraded: false,
        },
        modelResponses: [
          { modelId: "chatgpt" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "GPT thesis", metrics: [{ label: "P/E", value: 18, unit: "x", asOf: "2026", source: "10-K" }] } },
          { modelId: "claude" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "Claude thesis", metrics: [{ label: "P/E", value: 22, unit: "x", asOf: "2026", source: "10-K" }] } },
        ],
      },
    },
  });
}

describe("AdaptiveResearchDocument — cover, status, provenance (shared across both families)", () => {
  it("includes report type, question, report version, export ID", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: baseRecord() }));
    expect(text).toContain("Comparison Report");
    expect(text).toContain("Test question?");
    expect(text).toMatch(/Report version\s*v\s*1/);
    expect(text).toContain("exp-test-1");
  });

  it("includes the consensus/source-grounding semantic safeguard disclaimer (Part 8) — never omitted", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: baseRecord() }));
    expect(text).toMatch(/not factual correctness/i);
    expect(text).toMatch(/not evidence\s*\nstrength|not evidence strength/i);
  });

  it("provenance block includes run ID, export ID, schema, and the frozen-snapshot notice — never a live pointer implied", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: baseRecord() }));
    expect(text).toContain("run-test-1");
    expect(text).toContain("exp-test-1");
    expect(text).toContain("comparison_matrix");
    expect(text).toMatch(/Generated with ConvergePanel/);
    expect(text).toMatch(/frozen snapshot/i);
  });

  it("never includes a private reviewer comment field — the composer has no comment-rendering code path at all", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: baseRecord() }));
    expect(text).not.toMatch(/reviewer comment/i);
  });

  it("never leaks a raw '[object Object]' artifact for nested object-array fields", () => {
    const record = baseRecord({
      schemaFamily: "legacy",
      schemaId: "legal_regulatory",
      reportSnapshot: {
        ...baseRecord().reportSnapshot,
        legacy: {
          schemaId: "legal_regulatory",
          alignedClaims: [],
          modelResponses: [
            {
              modelId: "chatgpt" as any,
              schemaId: "legal_regulatory",
              ok: true,
              data: {
                unsettledIssues: [
                  {
                    id: "x",
                    claim: "Some claim",
                    stance: "disputes",
                    confidence: "contested",
                    evidenceType: "authoritative",
                    camps: [{ label: "A", position: "pos A" }, { label: "B", position: "pos B" }],
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).not.toMatch(/\[object Object\]/);
    expect(text).toContain("pos A");
  });
});

describe("AdaptiveResearchDocument — governance status representation (Part 9)", () => {
  it.each([
    ["approved", /Reviewed and approved/],
    ["approved_with_conditions", /Reviewed with conditions/],
    ["changes_requested", /Changes requested/],
    ["rejected", /Rejected/],
    ["unreviewed_in_queue", /Unreviewed — in queue/],
    ["incomplete", /Incomplete/],
  ] as const)("Milestone-2 status '%s' renders its own distinct label, never collapsed into another status", (kind, expected) => {
    const record = baseRecord({ governanceStatusAtExport: { family: "milestone2", kind, isOwnerOverride: false } });
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).toMatch(expected);
  });

  it("changes_requested is never rendered as 'Rejected' or 'Reviewed and approved'", () => {
    const record = baseRecord({ governanceStatusAtExport: { family: "milestone2", kind: "changes_requested", isOwnerOverride: false } });
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).not.toMatch(/\bRejected\b/);
    expect(text).not.toMatch(/Reviewed and approved/);
  });

  it("owner override is shown combined with its real underlying status, not as a separate opaque state", () => {
    const record = baseRecord({ governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: true } });
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).toMatch(/Owner override — Reviewed and approved/);
  });

  it.each([
    ["approved", /Reviewed and approved/],
    ["needs_review", /Needs review/],
    ["blocked", /Blocked by policy/],
    [null, /Not yet evaluated/],
  ] as const)("legacy family status '%s' uses its own real 3-value vocabulary, never the 8-status Milestone-2 labels", (status, expected) => {
    const record = baseRecord({
      schemaFamily: "legacy",
      schemaId: "financial_valuation",
      governanceStatusAtExport: { family: "legacy", status },
      reportSnapshot: {
        ...baseRecord().reportSnapshot,
        milestone2: undefined,
        legacy: { schemaId: "financial_valuation", alignedClaims: [], modelResponses: [] },
      },
    });
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).toMatch(expected);
  });
});

describe("AdaptiveResearchDocument — Milestone-2 primary content", () => {
  it("renders decisionReceipt fields when present: conclusion, basis, assumptions, uncertainties, limitations, sources", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: baseRecord() }));
    expect(text).toContain("Test conclusion text.");
    expect(text).toContain("Basis item A");
    expect(text).toContain("Assumption A");
    expect(text).toContain("Uncertainty A");
    expect(text).toContain("Limitation A");
    expect(text).toContain("Source A");
  });

  it("comparison_matrix gets the trade-offs/best-use-recommendations enrichment on top of the shared decisionReceipt shape", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: baseRecord() }));
    expect(text).toContain("Trade-off A");
    expect(text).toContain("Use case A");
  });

  it("never fabricates a decisionReceipt when none exists — shows an honest 'not reviewed' notice instead", () => {
    const record = baseRecord({
      reportSnapshot: {
        ...baseRecord().reportSnapshot,
        milestone2: { schemaId: "comparison_matrix", result: {}, meta: {} as any, decisionReceipt: undefined },
      },
    });
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).toMatch(/no governance record exists/i);
    expect(text).not.toContain("Test conclusion text.");
  });
});

describe("AdaptiveResearchDocument — legacy primary content", () => {
  it("renders the panel conclusion from synthesisReport.unifiedAnswer", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: legacyBase() }));
    expect(text).toContain("Panel could not converge on a reliable answer.");
  });

  it("preserves each model's own metric value side by side — never averaged into one number", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: legacyBase() }));
    expect(text).toMatch(/18/);
    expect(text).toMatch(/22/);
    expect(text).not.toMatch(/\b20\b\s*x/);
  });

  it("both models' theses remain distinct and attributed", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: legacyBase() }));
    expect(text).toContain("GPT thesis");
    expect(text).toContain("Claude thesis");
  });

  it("creative_generative (no synthesisReport): never fabricates a panel conclusion, shows the honest no-consensus notice instead", () => {
    const record = legacyBase();
    record.schemaId = "creative_generative";
    record.reportSnapshot.reportTypeLabel = "Creative Output";
    record.reportSnapshot.consensusLevel = "unscored";
    record.reportSnapshot.sourceGroundingLevel = "unscored";
    record.reportSnapshot.legacy = {
      schemaId: "creative_generative",
      alignedClaims: [],
      modelResponses: [{ modelId: "chatgpt" as any, schemaId: "creative_generative", ok: true, data: { output: "A whimsical tagline." } }],
    };
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).toMatch(/does not produce a single synthesized panel conclusion/i);
    expect(text).not.toMatch(/models agree/i);
    expect(text).not.toMatch(/models disagree/i);
    expect(text).toContain("Not scored");
    expect(text).toContain("A whimsical tagline.");
  });
});

describe("AdaptiveResearchDocument — security (Part 18)", () => {
  it("HTML/script content in model output renders as literal text — react-pdf's <Text> never interprets its children as markup, so this is a structural property, not sanitization applied here", () => {
    const record = legacyBase();
    record.reportSnapshot.legacy!.synthesisReport!.unifiedAnswer = '<script>alert(1)</script> <img src=x onerror=alert(2)>';
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).thesis = "<b onmouseover=alert(3)>bold thesis</b>";
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).toContain("<b onmouseover=alert(3)>bold thesis</b>");
  });

  it("an extremely long field value does not crash generation — renders in full rather than silently truncating", () => {
    const record = legacyBase();
    const huge = "x".repeat(50_000);
    (record.reportSnapshot.legacy!.modelResponses![0].data as any).thesis = huge;
    expect(() => extractPdfElementText(AdaptiveResearchDocument({ record }))).not.toThrow();
    const text = extractPdfElementText(AdaptiveResearchDocument({ record }));
    expect(text).toContain(huge);
  });

  it("a large number of model responses does not crash generation (resource-exhaustion smoke check)", () => {
    const record = legacyBase();
    record.reportSnapshot.legacy!.modelResponses = Array.from({ length: 50 }, (_, i) => ({
      modelId: "chatgpt" as any,
      schemaId: "financial_valuation" as const,
      ok: true,
      data: { thesis: `Thesis ${i}`, metrics: [{ label: "P/E", value: i, unit: "x", asOf: "2026", source: "10-K" }] },
    }));
    expect(() => extractPdfElementText(AdaptiveResearchDocument({ record }))).not.toThrow();
  });
});
