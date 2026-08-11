/**
 * Ranked Enumeration Alignment (Milestone 2 — the first activated schema in
 * the query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline: a ranked list's atomic
 * unit is a list item (rank/category/coverage), not a claim (stance/
 * evidenceType/confidence), and "agreement" here means rank correlation and
 * coverage overlap, not stance consensus. Forcing it through the claim
 * vocabulary would misname every field. This is a parallel, schema-specific
 * path — the whole point of proving the registry/renderer architecture
 * can genuinely support more than one answer shape.
 *
 * Clustering is deterministic (slug/label fuzzy-match via textSimilarity.ts
 * — the same cheap union-find approach alignment.ts's claim pass 1 uses),
 * no model call: list items are short and concrete enough that fuzzy
 * matching catches the overwhelming majority of cross-model paraphrases,
 * unlike full claim sentences.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import { AggregatedEnumItem, EnumItem, RankedEnumerationResult } from "./types";
import { normalizeSlug, slugsMatch, textsAreNearDuplicates, UnionFind } from "./textSimilarity";

/** Looser than claim-id slugsMatch's own internal bar would suggest — list-item slugs are short, so allow either signal (slug fuzzy-match OR label near-duplicate) to trigger a merge. */
const LABEL_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.6 };

/** Below this coverage, an item moves to the low-confidence bucket — but only when the panel actually had more than 2 models to potentially cover it. A 2-model run's full coverage (2/2) must not be misread as "low confidence" just because 2 <= 2. */
const LOW_CONFIDENCE_MAX_COVERAGE = 2;

interface RawEntry {
  modelId: ModelId;
  item: EnumItem;
}

function slugifyLabel(label: string): string {
  return normalizeSlug(label) || "item";
}

function itemsMatch(a: EnumItem, b: EnumItem): boolean {
  return slugsMatch(a.id, b.id) || textsAreNearDuplicates(a.label, b.label, LABEL_DEDUP_THRESHOLDS);
}

/** Mode of a list of strings, ties broken by longest string (a longer label is usually the more complete/descriptive phrasing). */
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

