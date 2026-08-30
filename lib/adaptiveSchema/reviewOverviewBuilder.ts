/**
 * Decision Receipt Presentation + Source Enrichment, Phase 10D.1
 * (corrected in Phase 10D.1C, corrected again in Phase 10D.1C2) — a
 * deterministic, zero-LLM-call "Review Overview" paragraph orienting a
 * Team Workspace reviewer before they read the full Decision Receipt: the
 * question asked, how much of the panel actually contributed usable
 * material, and a concise, accurate indication of what the panel actually
 * found — never the complete substantive reasoning itself, which belongs
 * to "Panel Conclusion" (`decisionReceiptBuilder.ts`'s already-computed
 * `conclusion`, rendered verbatim and unabridged by
 * `DecisionReceiptSection.tsx`).
 *
 * FROZEN RESPONSIBILITY SPLIT (10D.1C, reaffirmed 10D.1C2):
 *   Review Overview  = orientation + participation + concise RESULT DIRECTION
 *   Panel Conclusion = the full substantive synthesized finding
 *
 * 10D.1C2 CORRECTION — WHY THIS CHANGED AGAIN: the 10D.1C version refused
 * to excerpt any single-sentence conclusion at all (treating "first
 * sentence spans the whole conclusion" as "no safe excerpt exists"), and
 * fell back to a neutral, content-free `sourceBacked`-derived sentence
 * instead. Since most of the 9 schemas' conclusions ARE a single sentence,
 * that meant the overwhelmingly common case silently omitted the actual
 * Panel result and substituted source-provenance status for it —
 * `sourceBacked` answers "did the panel cite sources," not "what did the
 * panel conclude." That is a real product defect, not a style choice: the
 * Review Overview's whole purpose is to let a reviewer read one paragraph
 * and know broadly what the panel found.
 *
 * CORRECTED NON-REDUNDANCY CONTRACT (10D.1C2): the goal is LOW REDUNDANCY
 * + COMPLETE ORIENTATION, not zero textual overlap at any cost.
 *   - Genuinely multi-sentence conclusion: excerpt only the first sentence
 *     (hard-bounded, Unicode-safe truncation if that sentence itself
 *     exceeds the excerpt budget — see `hardBoundedTruncate()` below) — a
 *     strictly shorter, non-verbatim excerpt of the whole.
 *   - Single-sentence (or no detectable terminal punctuation) conclusion
 *     at or under `MAX_EXCERPT_CODE_POINTS`: used in full. Some overlap
 *     with "Panel Conclusion" is unavoidable here — the conclusion is
 *     already concise — but omitting it entirely to avoid that overlap
 *     would fail the actual product requirement (communicate the
 *     Panel's result), so a short verbatim quote is accepted
 *     deliberately.
 *   - Single-sentence conclusion over `MAX_EXCERPT_CODE_POINTS`:
 *     hard-bounded, Unicode-safe truncation with an ellipsis — still a
 *     genuine, strictly shorter excerpt, never the complete text.
 * See `buildConclusionExcerpt()` for the implementation of this contract.
 * `MAX_EXCERPT_CODE_POINTS` (150) is chosen so the result-direction
 * clause reads as roughly one clause of a paragraph — long enough to
 * carry a real single-sentence conclusion in full, short enough that a
 * multi-sentence or run-on conclusion still gets meaningfully condensed
 * rather than reproduced.
 *
 * HARD-BOUNDED, UNICODE-SAFE TRUNCATION (10D.1C3 — corrects 10D.1C2):
 * the 10D.1C2 `wordBoundaryTruncate()` had two real defects, both found by
 * independent review and confirmed by direct execution: (1) its "no space
 * within budget" fallback searched FORWARD for the next whitespace with
 * no re-cap, so a long unbroken token (a URL, a base64 blob, any run-on
 * text — none of which is bounded by the upstream per-field `maxWords`
 * check, since a single unbroken token counts as exactly one "word" no
 * matter how many characters long) could produce an excerpt of
 * unbounded length; (2) it truncated by raw UTF-16 `.slice()` index,
 * which can split a surrogate pair (a non-BMP character — many emoji —
 * is TWO UTF-16 code units but ONE Unicode code point) and leave an
 * unpaired surrogate in the output, rendering as a broken glyph.
 *
 * `hardBoundedTruncate()` replaces it with a strict contract: the
 * returned string, INCLUDING any appended ellipsis, never exceeds
 * `MAX_EXCERPT_CODE_POINTS` Unicode code points — code points, not UTF-16
 * code units, specifically so a surrogate pair is never split. For
 * ordinary spaced prose it prefers the last whitespace boundary that fits
 * the budget (reserving one code point for the ellipsis); when no such
 * boundary exists within budget (the pathological unbroken-token case),
 * it hard-cuts at the code-point-safe limit rather than searching past
 * it — boundedness always wins over preserving a whole token. There is
 * no longer any "extend forward" branch at all. Trailing
 * punctuation/whitespace is stripped before the ellipsis is appended so
 * an excerpt never ends in an artifact like `"..."` or `"?..."`.
 *
 * Grapheme-cluster-perfect truncation (never splitting a base character
 * from a combining mark) is intentionally NOT attempted here — code-point
 * safety already prevents the visibly-broken-glyph failure mode
 * (unpaired surrogates); a combining mark separated from its base is a
 * much smaller cosmetic edge case, and reaching for full grapheme
 * segmentation would mean a new dependency for a phase scoped narrowly
 * to closing the two confirmed P2s.
 *
 * NO SEMANTIC REWRITING: every excerpt is a raw substring starting at
 * position 0 of the (trimmed) conclusion — never reordered, paraphrased,
 * or re-punctuated beyond trailing-artifact cleanup. Because truncation
 * only ever removes text from the END, a leading qualifier ("not", "may",
 * "is unclear whether") is always preserved; polarity and certainty can
 * never be flipped by this process.
 *
 * PARTICIPATION SEMANTICS (10D.1C correction, unchanged by 10D.1C2 — see
 * commonResponseMeta.ts): `totalModels` = every model this run actually
 * dispatched a call to (`ModelResult[]` passed into `finalizeAdaptiveRun`
 * — the full attempted set, per this codebase's
 * `Promise.allSettled`-over-the-connector-map architecture).
 * `modelsWithUsableOutput` = the strictly narrower count of those that
 * BOTH succeeded at the connector level AND passed adaptive schema
 * validation. `successfulModels` (connector-level success only) is
 * deliberately NOT an input to this module — using it for "usable"
 * wording would overstate panel participation.
 *
 * `sourceBacked`/`humanReviewNeeded` are neutral workflow/provenance
 * signals, not result direction — kept only as a supplemental sentence
 * when human review was flagged; `sourceBacked` is no longer read by this
 * module at all as of 10D.1C2 (it added no information beyond what
 * `DecisionReceiptSection.tsx` already displays as its own badge directly
 * under Panel Conclusion, and it must never substitute for actual result
 * content).
 *
 * Deliberately does NOT attempt a per-schema "the panel agreed/disagreed"
 * classification — no single canonical convergence signal exists across
 * all 9 dedicated schemas, and inventing one here would be exactly the
 * kind of new supporting reasoning Phase 10D.1/10D.1C/10D.1C2 are scoped
 * to avoid (that's 10D.2's job, per-schema, if pursued at all).
 */

