/**
 * Decision Receipt Presentation + Source Enrichment, Phase 10D.1
 * (corrected in Phase 10D.1C) — a deterministic, zero-LLM-call "Review
 * Overview" paragraph orienting a Team Workspace reviewer before they
 * read the full Decision Receipt: the question asked, how much of the
 * panel actually contributed usable material, and a brief, non-duplicating
 * indication of the kind of result reached — never the full substantive
 * finding itself, which belongs exclusively to "Panel Conclusion"
 * (`decisionReceiptBuilder.ts`'s already-computed `conclusion`, rendered
 * verbatim and unabridged by `DecisionReceiptSection.tsx`).
 *
 * FROZEN RESPONSIBILITY SPLIT (10D.1C):
 *   Review Overview  = orientation + participation + high-level result KIND
 *   Panel Conclusion = the full substantive synthesized finding
 * The overview must never reproduce the full conclusion text — see
 * `NON_REDUNDANCY CONTRACT` below for how that's structurally guaranteed,
 * not just aspired to.
 *
 * PARTICIPATION SEMANTICS (10D.1C correction — see commonResponseMeta.ts):
 * `totalModels` = every model this run actually dispatched a call to
 * (`ModelResult[]` passed into `finalizeAdaptiveRun` — the full attempted
 * set, per this codebase's `Promise.allSettled`-over-the-connector-map
 * architecture). `modelsWithUsableOutput` = the strictly narrower count of
 * those that BOTH succeeded at the connector level AND passed adaptive
 * schema validation (`commonResponseMeta.ts`'s own doc comment: "a
 * connector 'success' containing malformed JSON does not count here").
 * The PRIOR version of this builder used `successfulModels`
 * (connector-level success only) for wording that said "producing usable
 * results" — a real semantic mismatch, since a model can connector-succeed
 * with unusable (schema-invalid) output. `successfulModels` is
 * deliberately NOT an input to this module at all anymore; only the
 * correct, stricter field is used.
 *
 * NON-REDUNDANCY CONTRACT: the "kind of result" clause is built so the
 * FULL trimmed conclusion can never appear as a substring of the overview.
 * For a genuinely multi-sentence conclusion, only its FIRST sentence is
 * ever excerpted (`firstSentenceExcerpt()`), and that function itself
 * refuses to return an "excerpt" that turns out to BE the whole
 * conclusion (the overwhelmingly common case — most of the 9 schemas'
 * conclusions are exactly one sentence). In that case a neutral,
 * content-free status sentence is used instead, built only from two other
 * already-canonical fields (`sourceBacked`, `humanReviewNeeded`) — never
 * inventing a new cross-schema signal, and never restating what the
 * conclusion actually says.
 *
 * Deliberately does NOT attempt a per-schema "the panel agreed/disagreed"
 * classification — no single canonical convergence signal exists across
 * all 9 dedicated schemas (`disagreements[]`, `isContested`,
 * `lowConfidenceItems`, etc. are schema-specific, not a shared field), and
 * inventing one here would be exactly the kind of new supporting reasoning
 * Phase 10D.1/10D.1C are scoped to avoid (that's 10D.2's job, per-schema,
 * if pursued at all).
 */

const MAX_OVERVIEW_QUESTION_LENGTH = 200; // mirrors reviewContext.ts's existing truncateRunLabel() precedent
const MAX_EXCERPT_LENGTH = 150; // generous enough for one real sentence, still visibly shorter than a multi-sentence conclusion

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

/**
 * Returns the conclusion's first sentence ONLY if it is a genuine, strictly
 * shorter proper excerpt of a real multi-sentence conclusion — `null` for
 * every other case (no detectable sentence boundary, or the "first
 * sentence" turns out to span the entire trimmed conclusion, which is the
 * common single-sentence-conclusion case). Callers must treat `null` as
 * "no safe excerpt exists," never as "use the whole thing instead."
 */
function firstSentenceExcerpt(conclusion: string): string | null {
  const trimmed = conclusion.trim();
  const match = trimmed.match(/^(.+?[.?!])(\s|$)/);
  if (!match) return null;
  const first = match[1].trim();
  if (first.length >= trimmed.length) return null; // the "first sentence" WAS the whole conclusion — no genuine excerpt
  return first.length <= MAX_EXCERPT_LENGTH ? first : `${first.slice(0, MAX_EXCERPT_LENGTH)}…`;
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
  /** `decisionReceipt.conclusion`, already computed — only ever excerpted (first sentence, multi-sentence conclusions only) or referenced by presence, never reproduced in full here. */
  conclusion: string;
  /** `decisionReceipt.sourceBacked` — reused verbatim for the neutral result-kind clause when no safe excerpt exists; never re-derived. */
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

  const conclusion = input.conclusion.trim();
  if (conclusion.length > 0) {
    const excerpt = firstSentenceExcerpt(conclusion);
    sentences.push(
      excerpt
        ? `The panel's finding begins: ${excerpt}`
        : input.sourceBacked
          ? "The panel reached a source-backed conclusion."
          : "The panel reached a conclusion, though no sources were cited."
    );
  }

  if (input.humanReviewNeeded) {
    sentences.push("This result was flagged for human review.");
  }

  return sentences.join(" ");
}
