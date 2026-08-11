/**
 * Bias & Blind Spot Audit Alignment (Milestone 2 — eighth activated schema
 * in the query-routing redesign).
 *
 * Deliberately NOT a reimplementation of the embedded three-tier system —
 * it exposes the SAME underlying logic through a dedicated, standalone
 * query type:
 *   - Tier 1 (attributed bias): `detectAdaptiveBiases` (biasDetection.ts) is
 *     reused VERBATIM, unmodified — it already takes raw `ModelResult[]`
 *     and a `schemaId: QueryType` string, so it was already schema-agnostic
 *     before this activation. This is the ONLY tier where a bias gets
 *     attributed to a specific model, and it's the ONLY source for that —
 *     the wire-layer fields below deliberately have no "attributedBiases"
 *     self-report field, since a flat string without excerpt evidence could
 *     never meet the "do not accuse a model of bias based on weak
 *     inference" bar `detectAdaptiveBiases` already enforces.
 *   - Tier 2 (panel-level omissions): `auditPanelCoverage`
 *     (coverageAudit.ts, generalized to take `string[]` for deep_research)
 *     is reused as an independent second-opinion audit over the panel's own
 *     summaries, merged with the panel's own self-reported
 *     `omittedDimensions`.
 *   - Tier 3 (structural diagnostics): NOT a reuse of `diagnostics.ts`'s
 *     `computeAdaptiveDiagnostics` — that function is built from
 *     `AlignedClaim[]`'s `agreementScore`/`evidenceType`, neither of which
 *     this parallel path ever produces. This module computes its own
 *     deterministic diagnostics instead, reusing only the shared
 *     `HOMOGENEITY_AGREEMENT_THRESHOLD` constant for consistency.
 *
 * The central safeguard, enforced structurally: an empty Tier 1 is never
 * treated as "no bias exists" (see `biasEmptyReason`), and Tier 2/Tier 3
 * always compute independently of Tier 1 — model agreement is never
 * converted into proof of neutrality anywhere in this file.
 */

import "server-only";
import { ModelId, ModelResult } from "@/lib/types";
import {
  AggregatedPanelBlindSpot,
  BiasBlindspotAuditResult,
  BiasStructuralDiagnostics,
} from "./types";
import { dedupeTextList, textsAreNearDuplicates, UnionFind } from "./textSimilarity";
import { detectAdaptiveBiases } from "./biasDetection";
import { auditPanelCoverage } from "./coverageAudit";
import { HOMOGENEITY_AGREEMENT_THRESHOLD } from "./config";

const BIAS_BLINDSPOT_SCHEMA_ID = "bias_blindspot_audit" as const;

/** Full-sentence/dimension-length prose — same bar causalAlignment.ts/definitionAlignment.ts use. */
const PROSE_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.35, tokenOverlapMin: 0.45 };
/** Plain caveat-style list strings — same bar used throughout Milestone 2. */
const LIST_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

const ASSUMPTIONS_CAP = 5;
const STAKEHOLDERS_CAP = 5;
const GEOGRAPHIC_CAP = 3;
const SOURCE_CONCERNS_CAP = 3;
const EVIDENCE_CONCERNS_CAP = 3;
const FOLLOW_UPS_CAP = 3;

const HOMOGENEITY_MESSAGE =
  "Unusually uniform agreement. Models may share training data, source patterns, or assumptions, so strong consensus is not independent verification.";

/** biasBlindspotAlignment's per-model raw shape — mirrors schemaRegistry.ts's biasBlindspotAuditFields keys after extraction from AdaptiveModelResult.data. */
export interface BiasBlindspotFields {
  summary: string;
  omittedDimensions: string[];
  sharedAssumptions: string[];
  missingStakeholders: string[];
  geographicBiases: string[];
  sourceConcentrationConcerns: string[];
  evidenceTypeConcerns: string[];
  followUpQuestions: string[];
  sources: string[];
}

/** Extracts the schema's 9 flat keys from one model's validated data, defaulting missing/malformed fields safely rather than throwing — a salvaged partial response may be missing any of them. */
export function extractBiasBlindspotFields(data: Record<string, any>): BiasBlindspotFields {
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    summary: typeof data.summary === "string" ? data.summary : "",
    omittedDimensions: strArr(data.omittedDimensions),
    sharedAssumptions: strArr(data.sharedAssumptions),
    missingStakeholders: strArr(data.missingStakeholders),
    geographicBiases: strArr(data.geographicBiases),
    sourceConcentrationConcerns: strArr(data.sourceConcentrationConcerns),
    evidenceTypeConcerns: strArr(data.evidenceTypeConcerns),
    followUpQuestions: strArr(data.followUpQuestions),
    sources: strArr(data.sources),
  };
}

