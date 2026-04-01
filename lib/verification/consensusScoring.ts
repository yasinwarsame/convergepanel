/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { ClaimVerdict } from "./claimVerdict";
import type { ModelConfidence, ModelVerdict } from "./parseVerificationJson";
import type { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";
import { coerceStatus } from "@/lib/panel/normalize";

export type ConsensusSummary = {
  overallConsensusScore: number;
  supportRatio: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  lowEvidenceClaims: number;
  modelsHealthy: number;
  modelCount: number;
  /** Populated for synthesis runs (optional, non-breaking). */
  highConfidenceClaims?: number;
  contestedClaims?: number;
};

export type ConsensusScoringResult = {
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  summary: ConsensusSummary;
};

type VerificationRow = {
  status: "ok" | "parse_error" | "failed";
  verdict?: ModelVerdict;
  confidence?: ModelConfidence;
};

/**
 * Consensus scoring for claim verification (single claim, multiple model verdicts).
 */
export function computeConsensusScoringForVerification(input: {
  modelRows: VerificationRow[];
  aggregateVerdict: ClaimVerdict;
}): ConsensusScoringResult {
  const modelCount = Math.max(1, input.modelRows.length);
  const usable = input.modelRows.filter((r) => r.status === "ok" && r.verdict);
  const totalUsable = Math.max(1, usable.length);
  const modelsHealthy = usable.length;

  const accurate = usable.filter((r) => r.verdict === "accurate").length;
  const partial = usable.filter((r) => r.verdict === "partially_accurate").length;
  const inaccurate = usable.filter((r) => r.verdict === "inaccurate").length;
  const supportRatio = (accurate + 0.5 * partial) / totalUsable;
  const lowEvidenceClaims =
    usable.filter((r) => r.confidence === "low").length +
    input.modelRows.filter((r) => r.status === "parse_error").length;

  const healthRatio = modelsHealthy / modelCount;
  let verdictBoost = 0;
  switch (input.aggregateVerdict) {
    case "confirmed":
      verdictBoost = 18;
      break;
    case "partially_true":
      verdictBoost = 5;
      break;
    case "disputed":
      verdictBoost = -8;
      break;
    case "unverifiable":
      verdictBoost = -15;
      break;
    default:
      break;
  }
  const disagreementPenalty = inaccurate > 0 && accurate > 0 ? 12 : 0;
  const rawScore =
    40 +
    45 * supportRatio +
    20 * healthRatio -
    disagreementPenalty +
    verdictBoost -
    Math.min(20, lowEvidenceClaims * 5);

  const overallConsensusScore = Math.max(0, Math.min(100, Math.round(rawScore)));

  let confidenceLabel: "High" | "Medium" | "Low" = "Medium";
  if (overallConsensusScore >= 72 && modelsHealthy >= Math.ceil(modelCount * 0.6)) {
    confidenceLabel = "High";
  } else if (overallConsensusScore < 45 || modelsHealthy < Math.ceil(modelCount * 0.4)) {
    confidenceLabel = "Low";
  }

  let evidenceQuality: "strong" | "mixed" | "weak" = "mixed";
  if (lowEvidenceClaims === 0 && supportRatio >= 0.65) evidenceQuality = "strong";
  else if (lowEvidenceClaims >= usable.length * 0.5 || supportRatio < 0.35) evidenceQuality = "weak";

  return {
    consensusScore: overallConsensusScore,
    confidenceLabel,
    summary: {
      overallConsensusScore,
      supportRatio: Math.round(supportRatio * 1000) / 1000,
      confidenceLabel,
      evidenceQuality,
      lowEvidenceClaims,
      modelsHealthy,
      modelCount,
    },
  };
}

/** Alias requested by spec — delegates to verification scoring. */
export function computeConsensusScoring(input: {
  mode: "verification";
  modelRows: VerificationRow[];
  aggregateVerdict: ClaimVerdict;
}): ConsensusScoringResult {
  return computeConsensusScoringForVerification({
    modelRows: input.modelRows,
    aggregateVerdict: input.aggregateVerdict,
  });
}

// ─── Synthesis (structured report) consensus — deterministic, no extra model calls ───

const MIN_RAW_TEXT_LEN = 48;

const NEGATION_NEAR_CLAIM_RE =
  /\b(not|no evidence|incorrect|unlikely|false|deny|contradict|dispute|refute|wrong|myth|doesn't|don't|didn't)\b/i;

export type SynthesisConsensusResultRow = {
  modelId: string;
  status: string;
  rawText?: string | null;
};

export type KeyFindingSupportBlock = {
  supportingModels: string[];
  dissentingModels: string[];
  unknownModels: string[];
  supportRatio: number;
  confidenceLabel: "High" | "Medium" | "Low";
};

export type SynthesisConsensusSummaryDetail = {
  modelsHealthy: number;
  modelCount: number;
  highConfidenceClaims: number;
  contestedClaims: number;
  lowEvidenceClaims: number;
  overallConsensusScore: number;
  /** Mean of per-claim support ratios (0–1). */
  aggregateSupportRatio: number;
};

export type SynthesisConsensusAuditBundle = {
  runId: string;
  timestamp: string;
  models: Array<{ modelId: string; status: string }>;
  overallConsensusScore: number;
  claims: Array<{
    claimTruncated: string;
    supportRatio: number;
    evidenceQuality: "strong" | "mixed" | "weak";
  }>;
};

export type SynthesisConsensusScoringOutput = {
  enrichedSynthesis: StructuredSynthesis;
  consensusSummary: SynthesisConsensusSummaryDetail;
  /** Same rollup shape as verification path for policy engine / storage. */
  policyConsensusSummary: ConsensusSummary;
  auditBundle: SynthesisConsensusAuditBundle;
};

function extractAnchorTokens(claim: string): string[] {
  const raw = claim.trim();
  if (!raw) return [];
  const tokens = new Set<string>();
  for (const m of raw.matchAll(/\b\d+(?:[.,]\d+)?%?\b/g)) {
    tokens.add(m[0].toLowerCase());
  }
  for (const m of raw.matchAll(/"([^"]{2,120})"/g)) {
    const t = m[1].trim().toLowerCase().slice(0, 80);
    if (t.length >= 2) tokens.add(t);
  }
  for (const m of raw.matchAll(/\b([A-Z][a-z]{2,})\b/g)) {
    tokens.add(m[1]);
  }
  return [...tokens].sort((a, b) => a.localeCompare(b)).slice(0, 10);
}

function windowHasNegation(textLower: string, idx: number, needleLen: number): boolean {
  const start = Math.max(0, idx - 40);
  const end = Math.min(textLower.length, idx + needleLen + 40);
  return NEGATION_NEAR_CLAIM_RE.test(textLower.slice(start, end));
}

/**
 * Pragmatic MVP: anchor hit + no negation in window → support; anchor + negation → dissent; else unknown.
 */
export function classifyModelStanceForClaim(text: string, anchors: string[]): "support" | "dissent" | "unknown" {
  if (!text?.trim() || anchors.length === 0) return "unknown";
  const lower = text.toLowerCase();
  let foundAny = false;
  for (const a of anchors) {
    const needle = a.toLowerCase();
    if (needle.length < 2) continue;
    let idx = 0;
    while ((idx = lower.indexOf(needle, idx)) !== -1) {
      foundAny = true;
      if (windowHasNegation(lower, idx, needle.length)) {
        return "dissent";
      }
      idx += Math.max(1, needle.length);
    }
  }
  if (!foundAny) return "unknown";
  return "support";
}

function usableSynthesisRows(results: SynthesisConsensusResultRow[]) {
  return results.filter((r) => {
    const st = coerceStatus(r.status);
    if (st !== "ok" && st !== "substituted") return false;
    const t = (r.rawText ?? "").trim();
    return t.length >= MIN_RAW_TEXT_LEN;
  });
}

function perClaimEvidenceQuality(
  evidenceRefCount: number,
  supportRatio: number
): "strong" | "mixed" | "weak" {
  if (evidenceRefCount >= 1 && supportRatio >= 0.8) return "strong";
  if (evidenceRefCount >= 1 && supportRatio >= 0.5 && supportRatio < 0.8) return "mixed";
  if (evidenceRefCount === 0 || supportRatio < 0.5) return "weak";
  return "mixed";
}

function perClaimConfidenceLabel(
  supportRatio: number,
  sourceBacked: boolean,
  evidenceRefCount: number
): "High" | "Medium" | "Low" {
  if (supportRatio >= 0.8 && (sourceBacked ? evidenceRefCount >= 1 : true)) return "High";
  if (supportRatio >= 0.6) return "Medium";
  return "Low";
}

export function rollupPolicyConsensusSummary(
  detail: SynthesisConsensusSummaryDetail,
  keyFindingCount: number
): ConsensusSummary {
  const { overallConsensusScore, aggregateSupportRatio, modelsHealthy, modelCount, lowEvidenceClaims } = detail;
  let confidenceLabel: "High" | "Medium" | "Low" = "Medium";
  if (overallConsensusScore >= 72 && modelsHealthy >= Math.ceil(modelCount * 0.6)) {
    confidenceLabel = "High";
  } else if (overallConsensusScore < 45 || modelsHealthy < Math.ceil(modelCount * 0.4)) {
    confidenceLabel = "Low";
  }
  let evidenceQuality: "strong" | "mixed" | "weak" = "mixed";
  const denom = Math.max(1, keyFindingCount);
  if (lowEvidenceClaims === 0 && aggregateSupportRatio >= 0.75) evidenceQuality = "strong";
  else if (lowEvidenceClaims >= denom * 0.5 || aggregateSupportRatio < 0.45) evidenceQuality = "weak";

  return {
    overallConsensusScore,
    supportRatio: Math.round(aggregateSupportRatio * 1000) / 1000,
    confidenceLabel,
    evidenceQuality,
    lowEvidenceClaims,
    modelsHealthy,
    modelCount,
    highConfidenceClaims: detail.highConfidenceClaims,
    contestedClaims: detail.contestedClaims,
  };
}

/**
 * Claim-level support + compact audit for structured synthesis. Deterministic for identical inputs.
 */
export function computeSynthesisConsensusScoring(input: {
  synthesis: StructuredSynthesis;
  results: SynthesisConsensusResultRow[];
  sourceBacked: boolean;
  runId: string;
}): SynthesisConsensusScoringOutput {
  const { synthesis, results, sourceBacked, runId } = input;
  const usable = usableSynthesisRows(results);
  const modelsHealthy = usable.length;
  const modelCount = Math.max(1, results.length);
  const mhForRatio = Math.max(1, modelsHealthy);

  const timestamp = new Date().toISOString();

  const enrichedKeyFindings = synthesis.keyFindings.map((kf) => {
    const anchors = extractAnchorTokens(kf.claim);
    const supportingModels: string[] = [];
    const dissentingModels: string[] = [];
    const unknownModels: string[] = [];

    for (const row of usable) {
      const text = (row.rawText ?? "").trim();
      const stance = classifyModelStanceForClaim(text, anchors);
      if (stance === "support") supportingModels.push(row.modelId);
      else if (stance === "dissent") dissentingModels.push(row.modelId);
      else unknownModels.push(row.modelId);
    }

    const supportRatio = Math.round((supportingModels.length / mhForRatio) * 1000) / 1000;
    const evidenceRefs = kf.evidenceRefs ?? [];
    const evidenceQuality = perClaimEvidenceQuality(evidenceRefs.length, supportRatio);
    const confidenceLabel = perClaimConfidenceLabel(supportRatio, sourceBacked, evidenceRefs.length);

    const support: KeyFindingSupportBlock = {
      supportingModels: [...supportingModels].sort((a, b) => a.localeCompare(b)),
      dissentingModels: [...dissentingModels].sort((a, b) => a.localeCompare(b)),
      unknownModels: [...unknownModels].sort((a, b) => a.localeCompare(b)),
      supportRatio,
      confidenceLabel,
    };

    return {
      ...kf,
      support,
      evidenceQuality,
    };
  });

  const ratios = enrichedKeyFindings.map((f) => f.support.supportRatio);
  const avgRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0.5;

  let score = Math.round(avgRatio * 100);
  if (synthesis.disagreements.length >= 2) score -= 10;
  if (synthesis.biasAndBlindSpots.length >= 1) score -= 10;
  const weakCount = enrichedKeyFindings.filter((f) => f.evidenceQuality === "weak").length;
  score -= Math.min(25, weakCount * 5);
  if (modelsHealthy < 4) score -= 10;
  const overallConsensusScore = Math.max(0, Math.min(100, score));

  const highConfidenceClaims = enrichedKeyFindings.filter((f) => f.support.confidenceLabel === "High").length;
  const contestedClaims = enrichedKeyFindings.filter((f) => f.support.confidenceLabel === "Low").length;
  const lowEvidenceClaims = enrichedKeyFindings.filter((f) => f.evidenceQuality === "weak").length;

  const consensusSummary: SynthesisConsensusSummaryDetail = {
    modelsHealthy,
    modelCount,
    highConfidenceClaims,
    contestedClaims,
    lowEvidenceClaims,
    overallConsensusScore,
    aggregateSupportRatio: Math.round(avgRatio * 1000) / 1000,
  };

  const auditBundle: SynthesisConsensusAuditBundle = {
    runId,
    timestamp,
    models: results.map((r) => ({ modelId: r.modelId, status: coerceStatus(r.status) })),
    overallConsensusScore,
    claims: enrichedKeyFindings.map((f) => ({
      claimTruncated: f.claim.slice(0, 200) + (f.claim.length > 200 ? "…" : ""),
      supportRatio: f.support.supportRatio,
      evidenceQuality: f.evidenceQuality,
    })),
  };

  const enrichedSynthesis: StructuredSynthesis = {
    ...synthesis,
    keyFindings: enrichedKeyFindings,
  };

  const policyConsensusSummary = rollupPolicyConsensusSummary(
    consensusSummary,
    enrichedKeyFindings.length
  );

  return {
    enrichedSynthesis,
    consensusSummary,
    policyConsensusSummary,
    auditBundle,
  };
}
