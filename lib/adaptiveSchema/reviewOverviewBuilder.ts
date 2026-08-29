/**
 * Decision Receipt Presentation + Source Enrichment, Phase 10D.1 — a
 * deterministic, zero-LLM-call "Review Overview" paragraph summarizing
 * what a Team Workspace reviewer is about to evaluate: the question asked,
 * how many models the panel consulted, the panel's existing conclusion
 * (already computed by `decisionReceiptBuilder.ts` — never re-derived
 * here), and whether the result was flagged for human review.
 *
 * Deliberately does NOT attempt a per-schema "the panel agreed/disagreed"
 * classification — no single canonical convergence signal exists across
 * all 9 dedicated schemas (`disagreements[]`, `isContested`,
 * `lowConfidenceItems`, etc. are schema-specific, not a shared field), and
 * inventing one here would be exactly the "new supporting reasoning" this
 * phase is scoped to avoid (see Phase 10D.1's own scope boundary — that is
 * Phase 10D.2's job, per-schema, if pursued at all). Every sentence below
 * is built only from fields that already exist verbatim on the canonical
 * record — nothing is inferred or invented.
 */

const MAX_OVERVIEW_QUESTION_LENGTH = 200; // mirrors reviewContext.ts's existing truncateRunLabel() precedent

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function truncateForOverview(s: string): string {
  const t = s.trim();
  return t.length <= MAX_OVERVIEW_QUESTION_LENGTH ? t : `${t.slice(0, MAX_OVERVIEW_QUESTION_LENGTH)}…`;
}

export interface ReviewOverviewInput {
  /** The run's own user-visible question — never a hidden/system prompt. */
  question: string;
  /** `null` when `adaptiveOutput.meta` doesn't carry this (e.g. absent/corrupted/pre-Phase-1 persisted output) — omitted from the sentence rather than guessed. */
  totalModels: number | null;
  successfulModels: number | null;
  /** `decisionReceipt.conclusion`, already computed — reused verbatim, never re-synthesized. */
  conclusion: string;
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

  if (input.totalModels != null && input.successfulModels != null && input.totalModels > 0) {
    sentences.push(
      input.successfulModels === input.totalModels
        ? `A panel of ${pluralize(input.totalModels, "model")} was consulted, and all produced usable results.`
        : `A panel of ${pluralize(input.totalModels, "model")} was consulted, with ${pluralize(input.successfulModels, "model")} producing usable results.`
    );
  }

  const conclusion = input.conclusion.trim();
  if (conclusion.length > 0) {
    sentences.push(`The panel's overall finding: ${conclusion}`);
  }

  if (input.humanReviewNeeded) {
    sentences.push("This result was flagged for human review.");
  }

  return sentences.join(" ");
}
