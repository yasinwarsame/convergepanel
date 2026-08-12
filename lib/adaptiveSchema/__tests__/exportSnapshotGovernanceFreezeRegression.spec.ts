/**
 * Review & Governance report completion, Part 19 regression — a
 * previously created research export must continue showing the
 * governance status that existed AT EXPORT TIME, even after the live
 * report's governance record later changes. This test doesn't exercise
 * any new production code from this feature — it's a documentation-as-
 * test guard confirming the boundary the rest of this feature promises
 * never to cross: nothing added for live Review & Governance display
 * reaches into, or is derived from, a stored export's frozen
 * `governanceStatusAtExport`.
 */

import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { governanceStatusDisplay } from "@/lib/adaptiveSchema/exportContentDerivation";
import { applyHumanReviewUpdate } from "@/lib/adaptiveSchema/governanceRecordParser";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import { PersistedAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import { QueryClassification } from "@/lib/adaptiveSchema/types";
import { ModelId } from "@/lib/types";

function classification(overrides: Partial<QueryClassification> = {}): QueryClassification {
  return {
    queryType: "comparison_matrix",
    domain: "test",
    answerShape: "comparison_grid",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence: 0.9,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: "test",
    ...overrides,
  };
}

function milestone2Output(): PersistedAdaptiveOutputV1 {
  return {
    version: 1,
    schemaId: "comparison_matrix",
    answerShape: "comparison_grid",
    classification: classification(),
    meta: {
      schemaVersion: 1,
      queryType: "comparison_matrix",
      answerShape: "comparison_grid",
      dataBasis: "mixed",
      freshness: "timeless",
      riskLevel: "professional",
      evidenceQuality: "moderate",
      uncertainties: [],
      blindSpots: [],
      humanReviewNeeded: false,
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    generatedAt: "2026-01-01T00:00:00.000Z",
    result: { subjects: [], attributes: [], cells: [], totalModels: 2, lowConfidenceSubjects: [], lowConfidenceAttributes: [], hasVerifiedSourceData: false },
  };
}

function approvedGovernanceRecord(): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "comparison_matrix",
    answerShape: "comparison_grid",
    adaptiveOutputVersion: 1,
    humanReview: { status: "approved", reviewerId: "reviewer-1", reviewedAt: "2026-08-12T10:00:00.000Z" },
    decisionReceipt: {
      conclusion: "c",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
  };
}

describe("Export governance freeze — Part 19 regression", () => {
  it("a stored export's governanceStatusAtExport is unaffected by a later live status change", () => {
    const liveRecord = approvedGovernanceRecord();

    const exportedAtApproval = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt", "claude"] as ModelId[],
      milestone2: { output: milestone2Output(), governanceRecord: liveRecord },
    });
    expect(exportedAtApproval.governanceStatusAtExport).toEqual({ family: "milestone2", kind: "approved", isOwnerOverride: false });

    // Build the minimal AdaptiveResearchExportV1-shaped frozen record the
    // display function actually reads — only governanceStatusAtExport
    // matters here.
    const frozenExport = { governanceStatusAtExport: exportedAtApproval.governanceStatusAtExport } as AdaptiveResearchExportV1;
    expect(governanceStatusDisplay(frozenExport)).toEqual({ label: "Reviewed and approved", tone: "success" });

    // The live report is later rejected — a genuinely new, independent
    // GovernanceRecordV1 object, never mutating `liveRecord` in place
    // (applyHumanReviewUpdate is pure, matching its own contract).
    const rejectedResult = applyHumanReviewUpdate(liveRecord, { status: "rejected", reviewerId: "reviewer-2" }, "2026-08-12T11:00:00.000Z");
    expect(rejectedResult.ok).toBe(true);
    if (!rejectedResult.ok) throw new Error("unreachable");
    const liveRecordAfterRejection = rejectedResult.record;

    // The ORIGINAL frozen export must still read exactly as it did at
    // export time — never re-derived, never mutated by the live change.
    expect(governanceStatusDisplay(frozenExport)).toEqual({ label: "Reviewed and approved", tone: "success" });
    expect(frozenExport.governanceStatusAtExport).toEqual({ family: "milestone2", kind: "approved", isOwnerOverride: false });

    // A NEW export taken now correctly reflects the new live state —
    // proving the freeze is real (not just "nothing ever changes") and
    // that the two snapshots are genuinely independent objects.
    const exportedAfterRejection = buildExportSnapshot({
      question: "q",
      selectedModels: ["chatgpt", "claude"] as ModelId[],
      milestone2: { output: milestone2Output(), governanceRecord: liveRecordAfterRejection },
    });
    expect(exportedAfterRejection.governanceStatusAtExport).toEqual({ family: "milestone2", kind: "rejected", isOwnerOverride: false });
    expect(governanceStatusDisplay({ governanceStatusAtExport: exportedAfterRejection.governanceStatusAtExport } as AdaptiveResearchExportV1)).toEqual({
      label: "Rejected",
      tone: "danger",
    });

    // And, once more, the original frozen export is still untouched.
    expect(governanceStatusDisplay(frozenExport)).toEqual({ label: "Reviewed and approved", tone: "success" });
  });
});
