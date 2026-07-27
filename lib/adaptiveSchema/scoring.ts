/**
 * Certainty Scoring (R1b)
 *
 * Per-claim certainty = f(coverage, agreement, statedConfidence), weights in
 * config.ts. Per-run certainty = salience-weighted mean over claims
 * (salience = how many models raised the claim), with an evidence-tier
 * override for medical_health per R2 ("RCT-tier disagreement weighs 3x
 * anecdotal-tier disagreement in the run score").
 *
 * Operates on rows already scored by agreementComparators.ts — this module
 * only adds certaintyScore, never agreementScore/status.
 */

import "server-only";
import { AlignedClaim, AlignedClaimCell, QueryType } from "./types";
import { CERTAINTY_WEIGHTS, STATED_CONFIDENCE_SCORE } from "./config";
import { rowEvidenceTierWeight } from "./agreementComparators";

function rowCoverage(row: AlignedClaim, totalModels: number): number {
  if (totalModels <= 0) return 0;
  return row.cells.filter(Boolean).length / totalModels;
}

function rowStatedConfidence(row: AlignedClaim): number {
  const cells = row.cells.filter((c): c is AlignedClaimCell => !!c);
  if (cells.length === 0) return 0;
  const sum = cells.reduce((acc, c) => acc + STATED_CONFIDENCE_SCORE[c.confidence], 0);
  return sum / cells.length;
}

/** Assigns certaintyScore to every row given its already-computed agreementScore and the run's total model count. */
export function scoreClaimCertainty(rows: AlignedClaim[], totalModels: number): AlignedClaim[] {
  return rows.map((row) => {
    const coverage = rowCoverage(row, totalModels);
    const statedConfidence = rowStatedConfidence(row);
    const certaintyScore =
      CERTAINTY_WEIGHTS.coverage * coverage +
      CERTAINTY_WEIGHTS.agreement * row.agreementScore +
      CERTAINTY_WEIGHTS.statedConfidence * statedConfidence;
    return { ...row, certaintyScore };
  });
}

/** A row's weight in the run-level mean: how many models raised it (min 1 to avoid zero-weighting a real row), times its evidence-tier weight for medical_health. */
export function claimSalience(row: AlignedClaim): number {
  return Math.max(row.cells.filter(Boolean).length, 1);
}

/**
 * Per-run certainty: salience-weighted mean of certaintyScore across claims.
 * A claim 4/5 models discussed pulls the run score more than one only 1
 * model raised. medical_health additionally multiplies by evidence-tier
 * weight, so a disagreement over RCT-tier evidence drags the run score down
 * 3x harder than the same disagreement over anecdotal evidence.
 */
export function computeRunCertainty(rows: AlignedClaim[], schemaId: QueryType): number {
  if (rows.length === 0) return 0;

  const weighted = rows.map((row) => {
    const tierWeight = schemaId === "medical_health" ? rowEvidenceTierWeight(row) : 1;
    return { certainty: row.certaintyScore, weight: claimSalience(row) * tierWeight };
  });

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight === 0) return 0;

  return weighted.reduce((sum, w) => sum + w.certainty * w.weight, 0) / totalWeight;
}
