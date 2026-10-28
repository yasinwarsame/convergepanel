/**
 * Order 6 / S-E.1 — owner-approved Decision Support (DS) presentation wording
 * (D-10 (b); K-1 with revisions, K-3 DS only, K-5, K-6; 2026-10-28).
 *
 * Presentation only. Every function here reads values that are already
 * computed and stored; none of them changes a consensus level, a source
 * grounding level, the option matcher, a receipt, or any stored record.
 *
 * Each claim is shown only when the state that makes it true is
 * demonstrated by the input. When it is not, the function returns `null`
 * and the caller omits the claim (owner rule: omit rather than show an
 * optimistic default).
 *
 * Other schemas keep their existing wording; callers branch on
 * `isDecisionSupportSchema` and leave their non-DS path untouched.
 */

import type { DecisionSupportResult } from "./types";

export const DECISION_SUPPORT_SCHEMA_ID = "decision_support" as const;

export function isDecisionSupportSchema(schemaId: unknown): boolean {
  return schemaId === DECISION_SUPPORT_SCHEMA_ID;
}

/** K-6 presentation headings (stored field names are unchanged). */
export const DS_MODEL_AGREEMENT_FIELD = "Model agreement";
export const DS_SOURCES_FIELD = "Sources";

/** E-1 / E-4: the current grouping found no split among K ≥ 1 recommendations. */
export const DS_NO_DISAGREEMENT_IDENTIFIED = "No disagreement identified by current grouping";
/** E-1 values carried over unchanged from the shipped consensus labels. */
export const DS_AGREEMENT_SPLIT = "Split";
export const DS_AGREEMENT_NOT_SCORED = "Not scored";
/** E-4, K = 0. */
export const DS_NO_RECOMMENDATION = "No model gave a recommendation.";

/** E-2 (summary field) and E-3 (badge), K-5: only for a non-empty reference list. */
export const DS_SOURCES_PROVIDED = "Sources provided by models; not independently verified";
export const DS_SOURCES_LISTED = "Sources listed; not independently verified";
export const DS_NO_SOURCES_LISTED = "No sources listed";

/** E-5. */
export const DS_GROUPING_BASIS =
  "Based on the currently grouped recommendations. Opposing options may have been grouped together.";

/** E-6. */
export const DS_NOT_FLAGGED_FOR_REVIEW = "System did not flag this for human review.";

/** E-7 suffix. */
export const DS_NOT_A_CERTAINTY_MEASURE = "These counts are not a certainty measure.";

/** E-8. */
export const DS_STRENGTH_QUALIFIER = "(model-assigned)";
export const DS_STRENGTH_CAPTION = "Evidence-strength ratings are assigned by the models and were not independently checked.";
export const DS_STRENGTH_TALLY_HEADING = "Model-assigned evidence strength, not independently checked";

/**
 * D-9 (c) disclosure: the sealed spec's `option_clustering_unverified` text
 * (B §3.1 L677), character for character. A test pins it equal to the
 * builder's OPTION_CLUSTERING_UNVERIFIED_TEXT.
 */
export const DS_OPTION_GROUPING_DISCLOSURE =
  "Options were grouped by text similarity. Different options with similar wording (for example 3.5% vs 35%, or Approve vs Disapprove) can be merged; agreement on an option is not established.";

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export type DsAgreementPresentation = { text: string; kind: "no_disagreement" | "split" | "not_scored" };

/**
 * E-1. Derived from the DS result's own stored fields, never from a ratio or
 * threshold: no result or K = 0 → "Not scored"; contested → "Split";
 * otherwise K ≥ 1 and not contested → "No disagreement identified by current
 * grouping".
 */
export function dsModelAgreement(decisionSupport: DecisionSupportResult | null | undefined): DsAgreementPresentation {
  const recommendation = decisionSupport?.recommendation;
  if (!recommendation || !isCount(recommendation.totalModelsWithRecommendation) || recommendation.totalModelsWithRecommendation === 0) {
    return { text: DS_AGREEMENT_NOT_SCORED, kind: "not_scored" };
  }
  if (recommendation.isContested === true) return { text: DS_AGREEMENT_SPLIT, kind: "split" };
  if (recommendation.isContested === false) return { text: DS_NO_DISAGREEMENT_IDENTIFIED, kind: "no_disagreement" };
  return { text: DS_AGREEMENT_NOT_SCORED, kind: "not_scored" };
}

