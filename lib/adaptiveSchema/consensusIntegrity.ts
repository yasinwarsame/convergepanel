/**
 * Consensus Integrity
 *
 * Two corrections to how a claim row's agreement is PRESENTED, applied after
 * the schema's AgreementComparator has scored every row:
 *
 * 1. Coverage (limited_coverage). The comparators score only the cells that
 *    took a position, so 2 agreeing models out of 5 dispatched (3 silent or
 *    failed) read as "consensus". A row the comparator rated consensus or
 *    majority becomes "limited_coverage" when
 *    assessedPositions * 2 <= dispatchedPanelSize.
 *    - assessedPositions: cells that took an assessable position — non-null,
 *      stance not "unclear" (the same buckets the agreement map shows).
 *    - dispatchedPanelSize: every model dispatched for the run, failed ones
 *      included — never the successful-response count or a product maximum.
 *    Only consensus and majority are ever relabelled, so split and
 *    single_source rows, the gate (which counts split rows), and certainty
 *    (which never reads status) are all unaffected.
 *
 * 2. Contested axis (ContestedDimensions). Whether the models marked the
 *    underlying claim contested is a separate question from whether their
 *    positions agree: "5 of 5 take this position · all mark the underlying
 *    claim contested". Counted from the models' own claim cells only.
 *
 * Plus the one exhaustive status rank/label map every renderer uses, and the
 * canonical (deterministic) wording for the contested note.
 *
 * Pure and client-safe: no "server-only", no I/O.
 */

import {
  ALIGNED_CLAIM_STATUSES,
  AlignedClaim,
  AlignedClaimCell,
  AlignedClaimStatus,
  ClaimFieldClass,
  ContestedDimensions,
  QueryType,
} from "./types";

// ─── Field origin ──────────────────────────────────────────────────────────

/**
 * claim[] fields whose definition fixes their claims' epistemic class
 * (schemaRegistry.ts). Every other claim[] field is "unclassified": e.g.
 * legal_regulatory.unsettledIssues says each claim's own confidence decides
 * (settled / majority rule / circuit split), and generic.keyClaims and
 * medical_health.evidenceByTier say nothing about it.
 */
export const CLAIM_FIELD_CLASS: Partial<Record<QueryType, Readonly<Record<string, ClaimFieldClass>>>> = {
  contested_empirical: { settledClaims: "settled", disputedClaims: "disputed" },
};

export function claimFieldClass(schemaId: QueryType, field: string): ClaimFieldClass {
  return CLAIM_FIELD_CLASS[schemaId]?.[field] ?? "unclassified";
}

// ─── Coverage ──────────────────────────────────────────────────────────────

/** Cells that took an assessable position on the row: non-null and not "unclear". */
export function assessedPositionCount(row: AlignedClaim): number {
  return row.cells.filter((c): c is AlignedClaimCell => !!c && c.stance !== "unclear").length;
}

/**
 * True when half or fewer of the dispatched panel took an assessable
 * position. A panel size that is not a positive integer can't support any
 * agreement claim, so it counts as limited (fails closed).
 */
export function isLimitedCoverage(assessedPositions: number, dispatchedPanelSize: number): boolean {
  if (!Number.isInteger(dispatchedPanelSize) || dispatchedPanelSize < 1) return true;
  return assessedPositions * 2 <= dispatchedPanelSize;
}

// ─── Contested axis ────────────────────────────────────────────────────────

function cellMarksContested(cell: AlignedClaimCell): boolean {
  if (cell.origin?.kind !== "claim") return false;
  return cell.origin.fieldClass === "disputed" || cell.confidence === "contested" || (cell.camps?.length ?? 0) > 0;
}

/** See ContestedDimensions (types.ts). Undefined when no model listed the claim itself. */
export function computeContestedDimensions(row: AlignedClaim): ContestedDimensions | undefined {
  const claimCells = row.cells.filter((c): c is AlignedClaimCell => !!c && c.origin?.kind === "claim");
  if (claimCells.length === 0) return undefined;
  return { marked: claimCells.filter(cellMarksContested).length, assessed: claimCells.length };
}

// ─── The classification boundary ──────────────────────────────────────────

/**
 * Applied once per run, after scoreAgreement and before certainty/gate/
 * synthesis. Changes only `status` (consensus/majority → limited_coverage)
 * and adds `contested`; every cell, agreementScore and certaintyScore is
 * passed through untouched.
 */