const MAX_OVERVIEW_QUESTION_LENGTH = 200; // mirrors reviewContext.ts's existing truncateRunLabel() precedent
/**
 * Unicode CODE POINTS, not UTF-16 code units or bytes — this is the
 * maximum length of the FINAL returned excerpt, ellipsis included. See
 * `hardBoundedTruncate()`. 150 is long enough to carry a real
 * single-sentence conclusion in full, short enough to meaningfully
 * condense a longer one.
 */
const MAX_EXCERPT_CODE_POINTS = 150;
const ELLIPSIS = "…"; // a single Unicode code point — its budget is reserved explicitly in hardBoundedTruncate()

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function usableResultsClause(count: number): string {
  return count === 1 ? `${count} produced a usable result` : `${count} produced usable results`;
}

function truncateForOverview(s: string): string {
  const t = s.trim();
  return t.length <= MAX_OVERVIEW_QUESTION_LENGTH ? t : `${t.slice(0, MAX_OVERVIEW_QUESTION_LENGTH)}…`;
}

/** Strips trailing whitespace/punctuation so an ellipsis never follows another punctuation mark (no "...", "?...", etc.). */
function stripTrailingPunctuation(s: string): string {
  return s.replace(/[\s.,;:!?…\-–—]+$/, "");
}

/** Number of Unicode code points in `s` — `Array.from` iterates by code point, so a surrogate-pair (non-BMP) character counts as one, not two. */
function codePointLength(s: string): number {
  return Array.from(s).length;
}

/**
 * Truncates `s` to at most `maxCodePoints` UNICODE CODE POINTS — never
 * UTF-16 code units — including any appended ellipsis. This is a hard
 * bound: no branch below may return a string longer than `maxCodePoints`
 * code points, regardless of input. See file header HARD-BOUNDED,
 * UNICODE-SAFE TRUNCATION for the two defects this fixes.
 *
 * Policy: prefer the last whitespace boundary that fits within budget
 * (ordinary spaced prose); if none exists within budget (a pathological
 * unbroken token), hard-cut at the code-point-safe content limit — never
 * search or extend past `maxCodePoints` to preserve a whole token.
 */
