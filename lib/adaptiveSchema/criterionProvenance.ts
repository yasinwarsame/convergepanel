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
 *    invisible format characters such as soft hyphens and zero-width spaces
 *    removed so they never split a word, every other non-letter/number/mark
 *    character is a token separator EXCEPT a separator between two digits,
 *    which keeps a numeric expression such as "2.5", "1,000" or "10-15" whole).
 *    No synonyms, stemming, plural folding, semantic similarity or model judgment;
 *  - a missing/empty request, or a label with no tokens, fails closed to "model".
 *
 * Known, accepted limitations (fail closed, never over-attribute):
 *  - scripts written without spaces (e.g. Chinese, Japanese, Thai) tokenize as
 *    whole runs, so a criterion embedded in a longer run is not recognized;
 *  - inflected forms ("costs" vs "cost") are not recognized;
 *  - "cost increasing" in the request matches the label "cost increasing" but
 *    not "increasing cost" (order matters; scattered words never match);
 *  - the authority is the request's QUESTION text only (owner decision F8): the
 *    optional context field is never consulted.
 *
 * Model-written labels are display text, never provenance metadata: reserved
 * provenance markers at the end of a label ("(stated in request)",
 * "(provenance unverified)", "(user-provided)") are stripped by
 * criterionDisplayLabel() before classification and display, so a model cannot
 * imitate a trusted suffix or trigger the legacy notice.
 *
 * This module is imported by client components, so it must stay free of
 * server-only dependencies.
 */

import type { AggregatedDecisionCriterion, DecisionSupportResult } from "./types";

/** Provenance-generation marker persisted on every DecisionSupportResult aggregated under this rule. */
export const CRITERIA_PROVENANCE_RULE = "request_text_v1" as const;
export type CriteriaProvenanceRule = typeof CRITERIA_PROVENANCE_RULE;