export function applyConsensusIntegrity(rows: AlignedClaim[], dispatchedPanelSize: number): AlignedClaim[] {
  return rows.map((row) => {
    const limited =
      (row.status === "consensus" || row.status === "majority") &&
      isLimitedCoverage(assessedPositionCount(row), dispatchedPanelSize);
    const contested = computeContestedDimensions(row);
    return {
      ...row,
      ...(limited ? { status: "limited_coverage" as const } : {}),
      ...(contested ? { contested } : {}),
    };
  });
}

// ─── Status presentation ──────────────────────────────────────────────────

/** Display rank, strongest agreement first. Exhaustive by type: adding a status without ranking it fails to compile. */
export const CONSENSUS_STATUS_RANK: Readonly<Record<AlignedClaimStatus, number>> = {
  consensus: 0,
  majority: 1,
  limited_coverage: 2,
  split: 3,
  single_source: 4,
};

/** The four pre-existing statuses keep exactly the text they were shown with before (the raw value), so historical runs render unchanged. */
export const CONSENSUS_STATUS_LABEL: Readonly<Record<AlignedClaimStatus, string>> = {
  consensus: "consensus",
  majority: "majority",
  limited_coverage: "limited coverage",
  split: "split",
  single_source: "single_source",
};

function isKnownStatus(status: string): status is AlignedClaimStatus {
  return (ALIGNED_CLAIM_STATUSES as readonly string[]).includes(status);
}

/**
 * Which statuses may be presented as the panel's top consensus ("Top
 * consensus", "agreed by N", "N/M models converge on"). Only real agreement:
 * consensus and majority. Exhaustive by type, so a new status must be ruled
 * on here before it compiles.
 */
export const TOP_CONSENSUS_ELIGIBLE: Readonly<Record<AlignedClaimStatus, boolean>> = {
  consensus: true,
  majority: true,
  limited_coverage: false,
  split: false,
  single_source: false,
};

/** True only for a known, eligible status — an unknown (e.g. future or malformed) value is never eligible. */
export function isTopConsensusEligible(status: string): boolean {
  return isKnownStatus(status) && TOP_CONSENSUS_ELIGIBLE[status];
}

/** Rank for a status read from data (possibly persisted). An unknown value ranks last — explicitly, never as NaN. */
export function consensusStatusRank(status: string): number {
  return isKnownStatus(status) ? CONSENSUS_STATUS_RANK[status] : ALIGNED_CLAIM_STATUSES.length;
}

/** Label for a status read from data. An unknown value is shown as-is rather than guessed at. */
export function consensusStatusLabel(status: string): string {
  return isKnownStatus(status) ? CONSENSUS_STATUS_LABEL[status] : status;
}

// ─── Canonical wording ────────────────────────────────────────────────────

/**
 * The one canonical contested note, from structured counts only. The
 * denominator is always named — never "all models", since silent and failed
 * dispatched models are not part of it:
 * - every model that took a position listed the claim itself and marked it:
 *   "all N models that took a position mark the underlying claim contested"
 *   ("the 1 model that took a position marks …" when N is 1);
 * - otherwise "M of N model(s) that listed this claim mark(s) it contested",
 *   the verb agreeing with M ("1 of 1 model … marks", "2 of 3 models … mark");
 * - null when none marked it (or no model listed it).
 */
export function describeContested(row: AlignedClaim): string | null {
  const contested = row.contested;
  if (!contested || contested.marked === 0) return null;
  const positions = row.cells.filter(Boolean).length;
  if (contested.marked === contested.assessed && contested.assessed === positions) {
    return contested.assessed === 1
      ? "the 1 model that took a position marks the underlying claim contested"
      : `all ${contested.assessed} models that took a position mark the underlying claim contested`;
  }
  return `${contested.marked} of ${contested.assessed} model${contested.assessed === 1 ? "" : "s"} that listed this claim ${
    contested.marked === 1 ? "marks" : "mark"
  } it contested`;
}

/** "N of M dispatched models took a position" — the coverage note for a limited_coverage row. */
export function describeCoverage(row: AlignedClaim, dispatchedPanelSize: number): string {
  return `${assessedPositionCount(row)} of ${dispatchedPanelSize} dispatched models took a position`;
}
