/**
 * The shared claim statement basis (lib/verification/claimVerdictCounts.ts `claimStatementBasis`, owner ruling
 * 2026-11-18 R4) computed from the two shapes a claim verification reaches a surface in:
 *  - a CLIENT payload (live result, Personal / Team detail, copied verdict, memo, history row built from a live result):
 *    `claimPayloadStatementBasis` — the server's `modelIndependence` confirmed by the shared gate over the payload rows;
 *  - a STORED document (governance queue, Team list row, Personal history list): `storedClaimStatementBasis` — the shared
 *    gate over `modelResults` (+ `selectedModels`), exactly as `storedVerificationConsensusIndependence` judges it.
 * Every surface that states anything about models, or presents a consensus score / confidence / support ratio, reads one
 * of these two — there is no per-surface rule. Pure and client-safe; read-time only (nothing is persisted or re-scored).
 */

import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import {
  consensusScoreWithheldReason,
  type ConsensusScoreWithheldReason,
  type StoredConsensusIndependence,
} from "@/lib/panel/independentVoices";
import {
  claimPresentedIndependence,
  claimRowsExecutionIdentity,
  storedVerificationConsensusIndependence,
  storedVerificationIndependentAnswerCount,
} from "@/lib/panel/storedVerificationIndependence";
import {
  claimPayloadSlotTally,
  claimScoreNeedsSlotQualifier,
  claimSlotTally,
  claimStatementBasis,
  type ClaimStatementBasis,
} from "@/lib/verification/claimVerdictCounts";

/** The basis of a client payload: K only for a record presented "independent" whose rows the gate verifies. */
export function claimPayloadStatementBasis(
  data: Pick<ClaimVerificationClientPayload, "modelIndependence" | "modelEvidence" | "auditBundle">
): ClaimStatementBasis {
  const independence = claimPresentedIndependence(data.modelIndependence, data.modelEvidence);
  const identity = claimRowsExecutionIdentity(data.modelEvidence);
  const k = independence === "independent" && identity.verified ? identity.independentModels : null;
  return claimStatementBasis(data.modelEvidence, k, claimPayloadSlotTally(data));
}

/** The basis of a stored `verifications/{id}` document (governance queue, Team list, Personal history list). */
export function storedClaimStatementBasis(data: Record<string, unknown> | null | undefined): ClaimStatementBasis {
  const rows = data && Array.isArray(data.modelResults) ? (data.modelResults as unknown[]) : [];
  const k = storedVerificationConsensusIndependence(data) === "independent" ? storedVerificationIndependentAnswerCount(data) : null;
  return claimStatementBasis(rows, k, claimSlotTally(rows));
}

/**
 * Additive DTO / history marker: "slot_responses" when a stored record's consensus score is PRESENTED (the record is
 * "independent") but its answering slots are not each a distinct identified executing model — the score / confidence
 * must then carry `CLAIM_SCORE_SLOT_BASIS_QUALIFIER`. Undefined otherwise (no score presented, or a valid basis).
 */
export type ClaimConsensusBasis = "slot_responses";

export function storedClaimConsensusBasis(data: Record<string, unknown> | null | undefined): ClaimConsensusBasis | undefined {
  if (storedVerificationConsensusIndependence(data) !== "independent") return undefined;
  return claimScoreNeedsSlotQualifier(storedClaimStatementBasis(data)) ? "slot_responses" : undefined;
}

export function claimPayloadConsensusBasis(
  data: Pick<ClaimVerificationClientPayload, "modelIndependence" | "modelEvidence" | "auditBundle">
): ClaimConsensusBasis | undefined {
  if (claimPresentedIndependence(data.modelIndependence, data.modelEvidence) !== "independent") return undefined;
  return claimScoreNeedsSlotQualifier(claimPayloadStatementBasis(data)) ? "slot_responses" : undefined;
}

/**
 * The score fields of a Personal history row for a stored claim (app/api/user/panel-history/route.ts): the stored score
 * only for an "independent" record (otherwise null + the withheld reason) and, R4, the basis marker.
 */
export function storedClaimHistoryScoreFields(data: Record<string, unknown>): {
  consensusScore: number | null;
  consensusWithheld?: ConsensusScoreWithheldReason;
  modelIndependence: StoredConsensusIndependence;
  consensusBasis?: ClaimConsensusBasis;
} {
  const modelIndependence = storedVerificationConsensusIndependence(data);
  const consensusWithheld = consensusScoreWithheldReason(modelIndependence);
  const consensusBasis = consensusWithheld ? undefined : storedClaimConsensusBasis(data);
  return {
    consensusScore: consensusWithheld ? null : typeof data.consensusScore === "number" ? data.consensusScore : 0,
    ...(consensusWithheld ? { consensusWithheld } : {}),
    modelIndependence,
    ...(consensusBasis ? { consensusBasis } : {}),
  };
}
