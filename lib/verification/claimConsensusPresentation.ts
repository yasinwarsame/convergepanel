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

/**
 * The Personal history row suffix for a claim: " · 92 consensus" only for an "independent" record (the server sends the
 * independence with every history row; a live result carries it from the verify response); otherwise
 * " · <withheld text>" — a row that does not carry its independence (e.g. one cached before it existed) is
 * "unverified", never shown as a consensus.
 */
export function claimHistoryConsensusSuffix(item: { consensusScore?: number | null; modelIndependence?: unknown }): string {
  const reason = consensusScoreWithheldReason(claimModelIndependence(item.modelIndependence));
  if (reason) return ` · ${CONSENSUS_WITHHELD_TEXT[reason]}`;
  return item.consensusScore !== null && item.consensusScore !== undefined ? ` · ${item.consensusScore} consensus` : "";
}
