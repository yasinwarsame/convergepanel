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

/**
 * R6 owner decisions B1 + B3 — THE explicit basis of a stored claim's consensus score, one value per record:
 *   "independent_models"              >= 2 independent executing models, one distinct identified model per answering slot;
 *   "slot_responses"                  >= 2 independent executing models, but the score is computed over panel slot
 *                                     responses (a model answered more than one slot) — not independent corroboration;
 *   "insufficient_independent_models" fewer than two independent executing models — not a consensus;
 *   "independence_unverified"         the executing models could not be established (no rows, rows without recorded
 *                                     providers, a requested model without a row, or no document) — never inferred.
 * Used as the Team audit export's `consensusBasis` column and as the Personal history item's basis marker (every
 * server-built claim history item carries one, so an item cached before the marker existed is recognisable).
 */
export type ClaimScoreBasis = "independent_models" | "slot_responses" | "insufficient_independent_models" | "independence_unverified";
export const CLAIM_SCORE_BASES: readonly ClaimScoreBasis[] = Object.freeze([
  "independent_models",
  "slot_responses",
  "insufficient_independent_models",
  "independence_unverified",
]);

export function isClaimScoreBasis(value: unknown): value is ClaimScoreBasis {
  return typeof value === "string" && (CLAIM_SCORE_BASES as readonly string[]).includes(value);
}

export function storedClaimScoreBasis(data: Record<string, unknown> | null | undefined): ClaimScoreBasis {
  if (!data) return "independence_unverified";
  const withheld = consensusScoreWithheldReason(storedVerificationConsensusIndependence(data));
  if (withheld) return withheld;
  return storedClaimConsensusBasis(data) === "slot_responses" ? "slot_responses" : "independent_models";
}

/**
 * R6 B3 — a Personal history claim item as the server builds it (app/api/user/panel-history/route.ts): the established
 * score fields plus the explicit basis marker, always present.
 */
export function storedClaimHistoryRowFields(data: Record<string, unknown>): Omit<ReturnType<typeof storedClaimHistoryScoreFields>, "consensusBasis"> & {
  consensusBasis: ClaimScoreBasis;
} {
  const { consensusBasis: _slot, ...fields } = storedClaimHistoryScoreFields(data);
  void _slot;
  return { ...fields, consensusBasis: storedClaimScoreBasis(data) };
}

/**
 * R6 B3 — the basis a live / cached history payload's own rows prove, given the item's recorded independence: the
 * established slot basis only when the item records "independent" AND the payload rows verify it; otherwise null (the
 * rows prove nothing — the caller presents the score as historical and unverified). Never upgrades the item's value.
 */
export function cachedClaimPayloadScoreBasis(
  itemIndependence: unknown,
  payload: Pick<ClaimVerificationClientPayload, "modelIndependence" | "modelEvidence" | "auditBundle"> | null | undefined
): "independent_models" | "slot_responses" | null {
  if (!payload || !Array.isArray(payload.modelEvidence)) return null;
  if (claimPresentedIndependence(itemIndependence, payload.modelEvidence) !== "independent") return null;
  return claimPayloadConsensusBasis({ ...payload, modelIndependence: "independent" }) === "slot_responses" ? "slot_responses" : "independent_models";
}
