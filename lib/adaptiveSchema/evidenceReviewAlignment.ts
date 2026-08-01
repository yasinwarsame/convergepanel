/**
 * Evidence Review Alignment (Milestone 2 — seventh activated schema in the
 * query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline — same architectural
 * pattern as the other Milestone 2 parallel paths. The central design risk
 * here is identical in spirit to causal_explanation's: evidence being
 * WIDELY REPEATED is not evidence of it being GOOD. Every per-dimension
 * `strength` value is derived from the contributing models' OWN self-
 * reported judgment about that dimension — never from how many models
 * simply mentioned it — and the overall `overallStrength` is a genuine
 * roll-up of those per-dimension judgments, not a count-based score.
 *
 * Clustering uses the same tight, "avoid merging on shared broad
 * vocabulary" bar causalAlignment.ts uses for short factor labels — quality
 * dimensions ("Sample size" vs "Sample selection bias") are short, distinct
 * concepts where a false merge would blur real, different concerns.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import { AggregatedEvidenceDimension, CausalEvidenceStrength, EvidenceDimension, EvidenceReviewResult } from "./types";
import { dedupeTextList, textsAreNearDuplicates, UnionFind } from "./textSimilarity";

/** Short quality-dimension labels — same tight bar causalAlignment.ts uses for factor labels, to avoid merging distinct dimensions that merely share common vocabulary (e.g. "Sample size" and "Sample selection bias" must stay separate). */
const DIMENSION_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.7 };
/** redFlags/strengths/caveats/checks — plain list-style strings, same bar used throughout Milestone 2. */
const LIST_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

/** Below this coverage, a dimension moves to the low-confidence bucket — but only when the panel actually had more than 2 models. Identical rule to every other Milestone 2 schema's low-confidence bucket. */
const LOW_CONFIDENCE_MAX_COVERAGE = 2;

const RED_FLAGS_CAP = 5;
const STRENGTHS_CAP = 5;
const CAVEATS_CAP = 3;
const CHECKS_CAP = 3;

/** evidenceReviewAlignment's per-model raw shape — mirrors schemaRegistry.ts's evidenceReviewFields keys after extraction from AdaptiveModelResult.data. */
export interface EvidenceReviewFields {
  overallAssessment: string;
  dimensions: EvidenceDimension[];
  redFlags: string[];
  strengths: string[];
  applicabilityCaveats: string[];
  recommendedChecks: string[];
  sources: string[];
}