function modeOrLongest(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, count] of counts) {
    if (count > bestCount || (count === bestCount && v.length > best.length)) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}

/** Clusters a flat list of strings via union-find + a pairwise matcher, returning each cluster as its member indices. */
function clusterIndices(texts: string[], matches: (a: string, b: string) => boolean): number[][] {
  if (texts.length === 0) return [];
  const uf = new UnionFind(texts.length);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (matches(texts[i], texts[j])) uf.union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < texts.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return Array.from(groups.values());
}

interface SelfReportedGap {
  index: number;
  modelId: ModelId;
  text: string;
}

/** Merges the reused audit call's gaps with the panel's own self-reported omittedDimensions — overlapping entries (by text similarity) keep the audited gap's whyItMatters/followUpQuestion and note both signals in coverageReason; self-report-only entries get a plain "raised by N of M models" reason. */
function buildPanelBlindSpots(
  auditedGaps: { dimension: string; whyItMatters: string; followUpQuestion: string }[],
  selfReported: SelfReportedGap[],
  totalModels: number
): AggregatedPanelBlindSpot[] {
  const allTexts = [...auditedGaps.map((g) => g.dimension), ...selfReported.map((s) => s.text)];
  const clusters = clusterIndices(allTexts, (a, b) => textsAreNearDuplicates(a, b, PROSE_DEDUP_THRESHOLDS));

  const results: AggregatedPanelBlindSpot[] = [];
  clusters.forEach((idxs, clusterIdx) => {
    const auditedIdxs = idxs.filter((i) => i < auditedGaps.length);
    const selfIdxs = idxs.filter((i) => i >= auditedGaps.length).map((i) => selfReported[i - auditedGaps.length]);
    const contributingModels = new Set(selfIdxs.map((s) => s.modelId));

    if (auditedIdxs.length > 0) {
      const gap = auditedGaps[auditedIdxs[0]];
      const coverageReason =
        contributingModels.size > 0
          ? `identified by independent coverage audit and raised by ${contributingModels.size} of ${totalModels} models`
          : "identified by independent coverage audit";
      results.push({
        id: `gap-${clusterIdx}`,
        missingDimension: gap.dimension,
        whyItMatters: gap.whyItMatters,
        followUpQuestion: gap.followUpQuestion,
        coverageReason,
      });
    } else {
      results.push({
        id: `gap-${clusterIdx}`,
        missingDimension: modeOrLongest(selfIdxs.map((s) => s.text)),
        coverageReason: `raised by ${contributingModels.size} of ${totalModels} models`,
      });
    }
  });

  return results;
}

