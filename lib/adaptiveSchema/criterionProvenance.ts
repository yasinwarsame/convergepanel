/**
 * Item 6A — authoritative user-criterion provenance (owner rule, 2026-10-14; structural correction, owner Option A,
 * 2026-11-23).
 *
 * FAIL-CLOSED FALLBACK (owner decision 2026-11-23, after independent review R4 was NOT_CLEAN): free-text matching
 * cannot establish user provenance reliably enough, so NEW results attribute no criterion to the user. Every newly
 * aggregated criterion stores the schema's non-user value (NEW_RESULT_CRITERION_SOURCE), readCriterionProvenance()
 * never returns "user" for a marked result whatever is stored, and every surface presents the criterion neutrally
 * ("Criterion", no origin claim; the limitation says attribution "has not been established"). The matching rule below
 * (classifyCriterionProvenance) is retained for compatibility and documentation only and is NOT called by production
 * code. Historical (unmarked) results and frozen Receipts keep their unverified / legacy disclosures unchanged.
 *
 * The ONLY authority for "this criterion came from the user" is the user's original submitted request QUESTION (never
 * the context field, owner decision F8). Model output is never authoritative for user-origin metadata: the
 * decision_support schema's `userProvidedCriteria` field is a model self-report and is deliberately ignored here.
 *
 * Matching rule (`CRITERIA_PROVENANCE_RULE` = "request_text_v1"). Every criterion starts as "model". It is "user" only
 * when ALL of the following hold; anything uncertain stays "model" (deliberate false negatives, see below):
 *
 *  1. Segmentation. Both texts are NFC-normalized with invisible format characters (Unicode Cf) removed, then split
 *     into WORDS (a letter or digit followed by letters, digits and combining marks) and the GAPS between them. Words
 *     compare by NFKC + lowercase; gaps compare by NFKC with whitespace runs collapsed to one space.
 *  2. The label is a phrase. After trimming whitespace it must begin and end with a word, so a label that carries any
 *     leading or trailing decoration ("Cost (from the question)", "Total cost.") never matches.
 *  3. Literal phrase. The label's words must occur in the question contiguously and in order, and every gap INSIDE the
 *     label must equal the question's gap at that position (so "non-refundable" matches only "non-refundable", "low
 *     cost" never matches "low-cost", "total cost" never matches "total, cost"). Compounds are therefore cohesive.
 *  4. Plain boundaries — an ALLOW-list, not a deny-list. The question text touching the match on each side must be the
 *     start / end of the question or consist only of whitespace, ordinary sentence punctuation (. , ; : ! ?), ASCII /
 *     typographic double quotes and brackets, arranged as a sentence boundary: on the left the character touching the
 *     match is whitespace, an opening bracket/quote, or the start of the question; on the right, closing brackets /
 *     quotes / sentence punctuation may touch the match but must be followed by whitespace or the end of the question.
 *     Every other character — every dash, apostrophe, sign, mathematical, currency or other symbol, any numeric
 *     punctuation, a stray combining mark, any unlisted character — makes the boundary ambiguous and the match fails.
 *     This covers "cost–benefit", "non--refundable", "can´t", "±5", ".5", "3/4", "10:30", "$5" and "5%" without any
 *     per-character substitution.
 *  5. Numeric proximity. When any label word is numeric (contains a digit, or is an English number word), the match
 *     fails if any of the three question words on either side of it is numeric. This covers ranges, ratios and
 *     number-word constructions in any connecting language ("three to five years", "4 out of 5 stars", "1 in 5",
 *     "2 bis 5 Jahre", "1 000 users").
 *  6. A missing / empty question, or a label without words, fails closed to "model". No synonyms, stemming, plural
 *     folding, semantic similarity or model judgment.
 *
 * Deliberate false negatives (product trade-off, owner policy "favor false negatives over false positives"): labels
 * with decoration or trailing punctuation; punctuation inside a phrase that differs from the question ("total, cost");
 * different dash / apostrophe characters inside a compound ("can't" vs "can’t"); a phrase in single quotes or touching
 * any symbol; a numeric criterion near another number ("5 years" in "under $500 and 5 years"); inflected forms;
 * scripts written without spaces (Chinese, Japanese, Thai), where a criterion inside a longer run is not recognized;
 * number words outside English are recognized only when written in digits.
 *
 * Presentation (owner Option A): model-written labels are DATA. They are never rewritten, shortened or sanitized, and
 * provenance is never inferred from the displayed string. The trusted provenance tag is rendered separately — a
 * separate element in the UI; in Receipt text, between "Criterion" and the colon, a position model text cannot occupy —
 * and the label follows as an escaped, double-quoted string (`Criterion (stated in request): "Total cost"`,
 * `Criterion: "Cost (from the question)"`), so a label can neither close its quotes, start a new line nor reorder text.
 *
 * Legacy disclosure (N2) is gated on trusted structure only: the record's system-written schemaId must be
 * "decision_support", a result carrying the current marker never triggers it (exports, which have the stored result),
 * and only a basis line in the retired, UNQUOTED criterion-line format ("Criterion: <label> (user-provided)", not an
 * assessment line, which always contains " × ") counts. Every criterion line this version writes ends with the
 * system-written closing quote, so no model text can produce the retired shape. Review pages do not receive the stored
 * result's marker (documented limitation); there the schemaId gate plus the system-written line structure decide, and
 * a genuine retired line always keeps its notice (fail closed toward disclosure). A pre-6A label that itself contained
 * " × " would not be recognized (documented false negative).
 *
 * This module is imported by client components, so it must stay free of server-only dependencies.
 */

