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
 *    normalized request QUESTION (never the context field, owner decision F8)
 *    as a contiguous run of whole tokens in the same order;
 *  - normalization is case, punctuation and whitespace only: NFKC, lowercase,
 *    invisible format characters (Unicode Cf) removed so they never split a word;
 *  - lexical units are cohesive (owner policy N4): a hyphen or apostrophe
 *    between two letters/digits stays inside the token, so "non-refundable",
 *    "can't", "re-entry", "low-cost" and "5-year" are single tokens and never
 *    match "refundable", "can", "entry", "cost" or "year";
 *  - numeric expressions are cohesive (N3): any punctuation or symbol between
 *    two digits (".", ",", "٫", "٬", "·", "−", "⁄", "/", ":", "'", ...), a
 *    digit-group space (NBSP, figure, thin, narrow NBSP), a spaced range
 *    ("10 - 15", "10 – 15", "10 ~ 15") and a leading sign ("-5", "−5", "+5")
 *    stay inside the number token;
 *  - ambiguous numeric boundaries fail closed: a match whose first/last label
 *    token is a number is rejected when the adjacent question token is another
 *    number, or a range/ratio connector ("to", "through", "and", "or", "of",
 *    "by", "x", "vs", ...) followed by a number ("1 000 users", "between 5 and
 *    10 years", "3 of 5 users");
 *  - no synonyms, stemming, plural folding, semantic similarity or model judgment;
 *  - a missing/empty question, or a label with no tokens, fails closed to "model".
 *
 * Known, accepted limitations (all fail closed, never over-attribute):
 *  - scripts written without spaces (e.g. Chinese, Japanese, Thai) tokenize as
 *    whole runs, so a criterion embedded in a longer run is not recognized;
 *  - inflected forms ("costs" vs "cost") are not recognized;
 *  - spaced and hyphenated forms are different units ("time to deploy" does not
 *    match "time-to-deploy"); order matters; scattered words never match.
 *
 * Model-written labels are display text, never provenance metadata (N1): the
 * trusted provenance is rendered outside the label (a separate tag in the UI;
 * in Receipt text, between "Criterion" and the colon, a position model text
 * cannot occupy), and criterionDisplayLabel() removes any leading or trailing
 * bracketed / dash-separated segment that makes an origin claim (mentions the
 * user, the request, or provenance together with provided / stated / supplied /
 * given / specified / requested / verified / origin), so a label cannot imitate
 * a provenance statement.
 *
 * Legacy disclosure (N2) is gated on trusted structure only: the record's
 * system-written schemaId must be "decision_support", a result carrying the
 * current marker never triggers it, and only a basis line in the retired
 * criterion-line format ("Criterion: <label> (user-provided)", not an
 * assessment line, which always contains " × ") counts. New Receipts never
 * write that format (the tag moved, labels are sanitized), so model text cannot
 * produce it. A pre-6A criterion label that itself contained " × " would not be
 * recognized (documented false negative).
 *
 * This module is imported by client components, so it must stay free of
 * server-only dependencies.
 */

import type { AggregatedDecisionCriterion, DecisionSupportResult } from "./types";

/** Provenance-generation marker persisted on every DecisionSupportResult aggregated under this rule. */
export const CRITERIA_PROVENANCE_RULE = "request_text_v1" as const;
export type CriteriaProvenanceRule = typeof CRITERIA_PROVENANCE_RULE;

/** Invisible format characters (Unicode Cf: soft hyphen, zero-width space/joiners, BOM, word joiner, bidi marks). Removed, never treated as separators. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** Digit-group spaces used as thousands separators in some locales. */
const GROUP_SPACES = "\\u00A0\\u2007\\u2009\\u202F";
/** A spaced numeric range ("10 - 15", "10 – 15", "10 ~ 15") is collapsed to one expression before tokenizing. */
const SPACED_RANGE = new RegExp(`(\\p{N})[\\s${GROUP_SPACES}]*([-\\u2010-\\u2015\\u2212~])[\\s${GROUP_SPACES}]*(?=\\p{N})`, "gu");
const W = "\\p{L}\\p{N}\\p{M}";
/**
 * One cohesive lexical unit: an optional leading sign before a digit, then letter/number/mark runs joined by
 * (a) any punctuation, symbol or digit-group space BETWEEN TWO DIGITS, or (b) a hyphen or apostrophe between two
 * letters/digits (owner policy N4: compounds and contractions are single units).
 */
const TOKEN = new RegExp(
  `(?:(?<![${W}])[-\\u2212+](?=\\p{N}))?[${W}]+(?:(?:(?<=\\p{N})[\\p{P}\\p{S}${GROUP_SPACES}](?=\\p{N})|(?<=[${W}])[-\\u2010\\u2011'\\u2019\\u02BC](?=[${W}]))[${W}]+)*`,
  "gu"
);

/** Normalized tokens: NFKC, lowercase, format characters removed, spaced ranges collapsed, then cohesive TOKEN units. */
export function provenanceTokens(text: string | null | undefined): string[] {
  if (typeof text !== "string") return [];
  return text.normalize("NFKC").toLowerCase().replace(FORMAT_CHARS, "").replace(SPACED_RANGE, "$1$2").match(TOKEN) ?? [];
}

const HAS_DIGIT = /\p{N}/u;
/** Words that join two numbers into one range / ratio / alternative ("5 to 10", "3 of 5", "2 x 4"). */
const NUMERIC_CONNECTORS = new Set(["to", "through", "thru", "till", "until", "and", "or", "of", "by", "x", "vs", "versus", "per"]);
function numericNeighbour(tokens: string[], at: number, step: -1 | 1): boolean {
  const t = tokens[at];
  if (t === undefined) return false;
  if (HAS_DIGIT.test(t)) return true;
  const next = tokens[at + step];
  return NUMERIC_CONNECTORS.has(t) && next !== undefined && HAS_DIGIT.test(next);
}

/**
 * True only when `needle` occurs in `haystack` as a contiguous, same-order run of whole tokens AND that occurrence
 * is not an ambiguous fragment of a larger numeric expression (fail closed).
 */
function containsTokenRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  const firstNumeric = HAS_DIGIT.test(needle[0]);
  const lastNumeric = HAS_DIGIT.test(needle[needle.length - 1]);
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    if (firstNumeric && numericNeighbour(haystack, i - 1, -1)) continue;
    if (lastNumeric && numericNeighbour(haystack, i + needle.length, 1)) continue;
    return true;
  }
  return false;
}

