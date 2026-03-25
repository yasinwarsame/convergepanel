/**
 * Team governance: policies, consensus thresholds, and review workflows.
 */

import type { ConsensusSummary } from "@/lib/verification/consensusScoring";

/**
 * Build a ConsensusSummary for research/synthesis runs so the same policy engine
 * can evaluate team rules. Deterministic for identical inputs.
 */
export function buildResearchConsensusSummary(input: {
  modelCount: number;
  modelsHealthy: number;
  keyFindingsCount: number;
  disagreementsCount: number;
}): ConsensusSummary {
  const { modelCount, modelsHealthy, keyFindingsCount, disagreementsCount } = input;
  const mc = Math.max(1, modelCount);
  const mh = Math.min(modelsHealthy, mc);
  const healthRatio = mh / mc;

  const totalSignals = keyFindingsCount + disagreementsCount;
  const agreementLean =
    totalSignals > 0 ? keyFindingsCount / (totalSignals + 0.5) : 0.55;

  let overallConsensusScore = Math.round(
    28 + 42 * healthRatio + 30 * agreementLean
  );
  overallConsensusScore = Math.max(0, Math.min(100, overallConsensusScore));

  const supportRatio = Math.round(agreementLean * 1000) / 1000;

  let confidenceLabel: "High" | "Medium" | "Low" = "Medium";
  if (overallConsensusScore >= 72 && mh >= Math.ceil(mc * 0.6)) {
    confidenceLabel = "High";
  } else if (overallConsensusScore < 45 || mh < Math.ceil(mc * 0.4)) {
    confidenceLabel = "Low";
  }

  let evidenceQuality: "strong" | "mixed" | "weak" = "mixed";
  if (disagreementsCount <= 1 && keyFindingsCount >= 3) evidenceQuality = "strong";
  if (disagreementsCount >= 4 || mh < Math.ceil(mc * 0.5)) evidenceQuality = "weak";

  const lowEvidenceClaims = Math.max(0, mc - mh);

  return {
    overallConsensusScore,
    supportRatio,
    confidenceLabel,
    evidenceQuality,
    lowEvidenceClaims,
    modelsHealthy: mh,
    modelCount: mc,
  };
}