function hardBoundedTruncate(s: string, maxCodePoints: number): string {
  if (codePointLength(s) <= maxCodePoints) return s;

  const contentBudget = maxCodePoints - 1; // reserve exactly one code point for the ellipsis
  const codePoints = Array.from(s);
  const withinBudget = codePoints.slice(0, contentBudget);

  let lastWhitespaceIndex = -1;
  for (let i = withinBudget.length - 1; i > 0; i--) {
    if (/\s/.test(withinBudget[i])) {
      lastWhitespaceIndex = i;
      break;
    }
  }

  const contentStr = lastWhitespaceIndex > 0 ? withinBudget.slice(0, lastWhitespaceIndex).join("") : withinBudget.join("");

  return `${stripTrailingPunctuation(contentStr)}${ELLIPSIS}`;
}

interface ConclusionExcerpt {
  /** The excerpt text, never semantically rewritten — always a raw prefix of the trimmed conclusion (possibly the whole thing). */
  text: string;
  /** `true` when `text` is the complete trimmed conclusion (short-conclusion case) — callers use this to choose non-"begins" wording, since the excerpt doesn't "begin" the finding, it IS the finding. */
  isFullConclusion: boolean;
}

/**
 * Deterministic, no-LLM, no-rewriting excerpt of a conclusion for use in
 * the Review Overview. See file header NON-REDUNDANCY CONTRACT for the
 * three cases this implements. Returns `null` only for an empty/blank
 * conclusion — callers must not fabricate result direction in that case.
 */
function buildConclusionExcerpt(conclusion: string): ConclusionExcerpt | null {
  const trimmed = conclusion.trim();
  if (trimmed.length === 0) return null;

  const sentenceMatch = trimmed.match(/^(.+?[.?!])(\s|$)/);
  const firstSentence = sentenceMatch ? sentenceMatch[1].trim() : null;
  const isGenuineMultiSentence = firstSentence !== null && firstSentence.length < trimmed.length;

  if (isGenuineMultiSentence) {
    const sentence = firstSentence as string;
    return { text: hardBoundedTruncate(sentence, MAX_EXCERPT_CODE_POINTS), isFullConclusion: false };
  }

  if (codePointLength(trimmed) <= MAX_EXCERPT_CODE_POINTS) {
    return { text: trimmed, isFullConclusion: true };
  }

  return { text: hardBoundedTruncate(trimmed, MAX_EXCERPT_CODE_POINTS), isFullConclusion: false };
}

export interface ReviewOverviewInput {
  /** The run's own user-visible question — never a hidden/system prompt. */
  question: string;
  /** `null` when `adaptiveOutput.meta` doesn't carry this (e.g. absent/corrupted/pre-Phase-1 persisted output) — omitted from the sentence rather than guessed. Represents every model this run dispatched a call to, not merely a configured/selected count. */
  totalModels: number | null;
  /**
   * `CommonResponseMeta.modelsWithUsableOutput` — models that BOTH
   * connector-succeeded AND passed adaptive schema validation. `null` when
   * unavailable (absent/corrupted `adaptiveOutput`, or a legacy
   * non-Milestone-2 envelope that never computes this field at all) — the
   * participation sentence degrades to a plain attempted-count statement
   * in that case, never silently substituting a different (and looser)
   * metric under the word "usable."
   */
  modelsWithUsableOutput: number | null;
  /** `decisionReceipt.conclusion`, already computed — excerpted per `buildConclusionExcerpt()`, never rewritten. */
  conclusion: string;
  /** `decisionReceipt.sourceBacked` — retained on the input type for backward compatibility with callers, but no longer read by `buildReviewOverview()` as of 10D.1C2 (see file header). */
  sourceBacked: boolean;
  humanReviewNeeded: boolean;
}

/**
 * Pure, deterministic, no I/O. Never throws — every input is already
 * trusted, already-parsed canonical data by the time this is called.
 */
export function buildReviewOverview(input: ReviewOverviewInput): string {
  const sentences: string[] = [];

  const question = truncateForOverview(input.question);
  const questionEndsWithPunctuation = /[.?!…]$/.test(question);
  sentences.push(
    question.length > 0
      ? `This review covers the question: "${question}${questionEndsWithPunctuation ? "" : "."}"`
      : "This review covers a submitted research question."
  );

  if (input.totalModels != null && input.totalModels > 0) {
    sentences.push(
      input.modelsWithUsableOutput != null
        ? `Of ${pluralize(input.totalModels, "model")} attempted, ${usableResultsClause(input.modelsWithUsableOutput)}.`
        : `A panel of ${pluralize(input.totalModels, "model")} was attempted for this review.`
    );
  }

  const excerpt = buildConclusionExcerpt(input.conclusion);
  if (excerpt) {
    sentences.push(excerpt.isFullConclusion ? `The panel's finding: ${excerpt.text}` : `The panel's finding begins: ${excerpt.text}`);
  }

  if (input.humanReviewNeeded) {
    sentences.push("This result was flagged for human review.");
  }

  return sentences.join(" ");
}
