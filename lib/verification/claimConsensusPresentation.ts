/**
 * How a claim verification's stored consensus score is PRESENTED on every claim surface (live result, Personal detail
 * and history, Team detail and list, copied verdict, memo) — the claim counterpart of the research list rule
 * (`CONSENSUS_WITHHELD_TEXT`, lib/panel/independentVoices.ts).
 *
 * A claim's stored `consensusScore` is a cross-model figure. It is presented as a multi-model consensus only when the
 * verification's stored rows prove ≥ 2 independent executing models with a usable answer
 * (`storedVerificationConsensusIndependence`, computed server-side where the record is loaded and carried to the client
 * as `modelIndependence`). Otherwise:
 *  - "insufficient" → no consensus score ("No consensus score (fewer than two independent models)"); the aggregate
 *    verdict is labelled as one model's assessment, never as agreement between models;
 *  - "unverified" (no / malformed `modelIndependence`, or provenance the server could not establish) → the score is
 *    withheld ("Consensus score withheld (model independence not recorded)"), and the verdict is labelled
 *    "Independent-model coverage unverified". Fail closed: a payload that does not carry `modelIndependence` is
 *    "unverified".
 * The stored score, verdict, evidence and audit bundle are never modified — only how they are labelled.
 *
 * Pure and client-safe.
 */

import {
  CONSENSUS_WITHHELD_TEXT,
  consensusScoreWithheldReason,
  type ConsensusScoreWithheldReason,
  type StoredConsensusIndependence,
} from "@/lib/panel/independentVoices";

import { CLAIM_SCORE_SLOT_BASIS_QUALIFIER } from "@/lib/verification/claimVerdictCounts";
import { cachedClaimPayloadScoreBasis, isClaimScoreBasis } from "@/lib/verification/claimStatementBasisSources";

export { CONSENSUS_WITHHELD_TEXT };

/** The independence a claim payload / list item carries; anything missing or unknown is "unverified" (fail closed). */
export function claimModelIndependence(value: unknown): StoredConsensusIndependence {
  return value === "independent" || value === "insufficient" ? value : "unverified";
}

/** Verdict qualifier when the score is not a multi-model consensus. */
export const CLAIM_SINGLE_MODEL_ASSESSMENT_TEXT = "One independent model's assessment — not agreement between models";
export const CLAIM_COVERAGE_UNVERIFIED_TEXT = "Independent-model coverage unverified";

/** Banner subtitles for a verdict that is not a multi-model one. */
export const CLAIM_SINGLE_MODEL_BANNER_SUBTITLE =
  "Fewer than two independent models answered (slots answered by the same substitute model count as one), so this is not a consensus.";
export const CLAIM_UNVERIFIED_BANNER_SUBTITLE =
  "Which models executed could not be established, so this verdict is not presented as agreement between models.";

/** Agreement-digest headings when the rows are not >= 2 independent executing models. */
export const CLAIM_NOT_INDEPENDENT_AGREE_HEADING = "Points repeated across responses (not agreement between independent models)";
export const CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING = "Points that differ across responses (not a disagreement between independent models)";

export type ClaimConsensusDisplay =
  | { kind: "score"; score: number }
  | { kind: "withheld"; reason: ConsensusScoreWithheldReason; text: string };

/**
 * The consensus score to present: the stored number only for "independent"; otherwise the withheld reason and text.
 * An "independent" record without a finite stored score shows it as stored (callers already default it).
 */
export function claimConsensusDisplay(score: unknown, independence: unknown): ClaimConsensusDisplay {
  const reason = consensusScoreWithheldReason(claimModelIndependence(independence));
  if (reason) return { kind: "withheld", reason, text: CONSENSUS_WITHHELD_TEXT[reason] };
  return { kind: "score", score: typeof score === "number" && Number.isFinite(score) ? score : 0 };
}

/** The qualifier for the aggregate verdict, or null when the verdict is a multi-model one. */
export function claimVerdictQualifier(independence: unknown): string | null {
  const i = claimModelIndependence(independence);
  if (i === "independent") return null;
  return i === "insufficient" ? CLAIM_SINGLE_MODEL_ASSESSMENT_TEXT : CLAIM_COVERAGE_UNVERIFIED_TEXT;
}

/** The presentation fields every claim score surface carries (the stored score + the additive keys). */
export type ClaimScoreTextFields = {
  consensusScore?: number | null;
  /** Set when the score is not presented (below two independent executing models, or provenance not established). */
  consensusWithheld?: ConsensusScoreWithheldReason | null;
  /** "slot_responses" → the score carries `CLAIM_SCORE_SLOT_BASIS_QUALIFIER` (R4). Any other value adds nothing. */
  consensusBasis?: unknown;
};

/**
 * R6 owner decision B2 — the qualifier a RETAINED score carries when it is not a multi-model consensus (Audit Log, admin
 * runs tab): the number stays, and the text says why it is not independent model corroboration.
 */
export const CLAIM_SCORE_NOT_INDEPENDENT_QUALIFIER: Readonly<Record<ConsensusScoreWithheldReason, string>> = Object.freeze({
  insufficient_independent_models: "fewer than two independent models, not independent corroboration",
  independence_unverified: "unverified: model independence not recorded",
});

