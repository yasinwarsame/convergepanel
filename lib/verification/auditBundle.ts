/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { ClaimVerdict } from "./claimVerdict";

export type AuditBundle = {
  version: "1";
  kind: "claim_verification";
  claimCharCount: number;
  modelCount: number;
  verdict: ClaimVerdict;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  perModel: Array<{
    modelId: string;
    pipelineStatus: "ok" | "parse_error" | "failed";
    /** null when pipeline did not produce a parsed verdict (Firestore-safe). */
    verdictLabel: string | null;
    confidence: string | null;
    summaryLength: number;
    counts: { correct: number; incorrect: number; unverifiable: number };
  }>;
  generatedAt: string;
};

export function buildClaimVerificationAuditBundle(input: {
  claimLength: number;
  modelEvidence: Array<{
    modelId: string;
    status: "ok" | "parse_error" | "failed";
    verdict: string;
    confidence: string;
    summary: string;
    correctParts: string[];
    incorrectParts: string[];
    unverifiableParts: string[];
  }>;
  verdict: ClaimVerdict;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
}): AuditBundle {
  return {
    version: "1",
    kind: "claim_verification",
    claimCharCount: input.claimLength,
    modelCount: input.modelEvidence.length,
    verdict: input.verdict,
    consensusScore: input.consensusScore,
    confidenceLabel: input.confidenceLabel,
    evidenceQuality: input.evidenceQuality,
    perModel: input.modelEvidence.map((m) => ({
      modelId: m.modelId,
      pipelineStatus: m.status,
      verdictLabel: m.status === "ok" ? (m.verdict?.trim() ? m.verdict : null) : null,
      confidence: m.status === "ok" ? (m.confidence?.trim() ? m.confidence : null) : null,
      summaryLength: m.summary.length,
      counts: {
        correct: m.correctParts.length,
        incorrect: m.incorrectParts.length,
        unverifiable: m.unverifiableParts.length,
      },
    })),
    generatedAt: new Date().toISOString(),
  };
}

/** Deep check: ensure no raw model completion text slipped into audit JSON. */
export function auditBundleHasNoRawModelText(bundle: AuditBundle): boolean {
  const s = JSON.stringify(bundle);
  if (s.includes("rawText") || s.includes("rawResponse")) return false;
  // Heuristic: no huge string blobs (audit uses lengths only)
  if (s.length > 8000) return false;
  return true;
}