import type { AggregatedDecisionCriterion, DecisionSupportResult } from "./types";

/** Provenance-generation marker persisted on every DecisionSupportResult aggregated under this rule. */
export const CRITERIA_PROVENANCE_RULE = "request_text_v1" as const;
export type CriteriaProvenanceRule = typeof CRITERIA_PROVENANCE_RULE;

/** Invisible format characters (Unicode Cf: soft hyphen, zero-width space/joiners, BOM, word joiner, bidi marks). Removed, never treated as separators. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** A word: a letter or digit, then letters, digits and combining marks. A combining mark can never start a word. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/** A text split into words and the gaps around them: gaps[i] precedes words[i]; gaps[words.length] follows the last word. */
export interface ProvenanceSegments {
  words: string[];
  gaps: string[];
}

const wordKey = (w: string) => w.normalize("NFKC").toLowerCase().replace(FORMAT_CHARS, "");
const gapKey = (g: string) => g.normalize("NFKC").replace(FORMAT_CHARS, "").replace(/\s+/gu, " ");

export function provenanceSegments(text: string | null | undefined): ProvenanceSegments {
  if (typeof text !== "string") return { words: [], gaps: [""] };
  const s = text.normalize("NFC").replace(FORMAT_CHARS, "");
  const words: string[] = [];
  const gaps: string[] = [];
  let last = 0;
  for (const m of s.matchAll(WORD)) {
    gaps.push(gapKey(s.slice(last, m.index)));
    words.push(wordKey(m[0]));
    last = m.index! + m[0].length;
  }
  gaps.push(gapKey(s.slice(last)));
  return { words, gaps };
}

/** Boundary allow-list. Anything not listed here is ambiguous. */
const SPACE = /^\s$/u;
const SENTENCE = new Set([".", ",", ";", ":", "!", "?"]);
const OPENERS = new Set(['"', "“", "„", "«", "(", "[", "{"]);
const CLOSERS = new Set(['"', "”", "»", ")", "]", "}"]);
const allowedBoundaryChar = (c: string) => SPACE.test(c) || SENTENCE.has(c) || OPENERS.has(c) || CLOSERS.has(c);

/** Left of the match: start of question, or allowed characters whose part touching the match is only opening brackets/quotes after whitespace. */
function plainLeft(gap: string, atStart: boolean): boolean {
  const chars = [...gap];
  if (!chars.every(allowedBoundaryChar)) return false;
  let i = chars.length;
  while (i > 0 && OPENERS.has(chars[i - 1])) i--;
  if (i === 0) return atStart;
  return SPACE.test(chars[i - 1]);
}

/** Right of the match: end of question, or allowed characters whose part touching the match is only closers / sentence punctuation, then whitespace. */
function plainRight(gap: string, atEnd: boolean): boolean {
  const chars = [...gap];
  if (!chars.every(allowedBoundaryChar)) return false;
  let i = 0;
  while (i < chars.length && (CLOSERS.has(chars[i]) || SENTENCE.has(chars[i]))) i++;
  if (i === chars.length) return atEnd;
  return SPACE.test(chars[i]);
}

/** English number words (digits are recognized in every script through \p{N}). */
const NUMBER_WORDS = new Set(
  (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen " +
    "eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion trillion " +
    "dozen half quarter first second third fourth fifth sixth seventh eighth ninth tenth"
  ).split(" ")
);
const isNumericWord = (w: string) => /\p{N}/u.test(w) || NUMBER_WORDS.has(w);
const NUMERIC_WINDOW = 3;

function matchesAt(q: ProvenanceSegments, l: ProvenanceSegments, i: number): boolean {
  const n = l.words.length;
  for (let j = 0; j < n; j++) {
    if (q.words[i + j] !== l.words[j]) return false;
    if (j > 0 && q.gaps[i + j] !== l.gaps[j]) return false;
  }
  if (!plainLeft(q.gaps[i], i === 0)) return false;
  if (!plainRight(q.gaps[i + n], i + n === q.words.length)) return false;
  if (l.words.some(isNumericWord)) {
    for (let k = Math.max(0, i - NUMERIC_WINDOW); k < i; k++) if (isNumericWord(q.words[k])) return false;
    for (let k = i + n; k < Math.min(q.words.length, i + n + NUMERIC_WINDOW); k++) if (isNumericWord(q.words[k])) return false;
  }
  return true;
}

