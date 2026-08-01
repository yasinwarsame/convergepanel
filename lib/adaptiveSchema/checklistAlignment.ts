/**
 * Checklist / Taxonomy Alignment (Milestone 2 — fifth activated schema in
 * the query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline, same architectural
 * pattern as the other Milestone 2 parallel paths. Unlike causal_explanation
 * (which clusters PER CATEGORY and never merges across categories, since a
 * "direct cause" and a "contributing factor" naming the same thing must
 * stay distinct), this schema clusters items ACROSS categories first: the
 * category label is treated as a loose, model-assigned grouping tag for the
 * SAME real-world item (one model might file "encryption" under "Security",
 * another under "Technical") — merging finds the one canonical item and
 * then resolves its category by majority vote, rather than treating a
 * category disagreement as evidence of two different items.
 *
 * Clustering is deterministic (union-find + textSimilarity.ts, no model
 * call), the same shape as enumAlignment.ts's ranked-list item clustering —
 * this schema is enumAlignment's closest sibling, differing only in that
 * order never matters here (no `rank`/panelRank/rankCorrelation at all) and
 * items are additionally grouped by category.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import { AggregatedChecklistItem, ChecklistCategoryGroup, ChecklistItem, ChecklistTaxonomyResult } from "./types";
import { dedupeTextList, normalizeSlug, slugsMatch, textsAreNearDuplicates, UnionFind } from "./textSimilarity";

/** Item labels — same bar enumAlignment.ts uses for ranked-list items. */
const LABEL_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.6 };
/** Notes — plain caveat strings, same bar definitionAlignment.ts/causalAlignment.ts use for list-style merging. */
const NOTES_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

/** Below this coverage, an item moves to the low-confidence bucket — but only when the panel actually had more than 2 models to potentially cover it. Identical rule to enumAlignment.ts/comparisonAlignment.ts. */
const LOW_CONFIDENCE_MAX_COVERAGE = 2;
const NOTES_CAP = 5;
/** Sentinel category for items the panel never meaningfully categorized — the whole result then renders as a flat checklist rather than a taxonomy with visible section headings. */
const GENERAL_CATEGORY = "General";

/** checklistAlignment's per-model raw shape — mirrors schemaRegistry.ts's checklistTaxonomyFields keys after extraction from AdaptiveModelResult.data. */
export interface ChecklistTaxonomyFields {
  summary: string;
  items: ChecklistItem[];
  notes: string[];
}

/** Extracts the schema's 3 keys from one model's validated data, defaulting missing/malformed fields safely rather than throwing. */
export function extractChecklistFields(data: Record<string, any>): ChecklistTaxonomyFields {
  return {
    summary: typeof data.summary === "string" ? data.summary : "",
    items: Array.isArray(data.items) ? data.items : [],
    notes: Array.isArray(data.notes) ? data.notes.filter((n: unknown): n is string => typeof n === "string") : [],
  };
}

function slugifyLabel(label: string): string {
  return normalizeSlug(label) || "item";
}