/** Invisible format characters (Unicode Cf: soft hyphen, zero-width space/joiners, BOM, word joiner, bidi marks). Removed, never treated as separators, so they cannot split one word into matchable fragments. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** A run of letters/numbers/marks; a separator between two DIGITS (".", ",", ":", "/", "'", "’", hyphens and dashes) stays inside the token so a numeric expression is never split into fragments. */
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:(?<=\p{N})[.,:/'\u2019\-\u2010-\u2015](?=\p{N})[\p{L}\p{N}\p{M}]+)*/gu;

/** Normalized tokens: NFKC, lowercase, format characters removed, then TOKEN runs. */
export function provenanceTokens(text: string | null | undefined): string[] {
  if (typeof text !== "string") return [];
  return text.normalize("NFKC").toLowerCase().replace(FORMAT_CHARS, "").match(TOKEN) ?? [];
}

/** Reserved provenance markers a model-written label must not carry at its end (matched after NFKC and format-character removal; brackets or parentheses; any spacing/hyphenation). */
const RESERVED_TRAILING_MARKER = /\s*[([]\s*(?:stated\s+in\s+request|provenance\s+unverified|user\s*[-\u2010-\u2015]?\s*provided)\s*[)\]]\s*$/iu;
export const UNLABELLED_CRITERION = "Unlabelled criterion";

/**
 * Display text for a model-written criterion label: strips any trailing reserved provenance marker(s) so the label can
 * never imitate a trusted Receipt suffix. Labels without such a marker are returned unchanged (byte for byte).
 */
export function criterionDisplayLabel(label: string): string {
  const raw = typeof label === "string" ? label : "";
  let probe = raw.normalize("NFKC").replace(FORMAT_CHARS, "");
  if (!RESERVED_TRAILING_MARKER.test(probe)) return raw;
  while (RESERVED_TRAILING_MARKER.test(probe)) probe = probe.replace(RESERVED_TRAILING_MARKER, "");
  const out = probe.trim();
  return out.length > 0 ? out : UNLABELLED_CRITERION;
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

/** Classifies ONE displayed criterion label (after criterionDisplayLabel) against the user's original request question. Never consults model output. */
export function classifyCriterionProvenance(label: string, originalRequest: string | null | undefined): "user" | "model" {
  const requestTokens = provenanceTokens(originalRequest);
  if (requestTokens.length === 0) return "model";
  return containsTokenRun(requestTokens, provenanceTokens(criterionDisplayLabel(label))) ? "user" : "model";
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

/** Dashboard note for a historical (unmarked) result that carries model-reported "user" criteria. Viewer-neutral (F7). */
export const LEGACY_RESULT_NOTICE =
  "Original request provenance could not be independently established for this historical result. Criteria the models reported as user-provided are marked unverified.";

export const LEGACY_FROZEN_RECEIPT_NOTICE =
  "This Receipt was frozen before criterion provenance was checked against the request. Its \"(user-provided)\" labels were reported by the models and are unverified.";

/** True when a (possibly frozen) Receipt basis contains a criterion line written under the retired self-report rule. */
export function receiptHasLegacyUserProvidedCriteria(basis: readonly string[]): boolean {
  return basis.some((line) => line.startsWith("Criterion: ") && line.endsWith(LEGACY_RECEIPT_SUFFIX_USER_PROVIDED));
}

/**
 * Item 6A (F2/F6) — export-time DERIVED disclosure for the JSON export. It is computed when the export is rendered and
 * is NOT part of the historical record: the stored result (including each criterion's raw `source`) and the stored
 * Receipt are passed through unchanged beside it. Present only for a Decision Support result whose provenance cannot be
 * established under the current rule (no marker and a model-reported "user" criterion) or whose stored Receipt carries
 * the retired "(user-provided)" label; absent otherwise, so every other export is unchanged.
 */
export interface DerivedCriteriaProvenanceDisclosure {
  derivedAtExport: true;
  derivedRule: CriteriaProvenanceRule;
  note: string;
  resultProvenanceMarker: CriteriaProvenanceRule | null;
  storedReceiptHasLegacyUserProvidedLabels: boolean;
  criteria: { id: string; label: string; recordedSource: "user" | "model"; derivedProvenance: CriterionProvenance }[];
}

export const DERIVED_DISCLOSURE_NOTE =
  "Derived when this export was rendered; not part of the historical record. recordedSource is the value stored at the time (a model self-report on results without a provenance marker); derivedProvenance is how ConvergePanel presents it now. Original request provenance could not be independently established for criteria marked unverified_legacy.";

export function deriveCriteriaProvenanceDisclosure(schemaId: string, result: unknown, receipt: { basis?: unknown } | undefined | null): DerivedCriteriaProvenanceDisclosure | undefined {
  if (schemaId !== "decision_support" || !result || typeof result !== "object") return undefined;
  const r = result as { criteria?: unknown; criteriaProvenance?: unknown };
  const criteria = Array.isArray(r.criteria) ? (r.criteria as { id?: unknown; label?: unknown; source?: unknown }[]) : [];
  const marker = r.criteriaProvenance === CRITERIA_PROVENANCE_RULE ? CRITERIA_PROVENANCE_RULE : null;
  const basis = Array.isArray(receipt?.basis) ? (receipt!.basis as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const legacyReceipt = receiptHasLegacyUserProvidedCriteria(basis);
  const rows = criteria.map((c) => {
    const recordedSource: "user" | "model" = c?.source === "user" ? "user" : "model";
    return { id: typeof c?.id === "string" ? c.id : "", label: typeof c?.label === "string" ? c.label : "", recordedSource, derivedProvenance: readCriterionProvenance({ criteriaProvenance: marker ?? undefined }, { source: recordedSource }) };
  });
  const unverifiedResult = rows.some((x) => x.derivedProvenance === "unverified_legacy");
  if (!unverifiedResult && !legacyReceipt) return undefined;
  return { derivedAtExport: true, derivedRule: CRITERIA_PROVENANCE_RULE, note: DERIVED_DISCLOSURE_NOTE, resultProvenanceMarker: marker, storedReceiptHasLegacyUserProvidedLabels: legacyReceipt, criteria: rows };
}
