/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { AuditBundle } from "@/lib/verification/auditBundle";

export type ClaimVerdictUi = "confirmed" | "disputed" | "partially_true" | "unverifiable";

export type ClaimVerificationClientPayload = {
  /** Firestore document id / server verification id (for audit display & export). */
  verificationId?: string;
  claim: string;
  verdict: ClaimVerdictUi;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality?: "strong" | "mixed" | "weak";
  supportRatio?: number;
  modelEvidence: Array<{
    modelId: string;
    status?: "ok" | "parse_error" | "failed";
    verdict: string;
    confidence: string;
    summary: string;
    correctParts: string[];
    incorrectParts: string[];
    unverifiableParts: string[];
  }>;
  aggregateSummary: {
    totalModels: number;
    modelsAgreeAccurate: number;
    modelsAgreeInaccurate: number;
    modelsPartial: number;
    modelsUnverifiable: number;
  };
  whereModelsAgree: string[];
  whereModelsDisagree: Array<{ point: string; models: string[] }>;
  auditBundle: AuditBundle;
  accurateAmongUsable?: number;
  usableModelCount?: number;
  governanceReviewRequired?: boolean;
  blockedByPolicy?: boolean;
  policyBlockMessage?: string;
  policyFlags?: string[];
  /** Org governance evaluation (paid plans). */
  governanceStatus?: "approved" | "needs_review" | "blocked";
};