function computeStructuralDiagnostics(
  perModel: { modelId: ModelId; fields: BiasBlindspotFields }[],
  totalModels: number
): BiasStructuralDiagnostics {
  const modelsWithSources = perModel.filter((p) => p.fields.sources.length > 0).length;

  const allSources = perModel.flatMap((p) => p.fields.sources);
  let sourceConcentration: BiasStructuralDiagnostics["sourceConcentration"];
  if (allSources.length > 0) {
    const clusters = clusterIndices(allSources, (a, b) => textsAreNearDuplicates(a, b, LIST_DEDUP_THRESHOLDS));
    const largestCluster = clusters.reduce((max, c) => (c.length > max.length ? c : max), clusters[0] || []);
    sourceConcentration = {
      distinctSources: clusters.length,
      totalCitations: allSources.length,
      concentrationRatio: allSources.length > 0 ? largestCluster.length / allSources.length : 0,
    };
  }

  const geographicBiasConcerns = dedupeTextList(perModel.flatMap((p) => p.fields.geographicBiases), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: GEOGRAPHIC_CAP,
  });
  const sourceConcentrationConcerns = dedupeTextList(perModel.flatMap((p) => p.fields.sourceConcentrationConcerns), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: SOURCE_CONCERNS_CAP,
  });
  const evidenceTypeConcerns = dedupeTextList(perModel.flatMap((p) => p.fields.evidenceTypeConcerns), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: EVIDENCE_CONCERNS_CAP,
  });

  // Homogeneity: the only signal available here is whether models'
  // own summaries cluster into one near-duplicate group — this schema
  // never produces AlignedClaim.agreementScore, the embedded system's
  // actual homogeneity input.
  const summaries = perModel.map((p) => p.fields.summary).filter((s) => s.trim().length > 0);
  let homogeneityFlag = false;
  if (summaries.length >= 2) {
    const clusters = clusterIndices(summaries, (a, b) => textsAreNearDuplicates(a, b, PROSE_DEDUP_THRESHOLDS));
    const largestCluster = clusters.reduce((max, c) => (c.length > max.length ? c : max), clusters[0] || []);
    homogeneityFlag = largestCluster.length / summaries.length >= HOMOGENEITY_AGREEMENT_THRESHOLD;
  }

  // Producer canonicalization: sourceConcentration/homogeneityMessage are
  // genuinely absent in the common case (no sources cited / not
  // homogeneous) — conditional spread keeps the key genuinely absent
  // rather than an own-property with value undefined (see
  // buildComparisonMatrixResult's own comment for why this matters).
  // `biasEmptyReason` elsewhere in this file is `| null`, required, and
  // deliberately untouched — a real, distinct value, not this bug class.
  return {
    citationCoverage: { modelsWithSources, totalModels, ratio: totalModels > 0 ? modelsWithSources / totalModels : 0 },
    ...(sourceConcentration !== undefined ? { sourceConcentration } : {}),
    geographicBiasConcerns,
    sourceConcentrationConcerns,
    evidenceTypeConcerns,
    homogeneityFlag,
    ...(homogeneityFlag ? { homogeneityMessage: HOMOGENEITY_MESSAGE } : {}),
  };
}

/**
 * Assembles a full three-tier bias/blind-spot audit by reusing the embedded
 * system's existing Tier 1/Tier 2 model calls (run in parallel) and
 * computing this schema's own Tier 3 diagnostics deterministically. Never
 * throws — `detectAdaptiveBiases`/`auditPanelCoverage` already degrade to
 * empty/null on any failure per their own long-standing contracts.
 */
export async function buildBiasBlindspotAuditResult(
  perModel: { modelId: ModelId; fields: BiasBlindspotFields }[],
  totalModels: number,
  question: string,
  rawResults: ModelResult[]
): Promise<BiasBlindspotAuditResult> {
  const summary = modeOrLongest(perModel.map((p) => p.fields.summary).filter((s) => s.trim().length > 0)) || "";

  const modelRoster = rawResults.map((r) => r.modelId);
  const modelSummaries = perModel.map((p) => p.fields.summary).filter((s) => s.trim().length > 0);

  const [biasResult, auditedGaps] = await Promise.all([
    detectAdaptiveBiases(question, BIAS_BLINDSPOT_SCHEMA_ID, rawResults, modelRoster),
    auditPanelCoverage(question, BIAS_BLINDSPOT_SCHEMA_ID, modelSummaries),
  ]);

  let selfReportedIndex = 0;
  const selfReported: SelfReportedGap[] = perModel.flatMap((p) =>
    p.fields.omittedDimensions.map((text) => ({ index: selfReportedIndex++, modelId: p.modelId, text }))
  );
  const panelBlindSpots = buildPanelBlindSpots(auditedGaps, selfReported, totalModels);

  const sharedAssumptions = dedupeTextList(perModel.flatMap((p) => p.fields.sharedAssumptions), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: ASSUMPTIONS_CAP,
  });
  const missingStakeholders = dedupeTextList(perModel.flatMap((p) => p.fields.missingStakeholders), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: STAKEHOLDERS_CAP,
  });
  const followUpQuestions = dedupeTextList(perModel.flatMap((p) => p.fields.followUpQuestions), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: FOLLOW_UPS_CAP,
  });

  const structuralDiagnostics = computeStructuralDiagnostics(perModel, totalModels);

  return {
    summary,
    attributedBiases: biasResult.findings,
    biasEmptyReason: biasResult.emptyReason,
    panelBlindSpots,
    sharedAssumptions,
    missingStakeholders,
    structuralDiagnostics,
    followUpQuestions,
    totalModels,
  };
}
