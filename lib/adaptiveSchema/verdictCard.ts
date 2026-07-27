/**
 * Panel Verdict Card (Synthesis Report Polish, A4)
 *
 * Deterministic, code-enforced — no model call, same rationale as verdict.ts:
 * question restated, top consensus claim, top disagreement, a caveat drawn
 * from the top bias/blind-spot finding, and gate-dependent recommended next
 * steps (VERDICT_NEXT_STEPS in config.ts). Mirrors the legacy
 * PanelVerdictCard's fields (lib/verificationGate/panelVerdict.ts) but reads
 * AlignedClaim rows instead of StructuredSynthesis — same "separate, parallel
 * implementation" rationale as gate.ts/verdict.ts.
 */

import "server-only";
import { AdaptiveBiasFinding, AdaptiveVerdictCard, AlignedClaim } from "./types";
import { AdaptiveGateResult } from "./gate";
import { VERDICT_NEXT_STEPS } from "./config";
import { coreFindingClaim, topSplitClaim } from "./verdict";

export function buildAdaptiveVerdictCard(
  question: string,
  rows: AlignedClaim[],
  gate: AdaptiveGateResult,
  bias: AdaptiveBiasFinding[]
): AdaptiveVerdictCard {
  const consensus = coreFindingClaim(rows);
  const split = topSplitClaim(rows);

  return {
    question,
    topConsensus: consensus?.claimText ?? "No consensus identified.",
    consensusModelCount: consensus
      ? consensus.cells.filter((c) => c && (c.stance === "agrees" || c.stance === "partial")).length
      : 0,
    keyDisagreement: split?.claimText ?? null,
    disagreementDetail: split
      ? split.disagreementType
        ? `Flagged as ${split.disagreementType.replace(/_/g, " ")}.`
        : "Models take different positions — see the disagreement card below for each model's stance."
      : null,
    disagreementModelCount: split ? split.cells.filter(Boolean).length : 0,
    caveat: bias[0]?.description ?? null,
    recommendedNextSteps: VERDICT_NEXT_STEPS[gate.status].slice(0, 3),
  };
}