/** Extracts the schema's 7 flat keys from one model's validated data, defaulting missing/malformed fields safely rather than throwing — a salvaged partial response may be missing any of them. */
export function extractEvidenceReviewFields(data: Record<string, any>): EvidenceReviewFields {
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    overallAssessment: typeof data.overallAssessment === "string" ? data.overallAssessment : "",
    dimensions: Array.isArray(data.dimensions) ? data.dimensions : [],
    redFlags: strArr(data.redFlags),
    strengths: strArr(data.strengths),
    applicabilityCaveats: strArr(data.applicabilityCaveats),
    recommendedChecks: strArr(data.recommendedChecks),
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

interface RawEntry {
  index: number;
  modelId: ModelId;
  item: EvidenceDimension;
}

/** Derives the overall evidence strength from the panel's OWN per-dimension judgments — never from coverage/repetition. "unknown" when no dimension carries a real signal; "contested" when dimensions disagree (including any single dimension already marked "contested"); otherwise the one shared value. */
function deriveOverallStrength(dimensions: AggregatedEvidenceDimension[]): CausalEvidenceStrength {
  const signals = dimensions.map((d) => d.strength).filter((s): s is CausalEvidenceStrength => s !== "unknown");
  if (signals.length === 0) return "unknown";
  if (signals.includes("contested")) return "contested";
  const distinct = new Set(signals);
  if (distinct.size > 1) return "contested";
  return signals[0];
}

/**
 * Clusters every model's own EvidenceDimension[] list (plus the flat
 * redFlags/strengths/caveats/checks lists) into one merged evidence review —
 * this schema's equivalent of buildCausalExplanationResult(). Never throws;
 * empty `perModel` yields an empty result, not an error.
 */
export function buildEvidenceReviewResult(
  perModel: { modelId: ModelId; fields: EvidenceReviewFields }[],
  totalModels: number = perModel.length
): EvidenceReviewResult {
  const overallAssessment = modeOrLongest(perModel.map((p) => p.fields.overallAssessment).filter((s) => s.trim().length > 0)) || "";
  const modelsWithSources = new Set(perModel.filter((p) => p.fields.sources.length > 0).map((p) => p.modelId));
  const sourceBacked = modelsWithSources.size > 0;

  let index = 0;
  const entries: RawEntry[] = perModel.flatMap(({ modelId, fields }) =>
    fields.dimensions.map((item) => ({ index: index++, modelId, item }))
  );

  const redFlags = dedupeTextList(perModel.flatMap((p) => p.fields.redFlags), { ...LIST_DEDUP_THRESHOLDS, cap: RED_FLAGS_CAP });
  const strengths = dedupeTextList(perModel.flatMap((p) => p.fields.strengths), { ...LIST_DEDUP_THRESHOLDS, cap: STRENGTHS_CAP });
  const applicabilityCaveats = dedupeTextList(perModel.flatMap((p) => p.fields.applicabilityCaveats), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: CAVEATS_CAP,
  });
  const recommendedChecks = dedupeTextList(perModel.flatMap((p) => p.fields.recommendedChecks), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: CHECKS_CAP,
  });

  if (entries.length === 0) {
    return {
      overallAssessment,
      overallStrength: "unknown",
      dimensions: [],
      lowConfidenceDimensions: [],
      redFlags,
      strengths,
      applicabilityCaveats,
      recommendedChecks,
      sourceBacked,
      totalModels,
    };
  }

  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (textsAreNearDuplicates(entries[i].item.dimension, entries[j].item.dimension, DIMENSION_DEDUP_THRESHOLDS)) uf.union(i, j);
    }
  }

  const groups = new Map<number, RawEntry[]>();
  for (const entry of entries) {
    const root = uf.find(entry.index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(entry);
  }

  interface Aggregated extends AggregatedEvidenceDimension {
    firstSeenIndex: number;
  }

  const aggregated: Aggregated[] = Array.from(groups.values()).map((group) => {
    const dimension = modeOrLongest(group.map((e) => e.item.dimension));
    const assessment = group.map((e) => e.item.assessment).reduce((longest, text) => (text.length > longest.length ? text : longest), "");
    const contributingModels = Array.from(new Set(group.map((e) => e.modelId)));

    // First occurrence per model wins — one strength read per model, not per raw item.
    const strengthByModel = new Map<ModelId, CausalEvidenceStrength>();
    for (const { modelId, item } of group) {
      if (item.strength && !strengthByModel.has(modelId)) strengthByModel.set(modelId, item.strength);
    }
    const distinctStrengths = new Set(strengthByModel.values());
    let strength: CausalEvidenceStrength;
    if (distinctStrengths.size === 0) strength = "unknown";
    else if (distinctStrengths.has("contested") || distinctStrengths.size > 1) strength = "contested";
    else strength = Array.from(distinctStrengths)[0];

    return {
      id: group[0].item.id || dimension.slice(0, 40),
      dimension,
      assessment,
      strength,
      coverageCount: contributingModels.length,
      totalModels,
      coverageRatio: totalModels > 0 ? contributingModels.length / totalModels : 0,
      contributingModels,
      firstSeenIndex: Math.min(...group.map((e) => e.index)),
    };
  });

  const sortByCoverageThenFirstSeen = (a: Aggregated, b: Aggregated) =>
    b.coverageCount - a.coverageCount || a.firstSeenIndex - b.firstSeenIndex;

  const lowConfidenceThresholdApplies = totalModels > LOW_CONFIDENCE_MAX_COVERAGE;
  const dimensions = aggregated
    .filter((d) => !lowConfidenceThresholdApplies || d.coverageCount > LOW_CONFIDENCE_MAX_COVERAGE)
    .sort(sortByCoverageThenFirstSeen)
    .map(({ firstSeenIndex, ...rest }) => rest);
  const lowConfidenceDimensions = aggregated
    .filter((d) => lowConfidenceThresholdApplies && d.coverageCount <= LOW_CONFIDENCE_MAX_COVERAGE)
    .sort(sortByCoverageThenFirstSeen)
    .map(({ firstSeenIndex, ...rest }) => rest);

  const overallStrength = deriveOverallStrength([...dimensions, ...lowConfidenceDimensions]);

  return {
    overallAssessment,
    overallStrength,
    dimensions,
    lowConfidenceDimensions,
    redFlags,
    strengths,
    applicabilityCaveats,
    recommendedChecks,
    sourceBacked,
    totalModels,
  };
}
