/**
 * Order 6 / S-E.1 — the finite contract of the whole-surface wording scanner (owner ruling 2026-10-28, R5).
 *
 * The scanner (dsWordingScanner.ts) is required to prove:
 *   A. no prohibited application-authored wording is rendered on any in-scope Decision Support surface (the fixture
 *      matrix × five surfaces, asserted zero-hit by dsWordingSurfaceScanner.spec.tsx);
 *   B. every phrase in CLAIM_MATRIX below is rejected, in its family;
 *   C. every phrase in LEGITIMATE_MATRIX below is accepted (uncertainty, negation, quantifier-scoped qualification,
 *      completed reviews, approved E-wording);
 *   D. the stored :498 rationale is exempt only as its exact stored value, in its own marked field, under the producer
 *      grammar (isStoredSplitRationale); copies elsewhere, appended text and invalid tallies are rejected;
 *   E. claims split across inline and nested elements are rejected (joined and glued passes);
 *   F. whole rendered surfaces are inspected, including the four actionable receipt surfaces;
 *   G. non-Decision Support presentation is unchanged (nonDsWordingParity.spec.tsx).
 *
 * It is NOT required to detect every conceivable English paraphrase. A sentence outside CLAIM_MATRIX that a family
 * misses is a contract gap to record (and, if the owner decides, a new matrix entry) — not evidence that a currently
 * rendered surface is wrong. Matrix entries are literal strings written independently of the patterns; they must never be
 * generated from the patterns.
 */

/** B: claims each family must reject. Sources: owner R2/R3/R4 rulings and reviewer counterexamples R2–R4, verbatim. */
export const CLAIM_MATRIX: Record<"F2-convergence" | "F3-source-assurance" | "F4-review-necessity", string[]> = {
  "F2-convergence": [
    // R2 / R3 rulings
    "No disagreement.",
    "No split.",
    "All models recommended the same action.",
    "The models are aligned.",
    "All models recommended Go.",
    "Every model chose Option A.",
    // R4 counterexamples (owner R5 list)
    "All three models recommended Go",
    "All panel models recommended Go",
    "Every single model chose Option A",
    "All models recommend Go",
    "Every model picks Option A",
    "3 of 3 models recommended Go",
  ],
  "F3-source-assurance": [
    // R2 / R3 rulings
    "Sources checked.",
    "Sources confirmed.",
    "Sources were independently confirmed.",
    "Sources: confirmed.",
    "References checked.",
    "Citations confirmed.",
    // R4 counterexamples (owner R5 list)
    "Sources — confirmed",
    "Sources: all confirmed",
    "Sources (confirmed)",
    "Sources were cross-checked",
    "Sources were fact-checked",
    // Owner R5: a trailing negation does not qualify a positive verification claim.
    "Sources were confirmed, not merely listed.",
  ],
  "F4-review-necessity": [
    // R2 / R3 rulings
    "Human review is optional.",
    "Human review unnecessary.",
    "Optional human review.",
    "Human review: optional.",
    // R4 counterexamples (owner R5 list)
    "Human review — optional",
    "Human review - optional",
    "Human review: not required",
    "Human review isn't needed",
    "No need for human review",
    "Human review can be skipped",
  ],
};

/** C: statements every family must accept. Sources: owner R3/R5 rulings, reviewer R4 MINOR 2, approved E-wording. */
export const LEGITIMATE_MATRIX: string[] = [
  // Owner R5: accurate qualification of source checking (quantifier and negation scope).
  "Not all sources were confirmed.",
  "Only some sources were checked.",
  "Few sources were confirmed.",
  "No sources were checked.",
  "Sources were not checked.",
  "None of the sources were confirmed.",
  "Only a few references were checked.",
  // Uncertainty and accurate counts.
  "Not all models recommended an action.",
  "2 of 3 models recommended Go.",
  "All models were dispatched.",
  "Each model's full response is shown below.",
  "The system could not confidently identify the option.",
  // Actual completed reviews and neutral review wording.
  "Human review needed",
  "Human review completed: approved by a reviewer.",
  "Review status: Approved",
  "Optional: add a comment for the reviewer.",
  // Approved E-wording (owner rulings).
  "No disagreement identified by current grouping.",
  "Sources listed; not independently verified",
  "System did not flag this for human review.",
  "3 models dispatched; 3 gave a recommendation; largest group recommending the same action: 3. These counts are not a certainty measure.",
  "The current grouping could not reliably identify the recommended option. Review the individual model recommendations before deciding.",
  "Source references are listed as the models gave them; none were fetched or checked",
];