/** Classifies ONE model-written criterion label, exactly as written, against the user's original request question. Never consults model output. */
export function classifyCriterionProvenance(label: string, originalRequest: string | null | undefined): "user" | "model" {
  const q = provenanceSegments(originalRequest);
  if (q.words.length === 0) return "model";
  const trimmed = typeof label === "string" ? label.replace(FORMAT_CHARS, "").trim() : "";
  const l = provenanceSegments(trimmed);
  const n = l.words.length;
  // The label must be a bare phrase: nothing but words and inner gaps (rule 2).
  if (n === 0 || l.gaps[0] !== "" || l.gaps[n] !== "" || n > q.words.length) return "model";
  for (let i = 0; i + n <= q.words.length; i++) if (matchesAt(q, l, i)) return "user";
  return "model";
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
  // Fail-closed fallback (owner decision 2026-11-23): a marked result never reads as "user", whatever value is
  // stored, so no surface can reconstruct a positive attribution. Unmarked (legacy) "user" values stay unverified.
  if (hasAuthoritativeCriteriaProvenance(result)) return "model";
  return criterion.source === "user" ? "unverified_legacy" : "model";
}

/**
 * The criterion source every newly aggregated result stores (fail-closed fallback): the schema's non-user value. It
 * records only that user attribution was NOT established; presentation is neutral ("Criterion"), never "model-written".
 */
export const NEW_RESULT_CRITERION_SOURCE = "model" as const;

/** Limitation shown for new (marked) results instead of the earlier "inferred rather than user-provided" wording, which claimed an origin the system cannot establish. */
export const UNESTABLISHED_CRITERIA_LIMITATION =
  "Criteria are system-identified; whether any of them was stated in the request has not been established.";
/** The earlier limitation, still used for unmarked historical results so their presentation is unchanged. */
export const LEGACY_INFERRED_CRITERIA_LIMITATION = "The recommendation depends on inferred rather than user-provided criteria.";

/** True when a legacy result carries at least one model-reported "user" criterion that is now shown as unverified. */
export function hasUnverifiedLegacyCriteria(result: Pick<DecisionSupportResult, "criteriaProvenance" | "criteria">): boolean {
  return result.criteria.some((c) => readCriterionProvenance(result, c) === "unverified_legacy");
}

/**
 * Decision Receipt criterion tags (N1). The trusted tag is written BETWEEN "Criterion" and the colon
 * ('Criterion (stated in request): "Total cost"'), a position the model-written label can never occupy; a
 * model-identified criterion has no tag ('Criterion: "Total cost"').
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

/**
 * Escapes model-written text for a one-line textual Receipt: a backslash, every quotation mark that could read as the
 * delimiter (see isQuoteLike), and every character that could break,
 * reorder or hide text — controls, invisible format and bidirectional characters, line / paragraph separators,
 * surrogates, private-use and unassigned code points — are written as visible escapes. All other text, including
 * brackets and words such as "(user-provided)", is kept exactly as the model wrote it.
 */
const ESCAPE_AS_CODE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}\p{Cn}]/u;
/** Quotation marks that could read as the delimiter: anything that NFKC-normalizes to '"', and every initial / final quotation mark except the two typographic apostrophes (U+2018 / U+2019), which stay readable in labels such as "user’s". */
const isQuoteLike = (c: string) => c.normalize("NFKC").includes('"') || (/[\p{Pi}\p{Pf}]/u.test(c) && c !== "\u2018" && c !== "\u2019");
const codeEscape = (c: string) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;
export function escapeReceiptText(text: string): string {
  const s = typeof text === "string" ? text : "";
  let out = "";
  for (const c of s) {
    if (c === "\\") out += "\\\\";
    else if (c === '"') out += '\\"';
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (ESCAPE_AS_CODE.test(c) || isQuoteLike(c)) out += codeEscape(c);
    else out += c;
  }
  return out;
}

/**
 * Line-safety escape for model-written text that is NOT quoted (assessment lines' option and assessment text): only the
 * characters that could break, reorder or hide text are escaped; quotation marks and backslashes are kept as written.
 */
export function escapeReceiptLineText(text: string): string {
  const s = typeof text === "string" ? text : "";
  let out = "";
  for (const c of s) {
    if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (ESCAPE_AS_CODE.test(c)) out += codeEscape(c);
    else out += c;
  }
  return out;
}

/** A model-written label as Receipt data: escaped and enclosed in system-written double quotes. */
export function quoteReceiptLabel(label: string): string {
  return `"${escapeReceiptText(label)}"`;
}

/** The one Receipt criterion-line format: system-written tag before the colon, the model label verbatim (escaped, quoted) after it. */
export function receiptCriterionLine(label: string, provenance: CriterionProvenance): string {
  return `Criterion${receiptCriterionTag(provenance)}: ${quoteReceiptLabel(label)}`;
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
