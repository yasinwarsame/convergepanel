/**
 * User-facing server utilities: history payloads and cross-feature mappers.
 */

import type { ClaimVerificationClientPayload, ClaimVerificationSourceResearch } from "@/lib/verification/claimVerificationClientPayload";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";

/**
 * Rebuilds the client verification payload from a Firestore `verifications` document.
 * Used by history / detail APIs (server-only).
 *
 * Phase 11A.5B — `options.sourceResearch`, when the THIRD ARGUMENT IS
 * SUPPLIED AT ALL, is spliced into the returned payload verbatim (object
 * or `null`); when the third argument is omitted entirely, the returned
 * payload has no `sourceResearch` key at all, preserving this function's
 * pre-11A.5B behavior exactly for every existing/other caller. This
 * function remains pure and performs no I/O of its own — the caller is
 * responsible for having already authorized and resolved
 * `sourceResearch` (see resolvePersonalSourceResearchLink()) before
 * calling this mapper.
 */
export function mapStoredVerificationToClientPayload(
  data: ClaimVerificationFirestoreDoc,
  verificationId: string,
  options?: { sourceResearch: ClaimVerificationSourceResearch | null }
): ClaimVerificationClientPayload {
  const modelEvidence = (data.modelResults ?? []).map((m) => ({
    modelId: m.modelId,
    status: m.status,
    verdict: m.verdict,
    confidence: m.confidence,
    summary: m.summary,
    correctParts: m.correctParts ?? [],
    incorrectParts: m.incorrectParts ?? [],
    unverifiableParts: m.unverifiableParts ?? [],
  }));

  const digest = buildAgreementDisagreementDigest(
    modelEvidence.map((m) => ({
      modelId: m.modelId,
      correctParts: m.correctParts,
      incorrectParts: m.incorrectParts,
    }))
  );

  const aggregateSummary = {
    totalModels: modelEvidence.length,
    modelsAgreeAccurate: modelEvidence.filter((m) => m.verdict === "accurate").length,
    modelsAgreeInaccurate: modelEvidence.filter((m) => m.verdict === "inaccurate").length,
    modelsPartial: modelEvidence.filter((m) => m.verdict === "partially_accurate").length,
    modelsUnverifiable: modelEvidence.filter((m) => {
      const v = m.verdict;
      return v === "unverifiable" || v === "parse_error" || v === "failed";
    }).length,
  };

  const usableForBanner = modelEvidence.filter((m) => m.status === "ok");

  return {
    verificationId,
    claim: data.claim,
    verdict: data.verdict,
    consensusScore: data.consensusScore,
    confidenceLabel: data.confidenceLabel,
    evidenceQuality: data.evidenceQuality ?? "mixed",
    supportRatio: data.supportRatio,
    modelEvidence,
    aggregateSummary,
    whereModelsAgree: digest.whereModelsAgree,
    whereModelsDisagree: digest.whereModelsDisagree,
    auditBundle: data.auditBundle,
    accurateAmongUsable: usableForBanner.filter((m) => m.verdict === "accurate").length,
    usableModelCount: usableForBanner.length,
    ...(data.governanceStatus === "approved" ||
    data.governanceStatus === "needs_review" ||
    data.governanceStatus === "blocked"
      ? { governanceStatus: data.governanceStatus }
      : {}),
    ...(options ? { sourceResearch: options.sourceResearch } : {}),
  };
}
