/**
 * Adaptive Verification Config
 *
 * Single source of truth for every weight, tolerance, and threshold used by
 * the alignment/agreement/certainty/gate pipeline. Nothing downstream
 * (fieldAlignment.ts, agreementComparators.ts, scoring.ts, verificationGate
 * adapter) should hardcode a number that belongs here — tune it here instead.
 */

import { AdaptiveGateStatus, ClaimConfidence, ClaimEvidenceType, ModelTrustSummary } from "./types";

// ─── Certainty formula (R1b) ────────────────────────────────────────────
// certaintyScore = coverageWeight*coverage + agreementWeight*agreement + statedConfidenceWeight*statedConfidence
export const CERTAINTY_WEIGHTS = {
  coverage: 0.35,
  agreement: 0.45,
  statedConfidence: 0.2,
};

export const STATED_CONFIDENCE_SCORE: Record<ClaimConfidence, number> = {
  settled: 1.0,
  majority_view: 0.75,
  contested: 0.4,
  speculative: 0.2,
};

// ─── Verification gate thresholds (R1d) ────────────────────────────────
export const GATE_THRESHOLDS = {
  /** Run certainty >= this AND no split load-bearing claim -> "pass". */
  passMin: 0.7,
  /** Run certainty >= this (and below passMin), or exactly one split
   * load-bearing claim -> "caution". Below this -> "fail". */
  cautionMin: 0.45,
  /** How many top-salience claims count as "load-bearing" for gate purposes. */
  loadBearingTopN: 3,
};

// ─── financial_valuation: numeric tolerance bands (R2) ─────────────────
/** Default relative tolerance (fraction of the group median) for a metric to count as "agrees". */
export const DEFAULT_METRIC_TOLERANCE = 0.05;
/** Beyond 2x the tolerance, a metric value counts as "disputes" rather than "partial". */
export const METRIC_DISPUTE_MULTIPLIER = 2;
/** Per-metric-label overrides (normalized lowercase label -> relative tolerance). */
export const METRIC_TOLERANCE_OVERRIDES: Record<string, number> = {};

// ─── forecast_speculative: scenario probability bands (R2) ─────────────
/** Absolute probability tolerance for two models' scenario estimates to "agree". */
export const SCENARIO_PROBABILITY_TOLERANCE = 0.15;
export const SCENARIO_DISPUTE_MULTIPLIER = 2;

// ─── medical_health: evidence-tier weighting (R2) ───────────────────────
/** RCT/authoritative-tier disagreement counts 3x an anecdotal-tier disagreement in the run score. */
export const EVIDENCE_TIER_WEIGHT: Record<ClaimEvidenceType, number> = {
  empirical: 3,
  authoritative: 3,
  theoretical: 1.5,
  anecdotal: 1,
};

// ─── Trust Summary per-schema weighting (R1c) ───────────────────────────
/** Relative weight of "citation presence" vs "numeric/internal consistency" in the composite trust score, per schema. */
export const TRUST_WEIGHTS_BY_SCHEMA: Record<string, { citation: number; consistency: number; contradiction: number }> = {
  factual_lookup: { citation: 0.5, consistency: 0.3, contradiction: 0.2 },
  medical_health: { citation: 0.45, consistency: 0.3, contradiction: 0.25 },
  legal_regulatory: { citation: 0.45, consistency: 0.3, contradiction: 0.25 },
  financial_valuation: { citation: 0.2, consistency: 0.55, contradiction: 0.25 },
  forecast_speculative: { citation: 0.2, consistency: 0.5, contradiction: 0.3 },
  procedural: { citation: 0.15, consistency: 0.55, contradiction: 0.3 },
  contested_empirical: { citation: 0.3, consistency: 0.3, contradiction: 0.4 },
  creative_generative: { citation: 0.1, consistency: 0.4, contradiction: 0.5 },
  generic: { citation: 0.3, consistency: 0.35, contradiction: 0.35 },
};

export function getTrustWeights(schemaId: string) {
  return TRUST_WEIGHTS_BY_SCHEMA[schemaId] ?? TRUST_WEIGHTS_BY_SCHEMA.generic;
}

// ─── Trust score health caps (Part B4) ──────────────────────────────────
/**
 * A model's composite trust score is capped by its parse health, regardless
 * of how well it otherwise scored on citations/consistency/contradictions —
 * a degraded parse means some of what fed that score is already suspect.
 * `null` means no cap (the raw weighted score stands). "failed" is 0 both
 * here and via trustSummary.ts's existing hard override; kept here too so
 * every health state's cap is visible in one place.
 */
export const TRUST_SCORE_CAP_BY_HEALTH: Record<ModelTrustSummary["parseHealth"], number | null> = {
  ok: null,
  degraded: 0.75,
  failed: 0,
};

/** Tooltip copy shown next to a capped trust score, explaining why it can't read higher. */
export const TRUST_SCORE_CAP_REASON: Record<ModelTrustSummary["parseHealth"], string | null> = {
  ok: null,
  degraded: `Response was degraded (one or more fields were soft-truncated) — trust score is capped at ${Math.round(
    (TRUST_SCORE_CAP_BY_HEALTH.degraded ?? 0) * 100
  )}% regardless of citation/consistency scoring.`,
  failed: "Response failed to parse or validate — trust score is 0.",
};

// ─── Bias & Blind Spots (Synthesis Report Polish, Part A3) ──────────────
/** Cap on bias/blind-spot findings surfaced per run. */
export const MAX_BIAS_FINDINGS = 3;
/** Hard cap on each evidence excerpt quoted from a model's own response. */
export const BIAS_EVIDENCE_EXCERPT_MAX_CHARS = 240;

// ─── Uncertainties / Follow-ups dedup (Part B6) ─────────────────────────
/** Cap on merged Uncertainties shown in the generic_sections renderer. */
export const UNCERTAINTIES_MAX_ITEMS = 8;
/** Cap on merged Follow-ups shown in the generic_sections renderer. */
export const FOLLOW_UPS_MAX_ITEMS = 6;
/**
 * Near-duplicate thresholds for merging Uncertainties/Follow-ups across
 * models — deliberately a HIGHER bar (stricter Levenshtein ratio, higher
 * token-overlap floor) than alignment.ts's claim-id slugsMatch, since these
 * are full prose sentences (a mistaken merge silently drops a genuinely
 * distinct point) and there's no downstream LLM reconciliation pass to
 * catch an under-merge the way claim alignment's pass 2 does — this cheap
 * pass IS the whole merge decision.
 */
export const TEXT_DEDUP_THRESHOLDS = {
  levenshteinMaxRatio: 0.2,
  tokenOverlapMin: 0.7,
};

// ─── Panel Verdict Card (Part A4) ────────────────────────────────────────
/** Gate-dependent guidance shown in the verdict card, max 3 per gate status. */
export const VERDICT_NEXT_STEPS: Record<AdaptiveGateStatus, string[]> = {
  pass: [
    "Use this synthesis as a starting point — spot-check the top consensus claim against one primary source before acting on it.",
    "Revisit if new information emerges that could shift the load-bearing claims.",
  ],
  caution: [
    "Treat the key disagreement as unresolved — don't rely on either side without independent verification.",
    "Re-run with additional models or a narrower question if this decision is time-sensitive.",
    "Flag the caveat below to anyone else relying on this synthesis.",
  ],
  fail: [
    "Don't act on this synthesis as-is — the panel did not converge on a reliable answer.",
    "Independently verify the unresolved claims before using any of them.",
    "Consider rephrasing the question or supplying more context, then re-running the panel.",
  ],
};
