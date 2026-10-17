/**
 * Panel Verdict + Unified Answer (R1e)
 *
 * Deterministic, code-enforced — never left to a model's discretion. The
 * gate result MUST gate the Unified Answer (fail -> "Panel could not
 * converge", never a confident-sounding synthesis), so both builders here
 * are pure functions over already-scored AlignedClaim rows, not model calls.
 *
 * NOT a call into lib/verificationGate/panelVerdict.ts — that builder reads
 * StructuredSynthesis (executiveSummary/keyFindings/disagreements), a shape
 * this pipeline's AlignedClaim rows don't have. Same rationale as gate.ts.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import { runModelFamilyName } from "@/lib/panel/runModelIdentity";
import { AlignedClaim } from "./types";
import { AdaptiveGateResult } from "./gate";
import { claimSalience } from "./scoring";
import { describeContested, isTopConsensusEligible } from "./consensusIntegrity";
import { NO_CONSENSUS_IDENTIFIED, quoteClaim } from "./agreementNarrative";

/** The canonical no-core-finding text, shared by the panel verdict and the verdict card (defined in agreementNarrative.ts). */
export { NO_CONSENSUS_IDENTIFIED };

export interface AdaptivePanelVerdict {
  /** "{N}/{M} models converge on {core finding}; certainty {score}; gate: {pass|caution|fail}." */
  summary: string;
  coreFinding: string;
  convergingModelCount: number;
  totalModelCount: number;
}

/**
 * Names a slot in generated synthesis text by its product family only
 * ("ChatGPT"). Neither product label source may be used here: lib/modelInfo.ts's
 * MODEL_INFO is stale ("Gemini 3 Pro"), and lib/panelModels.ts's labels
 * ("GPT 5.2") are selection copy that need not match the model this run
 * requested — this text is persisted with the run and must stay true later.
 */
function modelLabel(modelId: ModelId): string {
  return runModelFamilyName(modelId);
}

/**
 * Exported for reuse by verdictCard.ts's topConsensus field: the
 * highest-salience row whose status may be presented as agreement
 * (TOP_CONSENSUS_ELIGIBLE — consensus or majority only). There is no
 * fallback: with no eligible row the panel has no core finding (null), so a
 * split, single_source or limited_coverage row is never presented as "top
 * consensus" / "N models converge on".
 */
export function coreFindingClaim(rows: AlignedClaim[]): AlignedClaim | null {
  const eligible = rows.filter((r) => isTopConsensusEligible(r.status));
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => claimSalience(b) - claimSalience(a))[0];
}

/** Exported for reuse by verdictCard.ts's keyDisagreement field — highest-salience split claim. */
export function topSplitClaim(rows: AlignedClaim[]): AlignedClaim | null {
  const splits = rows.filter((r) => r.status === "split");
  if (splits.length === 0) return null;
  return [...splits].sort((a, b) => claimSalience(b) - claimSalience(a))[0];
}

export function buildAdaptiveVerdict(
  rows: AlignedClaim[],
  gate: AdaptiveGateResult,
  totalModelCount: number
): AdaptivePanelVerdict {
  const core = coreFindingClaim(rows);
  const coreFinding = core?.claimText ?? NO_CONSENSUS_IDENTIFIED;
  const convergingModelCount = core
    ? core.cells.filter((c) => c && (c.stance === "agrees" || c.stance === "partial")).length
    : 0;

  const certaintyPct = Math.round(gate.runCertainty * 100);
  const summary = core
    ? `${convergingModelCount}/${totalModelCount} models converge on ${quoteClaim(coreFinding)}; certainty ${certaintyPct}%; gate: ${gate.status}.`
    : `${NO_CONSENSUS_IDENTIFIED} Certainty ${certaintyPct}%; gate: ${gate.status}.`;

  return { summary, coreFinding, convergingModelCount, totalModelCount };
}

/**
 * 2–4 sentences, only from consensus/majority claims, each citing which
 * models back it. On gate "fail", replaced entirely by "Panel could not
 * converge" plus the split claims — the whole point of R1d's gate rule is
 * that a low-certainty run must never read as a confident synthesis.
 */
export function buildAdaptiveUnifiedAnswer(rows: AlignedClaim[], gate: AdaptiveGateResult): string {
  if (gate.status === "fail") {
    const splitClaims = rows.filter((r) => r.status === "split").slice(0, 5);
    const bullets = splitClaims.map((r) => `- ${quoteClaim(r.claimText)}`).join("\n");
    return [
      "Panel could not converge on a reliable answer.",
      bullets ? `\nUnresolved claims:\n${bullets}` : "",
    ]
      .join("")
      .trim();
  }

  const candidates = rows
    .filter((r) => r.status === "consensus" || r.status === "majority")
    .sort((a, b) => claimSalience(b) - claimSalience(a))
    .slice(0, 4);

  if (candidates.length === 0) {
    const limitedCount = rows.filter((r) => r.status === "limited_coverage").length;
    const base = "No consensus or majority claims were identified across the panel.";
    return limitedCount > 0
      ? `${base} ${limitedCount} claim${limitedCount === 1 ? " had" : "s had"} positions from half or fewer of the dispatched models — too few to count as agreement.`
      : base;
  }

  return candidates
    .map((row) => {
      const supportingModels = row.cells
        .filter((c) => c && (c.stance === "agrees" || c.stance === "partial"))
        .map((c) => modelLabel(c!.modelId));
      const names = supportingModels.length > 0 ? supportingModels.join(", ") : "the panel";
      const contested = describeContested(row);
      return contested ? `${quoteClaim(row.claimText)} (${names}; ${contested}).` : `${quoteClaim(row.claimText)} (${names}).`;
    })
    .join(" ");
}
