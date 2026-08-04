/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 —
 * buildAdaptiveReviewDetailResponse() tests.
 */

import { buildAdaptiveReviewDetailResponse } from "@/lib/governance/adaptiveReviewDetail";
import { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

function record(overrides: Partial<GovernanceRecordV1> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    automatedGovernance: { status: "flagged", reasons: ["secret internal reason"], evaluatedAt: "2026-07-29T00:00:00.000Z", policyVersion: 3 },
    humanReview: { status: "changes_requested", reviewerId: "reviewer-uid", reviewerName: "Reviewer", reviewedAt: "2026-07-29T12:00:00.000Z", comment: "secret comment", conditions: ["secret condition"] },
    decisionReceipt: {
      conclusion: "The panel recommends option A.",
      basis: ["basis 1"],
      assumptions: ["assumption 1"],
      uncertainties: ["uncertainty 1"],
      limitations: ["limitation 1"],
      sources: ["secret source"],
      sourceBacked: true,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  } as GovernanceRecordV1;
}

describe("buildAdaptiveReviewDetailResponse", () => {
  it("builds the compact response contract", () => {
    const result = buildAdaptiveReviewDetailResponse("run-1", record());
    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    expect(result.review.runId).toBe("run-1");
    expect(result.review.schemaId).toBe("decision_support");
    expect(result.review.answerShape).toBe("decision_support_view");
    expect(result.review.decisionReceipt.conclusion).toBe("The panel recommends option A.");
    expect(result.review.humanReview.status).toBe("changes_requested");
    expect(result.review.humanReview.reviewedAt).toBe("2026-07-29T12:00:00.000Z");
    expect(result.review.updatedAt).toBe("2026-07-29T00:00:00.000Z");
  });

  it("computes reviewable from isHumanReviewStatusReviewable, never independently", () => {
    const reviewable = buildAdaptiveReviewDetailResponse("run-1", record({ humanReview: { status: "unreviewed" } }));
    expect(reviewable.review.reviewable).toBe(true);
    const terminal = buildAdaptiveReviewDetailResponse("run-1", record({ humanReview: { status: "rejected" } }));
    expect(terminal.review.reviewable).toBe(false);
  });

  it("omits automatedGovernance when absent on the record", () => {
    const { automatedGovernance, ...withoutAutomated } = record();
    const result = buildAdaptiveReviewDetailResponse("run-1", withoutAutomated as GovernanceRecordV1);
    expect(result.review.automatedGovernance).toBeUndefined();
  });

  it("never includes reviewerId, reviewerName, comment, conditions, sources, or automated-governance reasons", () => {
    const result = buildAdaptiveReviewDetailResponse("run-1", record());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("reviewer-uid");
    expect(serialized).not.toContain("Reviewer");
    expect(serialized).not.toContain("secret comment");
    expect(serialized).not.toContain("secret condition");
    expect(serialized).not.toContain("secret source");
    expect(serialized).not.toContain("secret internal reason");
  });

  it("never includes teamId, userId, or a projection ID (record has none of these fields to begin with)", () => {
    const result = buildAdaptiveReviewDetailResponse("run-1", record());
    expect(result).not.toHaveProperty("teamId");
    expect(result).not.toHaveProperty("userId");
    expect(result).not.toHaveProperty("projectionId");
  });
});