/** R6 owner decision B3 — a Personal history item cached before its basis was recorded: the number, historical and unverified. */
export const CLAIM_SCORE_HISTORICAL_QUALIFIER = "historical score, unverified: model independence not recorded";

/**
 * How a score that is not a multi-model consensus is rendered:
 *  - "withhold" (default; governance queue, legacy Team queue, Personal history): the withheld reason replaces the number;
 *  - "qualify" (R6 B2; governance Audit Log, admin runs tab): the number is kept with `CLAIM_SCORE_NOT_INDEPENDENT_QUALIFIER`;
 *  - "historical" (R6 B3; only the Personal history cache migration): the number is kept with
 *    `CLAIM_SCORE_HISTORICAL_QUALIFIER`.
 */
export type ClaimScoreNotIndependentMode = "withhold" | "qualify" | "historical";
export type ClaimScoreTextOptions = { notIndependent?: ClaimScoreNotIndependentMode };

/**
 * R5 — THE claim consensus-score text renderer. Every surface that prints a claim's stored consensus score as text
 * (governance queue cell and modal, legacy Team review queue, governance Audit Log badge, admin runs tab, Personal
 * history suffix) goes through this one function, so the withheld reason and the R4 slot-basis qualifier cannot drift
 * surface by surface again (review record 16 F, MAJOR-1: they had been added one surface at a time). `format` only
 * shapes the number ("92/100", "Consensus 92/100", …); `empty` is the surface's text for "no stored score".
 * R6: `options.notIndependent` chooses how a score that is not a multi-model consensus is rendered (see above); the
 * default keeps every R5 surface byte-identical. A retained score is never shown without its qualifier, and an unknown
 * withheld reason is treated as unverified (fail closed).
 */
export function claimScoreText(
  row: ClaimScoreTextFields,
  format: (score: number) => string,
  empty: string,
  options?: ClaimScoreTextOptions
): string {
  const mode = options?.notIndependent ?? "withhold";
  if (row.consensusWithheld && mode === "withhold") return CONSENSUS_WITHHELD_TEXT[row.consensusWithheld];
  const score = row.consensusScore;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    // A historical item without a usable number is the explicit unknown state, not an empty line.
    return mode === "historical" && row.consensusWithheld ? CONSENSUS_WITHHELD_TEXT.independence_unverified : empty;
  }
  const text = format(score);
  if (row.consensusWithheld) {
    const qualifier =
      mode === "historical"
        ? CLAIM_SCORE_HISTORICAL_QUALIFIER
        : CLAIM_SCORE_NOT_INDEPENDENT_QUALIFIER[row.consensusWithheld === "insufficient_independent_models" ? "insufficient_independent_models" : "independence_unverified"];
    return `${text} (${qualifier})`;
  }
  return row.consensusBasis === "slot_responses" ? `${text} (${CLAIM_SCORE_SLOT_BASIS_QUALIFIER})` : text;
}

/**
 * The Personal history row suffix for a claim: " · 92 consensus" only for an "independent" record whose basis is proved;
 * otherwise " · <withheld text>", or the qualified number. Sources, in order:
 *  1. R6 B3 — the server item's explicit basis marker (`consensusBasis`, lib/verification/claimStatementBasisSources.ts
 *     `storedClaimScoreBasis`; app/api/user/panel-history sends it on every claim item). A withholding marker, or one
 *     that contradicts the item's recorded independence, withholds; an unknown marker is unverified (fail closed).
 *  2. Without a marker, a live / cached item's payload rows (R5), only when they verify the item's recorded
 *     "independent" (never upgraded).
 *  3. Otherwise an item that recorded "independent" was cached before its basis could be recorded (R6 B3: the cache is
 *     never cleared or rewritten): the number is shown as a historical, unverified score — never as agreement between
 *     independent models. An item whose recorded independence withholds the score is unchanged (withheld).
 */
export function claimHistoryConsensusSuffix(item: {
  consensusScore?: number | null;
  modelIndependence?: unknown;
  consensusBasis?: unknown;
  payload?: Parameters<typeof cachedClaimPayloadScoreBasis>[1];
}): string {
  let reason = consensusScoreWithheldReason(claimModelIndependence(item.modelIndependence));
  let basis: unknown = undefined;
  let mode: ClaimScoreNotIndependentMode = "withhold";
  if (item.consensusBasis !== undefined) {
    if (!isClaimScoreBasis(item.consensusBasis)) reason = "independence_unverified";
    else if (item.consensusBasis === "insufficient_independent_models" || item.consensusBasis === "independence_unverified") reason = reason ?? item.consensusBasis;
    else basis = item.consensusBasis;
  } else if (!reason) {
    basis = cachedClaimPayloadScoreBasis(item.modelIndependence, item.payload);
    if (basis === null) {
      reason = "independence_unverified";
      mode = "historical";
    }
  }
  const text = claimScoreText({ consensusScore: item.consensusScore, consensusWithheld: reason, consensusBasis: basis }, (n) => `${n} consensus`, "", { notIndependent: mode });
  return text ? ` · ${text}` : "";
}
