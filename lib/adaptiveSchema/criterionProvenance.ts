/**
 * Item 6A — authoritative user-criterion provenance (owner rule, 2026-10-14).
 *
 * The ONLY authority for "this criterion came from the user" is the user's
 * original submitted request text. Model output is never authoritative for
 * user-origin metadata: the decision_support schema's `userProvidedCriteria`
 * field is a model self-report and is deliberately ignored here.
 *
 * Rule (`CRITERIA_PROVENANCE_RULE` = "request_text_v1"):
 *  - every criterion starts as "model";
 *  - it is "user" only when its DISPLAYED label, normalized, occurs in the
 *    normalized request as a contiguous run of whole tokens in the same order;
 *  - normalization is case, punctuation and whitespace only (NFKC, lowercase,
 *    every non-letter/number/mark character is a token separator). No
 *    synonyms, stemming, plural folding, semantic similarity or model judgment;
 *  - a missing/empty request, or a label with no tokens, fails closed to "model".
 *
 * Known, accepted limitations (fail closed, never over-attribute):
 *  - scripts written without spaces (e.g. Chinese, Japanese, Thai) tokenize as
 *    whole runs, so a criterion embedded in a longer run is not recognized;
 *  - inflected forms ("costs" vs "cost") are not recognized;
 *  - "cost increasing" in the request matches the label "cost increasing" but
 *    not "increasing cost" (order matters; scattered words never match).
 *
 * This module is imported by client components, so it must stay free of
 * server-only dependencies.
 */

import type { AggregatedDecisionCriterion, DecisionSupportResult } from "./types";

/** Provenance-generation marker persisted on every DecisionSupportResult aggregated under this rule. */
export const CRITERIA_PROVENANCE_RULE = "request_text_v1" as const;
export type CriteriaProvenanceRule = typeof CRITERIA_PROVENANCE_RULE;

/** Splits text into normalized tokens: NFKC, lowercase, separators = any character that is not a Unicode letter, number or mark. */
export function provenanceTokens(text: string | null | undefined): string[] {
  if (typeof text !== "string") return [];
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 0);
}

/** True only when `needle` occurs in `haystack` as a contiguous, same-order run of whole tokens. */
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Classifies ONE displayed criterion label against the user's original request. Never consults model output. */
export function classifyCriterionProvenance(label: string, originalRequest: string | null | undefined): "user" | "model" {
  const requestTokens = provenanceTokens(originalRequest);
  if (requestTokens.length === 0) return "model";
  return containsTokenRun(requestTokens, provenanceTokens(label)) ? "user" : "model";
}

/**
 * The single shared provenance read used by every presentation surface (dashboard, Decision Receipt, limitations,
 * exports). Results carrying the current marker report their stored value. Results WITHOUT the marker were aggregated
 * under the retired model-self-report rule: their "user" values are not trustworthy, so they read as
 * "unverified_legacy"; their "model" values stay "model".
 */
export type CriterionProvenance = "user" | "model" | "unverified_legacy";

export function hasAuthoritativeCriteriaProvenance(result: Pick<DecisionSupportResult, "criteriaProvenance">): boolean {
  return result.criteriaProvenance === CRITERIA_PROVENANCE_RULE;
}

export function readCriterionProvenance(
  result: Pick<DecisionSupportResult, "criteriaProvenance">,
  criterion: Pick<AggregatedDecisionCriterion, "source">
): CriterionProvenance {
  if (hasAuthoritativeCriteriaProvenance(result)) return criterion.source === "user" ? "user" : "model";
  return criterion.source === "user" ? "unverified_legacy" : "model";
}

/** True when a legacy result carries at least one model-reported "user" criterion that is now shown as unverified. */
export function hasUnverifiedLegacyCriteria(result: Pick<DecisionSupportResult, "criteriaProvenance" | "criteria">): boolean {
  return result.criteria.some((c) => readCriterionProvenance(result, c) === "unverified_legacy");
}

/** Decision Receipt basis suffixes. The verified suffix intentionally differs from the retired "(user-provided)" text so a frozen pre-6A Receipt can be recognized without modifying it. */
export const RECEIPT_SUFFIX_USER = " (stated in request)";
export const RECEIPT_SUFFIX_UNVERIFIED = " (provenance unverified)";
/** The retired suffix written by Receipts built before Item 6A (model self-report). Only ever READ, to disclose it. */
export const LEGACY_RECEIPT_SUFFIX_USER_PROVIDED = " (user-provided)";

export function receiptCriterionSuffix(provenance: CriterionProvenance): string {
  if (provenance === "user") return RECEIPT_SUFFIX_USER;
  if (provenance === "unverified_legacy") return RECEIPT_SUFFIX_UNVERIFIED;
  return "";
}

export const LEGACY_PROVENANCE_LIMITATION =
  "Criterion provenance for this earlier run was reported by the models and could not be verified against the request.";

export const LEGACY_FROZEN_RECEIPT_NOTICE =
  "This Receipt was frozen before criterion provenance was checked against the request. Its \"(user-provided)\" labels were reported by the models and are unverified.";

/** True when a (possibly frozen) Receipt basis contains a criterion line written under the retired self-report rule. */
export function receiptHasLegacyUserProvidedCriteria(basis: readonly string[]): boolean {
  return basis.some((line) => line.startsWith("Criterion: ") && line.endsWith(LEGACY_RECEIPT_SUFFIX_USER_PROVIDED));
}
