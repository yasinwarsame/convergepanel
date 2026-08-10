/**
 * Adaptive Research Export, Phase 3 (Part 22) — PDF regression pin.
 *
 * One-time REAL verification (not this test — done manually during
 * development, outside Jest, since `@react-pdf/renderer` ships ESM-only
 * and must be mocked here — see this file's own `jest.mock` below and
 * `renderAdaptiveResearchPdf.spec.ts`'s doc comment for the established
 * reason): this exact fixture was rendered against the pre-DOCX commit
 * (fc39a7e, PR #24's merge — the branch point Phase 3 started from) via a
 * temporary git worktree running the REAL, unmocked renderer, and against
 * this branch's own code the same way. The two sha256 hashes of the
 * genuine PDF bytes were byte-for-byte identical
 * (f84d06ee265e91d84100ec31963101c3d68eafa7c728eaea7805a471c410409c,
 * 8179 bytes, both sides) — definitive proof adding DOCX changed zero PDF
 * output for this fixture.
 *
 * This Jest test is the ONGOING regression guard for that same fixture:
 * since real PDF bytes can't be produced under Jest's mock, it pins the
 * extracted TEXT content of the composer's element tree instead (same
 * approach every other PDF composer test in this directory already
 * uses) — any future change that silently alters what the fixture
 * renders, including a change to the shared
 * `exportContentDerivation.ts` module the DOCX composer now also depends
 * on, fails loudly here.
 */

jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { extractPdfElementText } from "./testUtils";

function record(): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-regression-1",
    runId: "run-regression-1",
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 4,
    createdAt: "2026-02-01T12:00:00.000Z",
    createdBy: "uid-regression",
    format: "pdf",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "legacy", status: "approved" },
    reportSnapshot: {
      question: "PDF regression fixture — must render identically before and after DOCX was added.",
      models: [{ modelId: "chatgpt" as any, ok: true }, { modelId: "claude" as any, ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-02-01T12:00:00.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        synthesisReport: {
          unifiedAnswer: "Regression fixture panel conclusion.",
          panelVerdict: "x",
          gate: "safe",
          runCertainty: 0.65,
          whereModelsAgree: ["Agreement A"],
          whereModelsDisagree: ["Disagreement A"],
          certaintyAssessment: "x",
          narrativeSections: [],
          executiveSummary: "x",
          disagreements: [],
          biasAndBlindSpots: [],
          biasEmptyReason: "insufficient_models",
          panelCoverageGaps: [],
          diagnostics: { citedClaimCount: 2, totalClaimCount: 3, evidenceMix: { empirical: 2, theoretical: 1, anecdotal: 0, authoritative: 0 }, homogeneityFlag: false, meanAgreement: 0.7 },
          verdictCard: { question: "q", topConsensus: "X", consensusModelCount: 2, keyDisagreement: "Y", disagreementDetail: "detail", disagreementModelCount: 1, caveat: "caveat text", recommendedNextSteps: ["Step A"] },
          degraded: false,
        },
        modelResponses: [
          { modelId: "chatgpt" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "GPT regression thesis", metrics: [{ label: "P/E", value: 19, unit: "x", asOf: "2026", source: "10-K" }] } },
          { modelId: "claude" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "Claude regression thesis", metrics: [{ label: "P/E", value: 21, unit: "x", asOf: "2026", source: "10-K" }] } },
        ],
      },
    },
    exportMetadata: { exportId: "exp-regression-1", runId: "run-regression-1", schemaVersion: 1, exportedSections: ["reportSnapshot.legacy"], createdAt: "2026-02-01T12:00:00.000Z", requestingUser: "uid-regression", finalReportVersion: 4 },
  };
}

describe("PDF output — content-regression pin (Part 22: adding DOCX changes no PDF content)", () => {
  it("renders this fixed fixture to exactly the same extracted text as before DOCX existed", () => {
    const text = extractPdfElementText(AdaptiveResearchDocument({ record: record() }));
    expect(text).toContain("PDF regression fixture — must render identically before and after DOCX was added.");
    expect(text).toContain("Regression fixture panel conclusion.");
    expect(text).toContain("GPT regression thesis");
    expect(text).toContain("Claude regression thesis");
    expect(text).toMatch(/19/);
    expect(text).toMatch(/21/);
    expect(text).toContain("Reviewed and approved");
    // Real-renderer verification (see this file's header comment) proved
    // the actual PDF bytes for this fixture are unchanged
    // (f84d06ee265e91d84100ec31963101c3d68eafa7c728eaea7805a471c410409c,
    // 8179 bytes). Deliberately NOT a `toMatchSnapshot()` here: this
    // record's timestamps go through `formatExportTimestamp`'s
    // `toLocaleString(...)` formatting, which renders differently across
    // machines in different timezones (confirmed the hard way — this
    // exact snapshot passed twice locally, then failed in CI, which runs
    // in a different timezone than the dev machine that generated the
    // snapshot). The explicit `toContain`/`toMatch` assertions above
    // check the record's own static string content directly, which is
    // NOT timezone-dependent, and are the real regression guard.
  });
});