/** K-5: true only for at least one non-blank string reference; null when the list itself is absent. */
export function dsHasListedSources(sources: unknown): boolean | null {
  if (!Array.isArray(sources)) return null;
  return sources.some((s) => typeof s === "string" && s.trim().length > 0);
}

/**
 * E-2 summary-field value, or null to omit. With no reference list recorded (a legacy result), only the stored flag is
 * left: false still establishes "No sources listed" (as on receipts); true establishes nothing (K-5), so the claim is
 * omitted.
 */
export function dsSourcesSummary(decisionSupport: DecisionSupportResult | null | undefined): string | null {
  const listed = dsHasListedSources(decisionSupport?.sources);
  if (listed === null) return dsReceiptSourcesLabel(decisionSupport?.sourceBacked);
  return listed ? DS_SOURCES_PROVIDED : DS_NO_SOURCES_LISTED;
}

/** E-3 DS badge text, or null to omit; the same legacy fallback as `dsSourcesSummary`. */
export function dsSourcesBadge(sources: unknown, sourceBacked?: unknown): string | null {
  const listed = dsHasListedSources(sources);
  if (listed === null) return dsReceiptSourcesLabel(sourceBacked);
  return listed ? DS_SOURCES_LISTED : DS_NO_SOURCES_LISTED;
}

/**
 * E-3 on receipt surfaces, which carry only the stored `sourceBacked` flag.
 * That flag is also true for a blank list (`[""]`), so it cannot establish
 * that sources were listed (K-5): true → null (omit); false → no model
 * returned any source entry, so "No sources listed" holds.
 */
export function dsReceiptSourcesLabel(sourceBacked: unknown): string | null {
  return sourceBacked === false ? DS_NO_SOURCES_LISTED : null;
}

/**
 * E-7: the owner-approved D-2 template (B §3.5.4, L909), followed by the
 * certainty limitation. M = models dispatched, K = models that gave a
 * recommendation, N = largest group recommending the same action. Returns
 * null when any count is not a non-negative integer.
 */
export function dsRecommendationCounts(decisionSupport: DecisionSupportResult | null | undefined): string | null {
  const m = decisionSupport?.totalModels;
  const k = decisionSupport?.recommendation?.totalModelsWithRecommendation;
  const n = decisionSupport?.recommendation?.supportCount;
  if (!isCount(m) || !isCount(k) || !isCount(n)) return null;
  return `${m} ${m === 1 ? "model" : "models"} dispatched; ${k} gave a recommendation; largest group recommending the same action: ${n}. ${DS_NOT_A_CERTAINTY_MEASURE}`;
}

/** E-4, for the uncontested branch only; null when the result is contested (the caller keeps its contested wording). */
export function dsUncontestedStatement(decisionSupport: DecisionSupportResult): string | null {
  const recommendation = decisionSupport.recommendation;
  if (recommendation.isContested !== false) return null;
  if (recommendation.totalModelsWithRecommendation === 0) return DS_NO_RECOMMENDATION;
  if (!isCount(recommendation.totalModelsWithRecommendation)) return null;
  return `${DS_NO_DISAGREEMENT_IDENTIFIED}.`;
}

/** E-8: a strength value with its visible qualifier. `contested` is a disagreement marker and `unknown` is hidden or "Unrated", so neither gets one. */
export const DS_STRENGTH_LABEL: Record<string, string> = {
  strong: `Strong ${DS_STRENGTH_QUALIFIER}`,
  moderate: `Moderate ${DS_STRENGTH_QUALIFIER}`,
  weak: `Weak ${DS_STRENGTH_QUALIFIER}`,
  contested: "Contested",
  unknown: "Unrated",
};
