/**
 * Panel Verdict Card (Synthesis Report Polish, A4)
 *
 * Deterministic, code-enforced — no model call, same rationale as verdict.ts:
 * question restated, top consensus claim, top disagreement, a caveat drawn
 * from the top bias/blind-spot finding, and gate-dependent recommended next
 * steps (VERDICT_NEXT_STEPS in config.ts). Selection and counts are computed
 * here; the claim texts and the caveat are model-written (clusterer, bias
 * call), so the card also carries each claim's computed status and marks the
 * caveat's source (R4-1) — renderers show them through agreementNarrative.ts. Mirrors the legacy
 * PanelVerdictCard's fields (lib/verificationGate/panelVerdict.ts) but reads
 * AlignedClaim rows instead of StructuredSynthesis — same "separate, parallel
 * implementation" rationale as gate.ts/verdict.ts.
 */

import "server-only";
import { AdaptiveBiasFinding, AdaptiveVerdictCard, AlignedClaim } from "./types";
import { AdaptiveGateResult } from "./gate";
import { CAUTION_NEXT_STEP_WITHOUT_DISAGREEMENT, VERDICT_NEXT_STEPS } from "./config";
import { NO_CONSENSUS_IDENTIFIED, coreFindingClaim, topSplitClaim } from "./verdict";
import { describeContested } from "./consensusIntegrity";
import { renderRowStatus, rowAgreementFacts } from "./agreementNarrative";

export function buildAdaptiveVerdictCard(
  question: string,
  rows: AlignedClaim[],
  gate: AdaptiveGateResult,
  bias: AdaptiveBiasFinding[],
  /** Every dispatched model (the D3 denominator); when given, the card carries each claim's computed status. */
  dispatchedPanelSize?: number
): AdaptiveVerdictCard {
  const consensus = coreFindingClaim(rows);
  const split = topSplitClaim(rows);
  const topConsensusContested = consensus ? describeContested(consensus) : null;
  const status = (row: AlignedClaim | null) =>
    row && dispatchedPanelSize !== undefined ? renderRowStatus(rowAgreementFacts(row, dispatchedPanelSize)) : null;
  const topConsensusAgreement = status(consensus);
  const keyDisagreementAgreement = status(split);
  const caveat = bias[0]?.description ?? null;

  return {
    question,
    topConsensus: consensus?.claimText ?? NO_CONSENSUS_IDENTIFIED,
    consensusModelCount: consensus
      ? consensus.cells.filter((c) => c && (c.stance === "agrees" || c.stance === "partial")).length
      : 0,
    ...(topConsensusContested ? { topConsensusContested } : {}),
    ...(topConsensusAgreement ? { topConsensusAgreement } : {}),
    keyDisagreement: split?.claimText ?? null,
    ...(keyDisagreementAgreement ? { keyDisagreementAgreement } : {}),
    disagreementDetail: split
      ? split.disagreementType
        ? `Flagged as ${split.disagreementType.replace(/_/g, " ")}.`
        : "Models take different positions — see the disagreement card below for each model's stance."
      : null,
    disagreementModelCount: split ? split.cells.filter(Boolean).length : 0,
    caveat,
    ...(caveat ? { caveatSource: "model_bias_check" as const } : {}),
    recommendedNextSteps: recommendedNextSteps(gate, split),
  };
}

/** VERDICT_NEXT_STEPS for the gate; a caution run with no split claim gets a first step that names no disagreement (D3). */
function recommendedNextSteps(gate: AdaptiveGateResult, split: AlignedClaim | null): string[] {
  const steps = VERDICT_NEXT_STEPS[gate.status];
  if (gate.status === "caution" && !split) return [CAUTION_NEXT_STEP_WITHOUT_DISAGREEMENT, ...steps.slice(1)].slice(0, 3);
  return steps.slice(0, 3);
}