function itemsMatch(a: ChecklistItem, b: ChecklistItem): boolean {
  return slugsMatch(a.id, b.id) || textsAreNearDuplicates(a.label, b.label, LABEL_DEDUP_THRESHOLDS);
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

function normalizeCategory(category: string | undefined): string {
  if (!category) return GENERAL_CATEGORY;
  const trimmed = category.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return GENERAL_CATEGORY;
  return trimmed;
}

interface RawEntry {
  index: number;
  modelId: ModelId;
  item: ChecklistItem;
}

/**
 * Clusters every model's own ChecklistItem[] list into one merged
 * checklist/taxonomy — this schema's equivalent of
 * buildRankedEnumerationResult(). Never throws; empty perModel (no model
 * produced usable items) yields an empty result, not an error.
 */
export function buildChecklistTaxonomyResult(
  perModel: { modelId: ModelId; fields: ChecklistTaxonomyFields }[]
): ChecklistTaxonomyResult {
  const totalModels = perModel.length;
  const summary = modeOrLongest(perModel.map((p) => p.fields.summary).filter((s) => s.trim().length > 0)) || "";
  const notes = dedupeTextList(perModel.flatMap((p) => p.fields.notes), { ...NOTES_DEDUP_THRESHOLDS, cap: NOTES_CAP });

  let runningIndex = 0;
  const entries: RawEntry[] = perModel.flatMap(({ modelId, fields }) =>
    fields.items.map((item) => ({ index: runningIndex++, modelId, item }))
  );

  if (entries.length === 0) {
    return { summary, categories: [], lowConfidenceItems: [], notes, totalModels };
  }

  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (itemsMatch(entries[i].item, entries[j].item)) uf.union(i, j);
    }
  }

  const groups = new Map<number, RawEntry[]>();
  for (const entry of entries) {
    const root = uf.find(entry.index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(entry);
  }

  interface Aggregated extends AggregatedChecklistItem {
    firstSeenIndex: number;
  }

  const aggregated: Aggregated[] = [];
  for (const group of groups.values()) {
    const label = modeOrLongest(group.map((e) => e.item.label));
    const category = modeOrLongest(group.map((e) => normalizeCategory(e.item.category)));
    const rationale = group.find((e) => e.item.rationale && e.item.rationale.trim().length > 0)?.item.rationale;

    // First occurrence per model wins — one critical vote per model, not per raw item.
    const criticalByModel = new Map<ModelId, boolean>();
    for (const { modelId, item } of group) {
      if (!criticalByModel.has(modelId)) criticalByModel.set(modelId, item.critical === true);
    }
    const criticalVotes = Array.from(criticalByModel.values()).filter(Boolean).length;
    const critical = criticalByModel.size > 0 && criticalVotes / criticalByModel.size >= 0.5;

    const coverageCount = criticalByModel.size;
    aggregated.push({
      id: slugifyLabel(label),
      label,
      category,
      rationale,
      critical,
      coverageCount,
      totalModels,
      coverageRatio: totalModels > 0 ? coverageCount / totalModels : 0,
      contributingModels: Array.from(criticalByModel.keys()),
      firstSeenIndex: Math.min(...group.map((e) => e.index)),
    });
  }

  const sortByCoverageThenFirstSeen = (a: Aggregated, b: Aggregated) =>
    b.coverageCount - a.coverageCount || a.firstSeenIndex - b.firstSeenIndex;

  const lowConfidenceThresholdApplies = totalModels > LOW_CONFIDENCE_MAX_COVERAGE;
  const mainItems = aggregated
    .filter((a) => !lowConfidenceThresholdApplies || a.coverageCount > LOW_CONFIDENCE_MAX_COVERAGE)
    .sort(sortByCoverageThenFirstSeen);
  const lowConfidenceItems = aggregated
    .filter((a) => lowConfidenceThresholdApplies && a.coverageCount <= LOW_CONFIDENCE_MAX_COVERAGE)
    .sort(sortByCoverageThenFirstSeen);

  const categoryFirstSeen = new Map<string, number>();
  const categoryItems = new Map<string, Aggregated[]>();
  for (const item of mainItems) {
    if (!categoryItems.has(item.category)) {
      categoryItems.set(item.category, []);
      categoryFirstSeen.set(item.category, item.firstSeenIndex);
    }
    categoryItems.get(item.category)!.push(item);
  }

  const categories: ChecklistCategoryGroup[] = Array.from(categoryItems.entries())
    .sort(([a], [b]) => categoryFirstSeen.get(a)! - categoryFirstSeen.get(b)!)
    .map(([category, items]) => ({
      category,
      items: items.map(({ firstSeenIndex, ...rest }) => rest),
    }));

  return {
    summary,
    categories,
    lowConfidenceItems: lowConfidenceItems.map(({ firstSeenIndex, ...rest }) => rest),
    notes,
    totalModels,
  };
}
