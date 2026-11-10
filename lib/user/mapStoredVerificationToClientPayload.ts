/**
 * User-facing server utilities: history payloads and cross-feature mappers.
 */

import type { ClaimVerificationClientPayload, ClaimVerificationSourceResearch } from "@/lib/verification/claimVerificationClientPayload";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";
import { storedVerificationConsensusIndependence } from "@/lib/panel/storedVerificationIndependence";

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
    // C-b (CB-04): the row's recorded execution facts, as stored (only when recorded), so a client surface can state
    // counts through the shared gate (claimPresentedIndependence). Never inferred or completed.
    ...(m.substituted === true ? { substituted: true as const } : {}),
    ...(typeof m.provider === "string" ? { provider: m.provider } : {}),
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

  // Slot counts (rows with a usable verdict), not model counts: a client states a model count only through the shared
  // gate (C-b CB-04 / CB-06).
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
    // Presentation only: whether the stored score may be shown as a multi-model consensus (stored data unchanged).
    modelIndependence: storedVerificationConsensusIndependence(data as unknown as Record<string, unknown>),
    ...(options ? { sourceResearch: options.sourceResearch } : {}),
  };
}