function populationVariance(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

/**
 * Spearman rank correlation between two models' shared items, averaged
 * across every model pair that shares at least 2 commonly-covered
 * (post-clustering) items. Null when no pair has enough overlap.
 */
function computeRankCorrelation(clusters: { sourceRanks: Map<ModelId, number> }[]): number | null {
  const modelIds = Array.from(new Set(clusters.flatMap((c) => Array.from(c.sourceRanks.keys()))));
  const correlations: number[] = [];

  for (let i = 0; i < modelIds.length; i++) {
    for (let j = i + 1; j < modelIds.length; j++) {
      const [a, b] = [modelIds[i], modelIds[j]];
      const shared = clusters.filter((c) => c.sourceRanks.has(a) && c.sourceRanks.has(b));
      if (shared.length < 2) continue;

      const n = shared.length;
      const sumSquaredDiff = shared.reduce((sum, c) => {
        const d = c.sourceRanks.get(a)! - c.sourceRanks.get(b)!;
        return sum + d * d;
      }, 0);
      const rho = 1 - (6 * sumSquaredDiff) / (n * (n * n - 1));
      correlations.push(rho);
    }
  }

  if (correlations.length === 0) return null;
  return correlations.reduce((sum, r) => sum + r, 0) / correlations.length;
}

/**
 * Clusters every model's own EnumItem[] list into one merged, ranked list —
 * ranked_enumeration's equivalent of alignClaims()/alignMetrics(). Never
 * throws; an empty perModel (no model produced usable items) yields an
 * empty result, not an error.
 */
export function buildRankedEnumerationResult(
  perModel: { modelId: ModelId; items: EnumItem[] }[],
  requestedCount: number | null
): RankedEnumerationResult {
  const totalModels = perModel.length;
  const entries: RawEntry[] = perModel.flatMap(({ modelId, items }) => items.map((item) => ({ modelId, item })));

  if (entries.length === 0) {
    return {
      items: [],
      lowConfidenceItems: [],
      requestedCount,
      actualCount: 0,
      // Producer canonicalization: `shortfallNote` is genuinely absent
      // when no requestedCount was given — conditional spread (not a
      // ternary-to-undefined) so the key is never an own-property with
      // value undefined (see buildComparisonMatrixResult's own comment).
      ...(requestedCount != null
        ? { shortfallNote: `You asked for ${requestedCount} items; the panel could not identify any distinct items for this question.` }
        : {}),
      rankCorrelation: null,
      hasLiveQueryLogData: false,
      totalModels,
    };
  }

  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (itemsMatch(entries[i].item, entries[j].item)) uf.union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: { aggregated: AggregatedEnumItem; sourceRanks: Map<ModelId, number> }[] = [];

  for (const idxs of groups.values()) {
    // First occurrence per model wins if a model's own list happened to
    // list a near-duplicate of itself twice — keeps sourceRanks to one
    // entry per model, matching every other unitizer's cellByModel pattern.
    const sourceRanks = new Map<ModelId, number>();
    const memberItems: EnumItem[] = [];
    for (const idx of idxs) {
      const { modelId, item } = entries[idx];
      memberItems.push(item);
      if (!sourceRanks.has(modelId)) sourceRanks.set(modelId, item.rank);
    }

    const label = modeOrLongest(memberItems.map((i) => i.label));
    const categories = memberItems.map((i) => i.category).filter((c): c is string => !!c && c.trim().length > 0);
    const category = categories.length > 0 ? modeOrLongest(categories) : undefined;
    const rationale = memberItems.find((i) => i.rationale && i.rationale.trim().length > 0)?.rationale;
    const sources = Array.from(new Set(memberItems.flatMap((i) => i.sources || []))).slice(0, 5);
    const ranks = Array.from(sourceRanks.values());
    const coverageCount = sourceRanks.size;

    const aggregated: AggregatedEnumItem = {
      id: slugifyLabel(label),
      label,
      ...(category !== undefined ? { category } : {}),
      panelRank: ranks.reduce((sum, r) => sum + r, 0) / ranks.length,
      coverageCount,
      totalModels,
      coverageRatio: totalModels > 0 ? coverageCount / totalModels : 0,
      sourceRanks: Object.fromEntries(sourceRanks) as Record<ModelId, number>,
      ...(coverageCount >= 2 ? { rankVariance: populationVariance(ranks) } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    };

    clusters.push({ aggregated, sourceRanks });
  }

  const sortByRankThenCoverage = (a: AggregatedEnumItem, b: AggregatedEnumItem) =>
    b.coverageRatio - a.coverageRatio || a.panelRank - b.panelRank;

  const lowConfidenceThresholdApplies = totalModels > LOW_CONFIDENCE_MAX_COVERAGE;
  const items = clusters
    .filter((c) => !lowConfidenceThresholdApplies || c.aggregated.coverageCount > LOW_CONFIDENCE_MAX_COVERAGE)
    .map((c) => c.aggregated)
    .sort(sortByRankThenCoverage);
  const lowConfidenceItems = clusters
    .filter((c) => lowConfidenceThresholdApplies && c.aggregated.coverageCount <= LOW_CONFIDENCE_MAX_COVERAGE)
    .map((c) => c.aggregated)
    .sort(sortByRankThenCoverage);

  const actualCount = items.length + lowConfidenceItems.length;
  const shortfallReached = requestedCount != null && actualCount < requestedCount;

  return {
    items,
    lowConfidenceItems,
    requestedCount,
    actualCount,
    ...(shortfallReached
      ? { shortfallNote: `You asked for ${requestedCount} items; the panel could only responsibly identify ${actualCount} distinct item${actualCount === 1 ? "" : "s"} across all models.` }
      : {}),
    rankCorrelation: computeRankCorrelation(clusters.map((c) => ({ sourceRanks: c.sourceRanks }))),
    hasLiveQueryLogData: false,
    totalModels,
  };
}