/** An origin claim: mentions the user / request / provenance AND an origin verb or status. Matched on NFKC, Cf-free, lowercase text. */
const ORIGIN_SUBJECT = /\b(?:user|users|requester|request|requested|customer|client|provenance|origin)\b/u;
const ORIGIN_STATUS = /(?:provid|stat|suppl|given|specif|request|verif|origin|provenance|defin|select|ask)/u;
const isOriginClaim = (segment: string) => {
  const t = segment.toLowerCase();
  return ORIGIN_SUBJECT.test(t) && ORIGIN_STATUS.test(t.replace(ORIGIN_SUBJECT, " ")) || /\buser\s*[-‐-―]?\s*provided\b/u.test(t);
};
const TRAILING_PUNCT = /[\s.!?,;:。．！？，；：]+$/u;
const TRAILING_BRACKETED = /\s*[([{<«〈【]([^()[\]{}<>«»〈〉【】]*)[)\]}>»〉】]\s*$/u;
const LEADING_BRACKETED = /^\s*[([{<«〈【]([^()[\]{}<>«»〈〉【】]*)[)\]}>»〉】]\s*/u;
const TRAILING_DASHED = /^(.*\S)\s+[-‐-―|:~]\s+(.+)$/u;
export const UNLABELLED_CRITERION = "Unlabelled criterion";

/**
 * Display text for a model-written criterion label (N1): removes any leading / trailing bracketed or spaced-dash
 * segment that makes an origin claim (and trailing punctuation left behind), repeatedly. A label with no such segment
 * is returned unchanged, byte for byte; substantive bracketed content ("Cost (USD)", "API (user-facing)") is kept.
 */
