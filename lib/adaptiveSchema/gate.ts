/**
 * Adaptive Verification Gate (R1d)
 *
 * A NEW gate purpose-built for the adaptive pipeline's certainty/agreement
 * data — NOT a call into lib/verificationGate/verificationGate.ts. That
 * legacy gate's entire decision tree is built on StructuredSynthesis
 * signals (keyFindings confidence tags, bias-flag counts, disagreement
 * text heuristics) and a different status vocabulary
 * (SAFE_TO_EXPLORE/NEEDS_HUMAN_REVIEW/DO_NOT_RELY_YET). The corrective spec
 * for this pipeline asks for a specific numeric formula — certainty ≥ 0.7
 * with no load-bearing split, "pass"/"caution"/"fail" — which has no
 * equivalent lever in the legacy function's input shape. Both gates are
 * intentional, parallel implementations for their respective pipelines;
 * the legacy gate is untouched and still runs for non-adaptive panels.
 */

import "server-only";
import { AdaptiveGateResult, AdaptiveGateStatus, AlignedClaim, QueryType } from "./types";
import { GATE_THRESHOLDS } from "./config";
import { claimSalience } from "./scoring";

export type { AdaptiveGateResult, AdaptiveGateStatus };

/** Top-N claims by salience (how many models raised them) — the claims the gate treats as "load-bearing". */
function topSalienceClaims(rows: AlignedClaim[], n: number): AlignedClaim[] {
  return [...rows].sort((a, b) => claimSalience(b) - claimSalience(a)).slice(0, n);
}

export function computeAdaptiveGate(
  rows: AlignedClaim[],
  runCertainty: number,
  schemaId: QueryType
): AdaptiveGateResult {
  const loadBearingClaims = topSalienceClaims(rows, GATE_THRESHOLDS.loadBearingTopN);
  const loadBearingSplitCount = loadBearingClaims.filter((c) => c.status === "split").length;

  let status: AdaptiveGateStatus;
  if (loadBearingSplitCount >= 2 || runCertainty < GATE_THRESHOLDS.cautionMin) {
    // 2+ of the top-3 load-bearing claims unresolved, or certainty below the
    // caution floor — never a confident readout either way.
    status = "fail";
  } else if (runCertainty >= GATE_THRESHOLDS.passMin && loadBearingSplitCount === 0) {
    status = "pass";
  } else {
    // certainty in [cautionMin, passMin), or exactly one load-bearing split
    // at otherwise-high certainty.
    status = "caution";
  }

  // factual_lookup: an exact/normalized answer mismatch is a hard split by
  // definition (R2) — it must cap the gate at caution even if the numeric
  // certainty score alone would otherwise read as "pass".
  if (schemaId === "factual_lookup" && status === "pass" && rows.some((r) => r.status === "split")) {
    status = "caution";
  }

  return { status, runCertainty, loadBearingSplitCount, loadBearingClaims };
}
