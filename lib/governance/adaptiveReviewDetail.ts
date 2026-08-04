/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — the adaptive
 * review-DETAIL response contract (docs/governance-decision-receipts-design.md
 * §25). Read-only: this is the data source for a future Part E2 decision
 * form, not a mutation contract. Entirely pure — building the response
 * object from an already-validated `GovernanceRecordV1`; no I/O.
 */

import { AnswerShape } from "../adaptiveSchema/types";
import { GovernanceRecordV1 } from "../adaptiveSchema/governanceRecord";
import { PersistedAdaptiveSchemaId } from "../adaptiveSchema/persistedOutput";
import { isHumanReviewStatusReviewable } from "../adaptiveSchema/governanceRecordParser";

export type AdaptiveReviewDetailResponseV1 = {
  ok: true;
  version: 1;

  review: {
    runId: string;

    schemaId: PersistedAdaptiveSchemaId;
    answerShape: AnswerShape;

    decisionReceipt: {
      conclusion: string;
      basis: string[];
      assumptions: string[];
      uncertainties: string[];
      limitations: string[];
      sourceBacked: boolean;
      humanReviewNeeded: boolean;
    };

    automatedGovernance?: {
      status: "passed" | "flagged" | "blocked" | "not_evaluated" | "error";
      evaluatedAt?: string;
      policyVersion?: number;
    };

    humanReview: {
      status: "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
      reviewedAt?: string;
    };

    reviewable: boolean;
    updatedAt: string;
  };
};

/**
 * Builds the compact detail response from an already-validated,
 * `"valid"`-parsed `GovernanceRecordV1` — the caller (the route) is
 * responsible for having confirmed this via `parseGovernanceRecord()`
 * first. Never includes `reviewerId`/`reviewerName`/`comment`/`conditions`/
 * `sources`/raw question/model output/automated-governance `reasons`/
 * policy internals/parser reasons/`teamId`/`userId`/the projection ID —
 * none of those are read from `record` at all.
 */
export function buildAdaptiveReviewDetailResponse(runId: string, record: GovernanceRecordV1): AdaptiveReviewDetailResponseV1 {
  return {
    ok: true,
    version: 1,
    review: {
      runId,
      schemaId: record.schemaId as PersistedAdaptiveSchemaId,
      answerShape: record.answerShape,
      decisionReceipt: {
        conclusion: record.decisionReceipt.conclusion,
        basis: record.decisionReceipt.basis,
        assumptions: record.decisionReceipt.assumptions,
        uncertainties: record.decisionReceipt.uncertainties,
        limitations: record.decisionReceipt.limitations,
        sourceBacked: record.decisionReceipt.sourceBacked,
        humanReviewNeeded: record.decisionReceipt.humanReviewNeeded,
      },
      automatedGovernance: record.automatedGovernance
        ? {
            status: record.automatedGovernance.status,
            evaluatedAt: record.automatedGovernance.evaluatedAt,
            policyVersion: record.automatedGovernance.policyVersion,
          }
        : undefined,
      humanReview: {
        status: record.humanReview.status,
        reviewedAt: record.humanReview.reviewedAt,
      },
      reviewable: isHumanReviewStatusReviewable(record.humanReview.status),
      updatedAt: record.updatedAt,
    },
  };
}