export function criterionDisplayLabel(label: string): string {
  const raw = typeof label === "string" ? label : "";
  let probe = raw.normalize("NFKC").replace(FORMAT_CHARS, "");
  let changed = false;
  for (let guard = 0; guard < 8; guard++) {
    const trimmed = probe.replace(TRAILING_PUNCT, "");
    let m = TRAILING_BRACKETED.exec(trimmed);
    if (m && isOriginClaim(m[1])) { probe = trimmed.slice(0, m.index); changed = true; continue; }
    m = TRAILING_DASHED.exec(trimmed);
    if (m && isOriginClaim(m[2])) { probe = m[1]; changed = true; continue; }
    m = LEADING_BRACKETED.exec(trimmed);
    if (m && isOriginClaim(m[1])) { probe = trimmed.slice(m[0].length); changed = true; continue; }
    break;
  }
  if (!changed) return raw;
  const out = probe.replace(TRAILING_PUNCT, "").trim();
  return out.length > 0 ? out : UNLABELLED_CRITERION;
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

/**
 * Decision Receipt criterion tags (N1). The trusted tag is written BETWEEN "Criterion" and the colon
 * ("Criterion (stated in request): Total cost"), a position the model-written label can never occupy; a
 * model-identified criterion has no tag ("Criterion: Total cost").
 */
export const RECEIPT_TAG_USER = " (stated in request)";
export const RECEIPT_TAG_UNVERIFIED = " (provenance unverified)";
/** The retired suffix written by Receipts built before Item 6A (model self-report). Only ever READ, to disclose it. */
export const LEGACY_RECEIPT_SUFFIX_USER_PROVIDED = " (user-provided)";

export function receiptCriterionTag(provenance: CriterionProvenance): string {
  if (provenance === "user") return RECEIPT_TAG_USER;
  if (provenance === "unverified_legacy") return RECEIPT_TAG_UNVERIFIED;
  return "";
}

/** The one Receipt criterion-line format: system-written tag before the colon, sanitized model label after it. */
export function receiptCriterionLine(label: string, provenance: CriterionProvenance): string {
  return `Criterion${receiptCriterionTag(provenance)}: ${criterionDisplayLabel(label)}`;
}

export const LEGACY_PROVENANCE_LIMITATION =
  "Criterion provenance for this earlier run was reported by the models and could not be verified against the request.";

/** Dashboard note for a historical (unmarked) result that carries model-reported "user" criteria. Viewer-neutral (F7). */
export const LEGACY_RESULT_NOTICE =
  "Original request provenance could not be independently established for this historical result. Criteria the models reported as user-provided are marked unverified.";

export const LEGACY_FROZEN_RECEIPT_NOTICE =
  "This Receipt was frozen before criterion provenance was checked against the request. Its \"(user-provided)\" labels were reported by the models and are unverified.";

/** Trusted structure the legacy check needs: the record's system-written schemaId and, where the surface has the stored result, its provenance marker. */
export interface LegacyReceiptContext {
  schemaId: string | null | undefined;
  /** The stored result's `criteriaProvenance`, when the surface has the result (exports). Omit when not available (review pages). */
  resultProvenanceMarker?: unknown;
}

/**
 * True when a (possibly frozen) Receipt is a pre-6A Decision Support Receipt carrying a criterion line in the retired
 * self-report format (N2): trusted schemaId must be decision_support, a result carrying the current marker never
 * qualifies, and only a line "Criterion: <label> (user-provided)" that is not an assessment line (" × ") counts.
 */
export function receiptHasLegacyUserProvidedCriteria(basis: readonly string[], context: LegacyReceiptContext): boolean {
  if (context.schemaId !== "decision_support") return false;
  if (context.resultProvenanceMarker === CRITERIA_PROVENANCE_RULE) return false;
  return basis.some((line) => typeof line === "string" && line.startsWith("Criterion: ") && line.endsWith(LEGACY_RECEIPT_SUFFIX_USER_PROVIDED) && !line.includes(" \u00d7 "));
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
  "Derived when this export was rendered; not part of the historical record. recordedSource is the value stored at the time (a model self-report on results without a provenance marker); derivedProvenance is how it is presented now. Original request provenance could not be independently established for criteria marked unverified_legacy.";

export function deriveCriteriaProvenanceDisclosure(schemaId: string, result: unknown, receipt: { basis?: unknown } | undefined | null): DerivedCriteriaProvenanceDisclosure | undefined {
  if (schemaId !== "decision_support" || !result || typeof result !== "object") return undefined;
  const r = result as { criteria?: unknown; criteriaProvenance?: unknown };
  const criteria = Array.isArray(r.criteria) ? (r.criteria as { id?: unknown; label?: unknown; source?: unknown }[]) : [];
  const marker = r.criteriaProvenance === CRITERIA_PROVENANCE_RULE ? CRITERIA_PROVENANCE_RULE : null;
  const basis = Array.isArray(receipt?.basis) ? (receipt!.basis as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const legacyReceipt = receiptHasLegacyUserProvidedCriteria(basis, { schemaId, resultProvenanceMarker: r.criteriaProvenance });
  const rows = criteria.map((c) => {
    const recordedSource: "user" | "model" = c?.source === "user" ? "user" : "model";
    return { id: typeof c?.id === "string" ? c.id : "", label: typeof c?.label === "string" ? c.label : "", recordedSource, derivedProvenance: readCriterionProvenance({ criteriaProvenance: marker ?? undefined }, { source: recordedSource }) };
  });
  const unverifiedResult = rows.some((x) => x.derivedProvenance === "unverified_legacy");
  if (!unverifiedResult && !legacyReceipt) return undefined;
  return { derivedAtExport: true, derivedRule: CRITERIA_PROVENANCE_RULE, note: DERIVED_DISCLOSURE_NOTE, resultProvenanceMarker: marker, storedReceiptHasLegacyUserProvidedLabels: legacyReceipt, criteria: rows };
}
