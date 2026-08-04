/**
 * Comparison Matrix Alignment (Milestone 2 — second activated schema in the
 * query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline: a comparison's atomic unit
 * is a (subject, attribute) cell across two independent axes the model
 * itself extracts from the question — neither axis is supplied by the
 * framework, unlike every other schema's fixed field list. This is a
 * parallel, schema-specific path (the same architectural shape as
 * enumAlignment.ts's ranked_enumeration handling), not a variant of the
 * claim-matrix pipeline.
 *
 * Clustering is deterministic (fuzzy label match via textSimilarity.ts), no
 * model call, run independently on three different kinds of text with three
 * different risk profiles:
 *   - Subjects (product/option names): a FALSE merge is the worst outcome —
 *     "iPhone 15" and "iPhone 15 Pro" are different real-world things, and
 *     conflating them would silently misattribute one product's data to
 *     another. Thresholds are tightened accordingly (near-exact match only).
 *   - Attributes (comparison dimensions): a missed merge just means two rows
 *     instead of one — annoying, not wrong. Thresholds match
 *     enumAlignment.ts's item-label defaults.
 *   - Values (the cell content itself): only used to decide agreement
 *     (consensus/majority/split), never identity, so a slightly looser bar
 *     is fine — worst case is calling a real disagreement "split" instead of
 *     "majority", not misattributing data.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import {
  AggregatedComparisonAttribute,
  AggregatedComparisonCell,
  AggregatedComparisonSubject,
  AlignedClaimStatus,
  ComparisonCell,
  ComparisonMatrixResult,
} from "./types";
import { hasIdenticalTokenSet, normalizeSlug, textsAreNearDuplicates, UnionFind } from "./textSimilarity";

/** Attributes are dimension labels ("battery life" vs "battery") where a missed merge is low-cost — same bar as enumAlignment.ts's ranked-list item labels. Subset containment merging (e.g. "battery" into "battery life") is acceptable here, unlike subjects below. */
const ATTRIBUTE_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.6 };
/** Cell values are only clustered to decide agreement, never identity — a looser bar than either axis is acceptable. */
const VALUE_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

/**
 * Subjects are short named entities where a false merge silently conflates
 * two distinct real-world things (e.g. "iPhone 15" and "iPhone 15 Pro" are
 * different products). textsAreNearDuplicates' token-overlap signal can't be
 * tightened away for this — overlap/min-length is 1.0 for ANY subset
 * relationship regardless of threshold — so tokenOverlapMin is set above 1
 * here to disable that branch entirely, leaving only the Levenshtein ratio
 * (formatting/case/punctuation drift) active from that call. hasIdenticalTokenSet
 * separately catches pure word-reordering ("Model 3 Tesla" vs "Tesla Model 3")
 * without allowing a superset/subset merge.
 */
function subjectsMatch(a: string, b: string): boolean {
  return textsAreNearDuplicates(a, b, { levenshteinMaxRatio: 0.15, tokenOverlapMin: 1.01 }) || hasIdenticalTokenSet(a, b);
}

function attributesMatch(a: string, b: string): boolean {
  return textsAreNearDuplicates(a, b, ATTRIBUTE_DEDUP_THRESHOLDS);
}

function valuesMatch(a: string, b: string): boolean {
  return textsAreNearDuplicates(a, b, VALUE_DEDUP_THRESHOLDS);
}

/** Below this coverage, a subject/attribute moves to its low-confidence bucket — but only when the panel actually had more than 2 models to potentially cover it. A 2-model run's full coverage (2/2) must not be misread as "low confidence" just because 2 <= 2. Mirrors enumAlignment.ts's identical rule. */
const LOW_CONFIDENCE_MAX_COVERAGE = 2;

interface RawEntry {
  index: number;
  modelId: ModelId;
  cell: ComparisonCell;
}

function slugifyLabel(label: string, used: Set<string>): string {
  const base = normalizeSlug(label) || "item";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  const id = `${base}-${n}`;
  used.add(id);
  return id;
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

/** Clusters a flat list of strings via union-find + a pairwise matcher, returning each input index's cluster root. */
function clusterTexts(texts: string[], matches: (a: string, b: string) => boolean): number[] {
  const uf = new UnionFind(texts.length);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (matches(texts[i], texts[j])) uf.union(i, j);
    }
  }
  return texts.map((_, i) => uf.find(i));
}

interface AxisCluster {
  id: string;
  label: string;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  firstSeenIndex: number;
}

function buildAxisClusters(
  rawCells: RawEntry[],
  roots: number[],
  extractLabel: (cell: ComparisonCell) => string,
  totalModels: number,
  usedIds: Set<string>
): { clusterByRoot: Map<number, AxisCluster>; rootOf: Map<number, number> } {
  const groups = new Map<number, number[]>();
  for (let i = 0; i < rawCells.length; i++) {
    const root = roots[i];
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusterByRoot = new Map<number, AxisCluster>();
  const rootOf = new Map<number, number>();

  for (const [root, idxs] of groups) {
    const labels = idxs.map((i) => extractLabel(rawCells[i].cell));
    const label = modeOrLongest(labels);
    const modelIds = new Set(idxs.map((i) => rawCells[i].modelId));
    const firstSeenIndex = Math.min(...idxs.map((i) => rawCells[i].index));

    clusterByRoot.set(root, {
      id: slugifyLabel(label, usedIds),
      label,
      coverageCount: modelIds.size,
      totalModels,
      coverageRatio: totalModels > 0 ? modelIds.size / totalModels : 0,
      firstSeenIndex,
    });
    rootOf.set(root, root);
  }

  return { clusterByRoot, rootOf };
}

function sortAndSplitByCoverage<T extends { coverageCount: number; firstSeenIndex: number }>(
  clusters: T[],
  totalModels: number
): { main: T[]; lowConfidence: T[] } {
  const sorted = [...clusters].sort(
    (a, b) => b.coverageCount - a.coverageCount || a.firstSeenIndex - b.firstSeenIndex
  );
  const thresholdApplies = totalModels > LOW_CONFIDENCE_MAX_COVERAGE;
  return {
    main: sorted.filter((c) => !thresholdApplies || c.coverageCount > LOW_CONFIDENCE_MAX_COVERAGE),
    lowConfidence: sorted.filter((c) => thresholdApplies && c.coverageCount <= LOW_CONFIDENCE_MAX_COVERAGE),
  };
}

function stripFirstSeenIndex<T extends { firstSeenIndex: number }>(items: T[]): Omit<T, "firstSeenIndex">[] {
  return items.map(({ firstSeenIndex, ...rest }) => rest);
}

/**
 * Clusters every model's own ComparisonCell[] list into one merged matrix —
 * comparison_matrix's equivalent of alignClaims()/buildRankedEnumerationResult().
 * Never throws; an empty perModel (no model produced usable cells) yields an
 * empty result, not an error.
 */
export function buildComparisonMatrixResult(
  perModel: { modelId: ModelId; cells: ComparisonCell[] }[]
): ComparisonMatrixResult {
  const totalModels = perModel.length;
  let runningIndex = 0;
  const rawCells: RawEntry[] = perModel.flatMap(({ modelId, cells }) =>
    cells.map((cell) => ({ index: runningIndex++, modelId, cell }))
  );

  if (rawCells.length === 0) {
    return {
      subjects: [],
      lowConfidenceSubjects: [],
      attributes: [],
      lowConfidenceAttributes: [],
      cells: [],
      hasVerifiedSourceData: false,
      totalModels,
    };
  }

  const subjectRoots = clusterTexts(rawCells.map((r) => r.cell.subject), subjectsMatch);
  const attributeRoots = clusterTexts(rawCells.map((r) => r.cell.attribute), attributesMatch);

  const usedSubjectIds = new Set<string>();
  const usedAttributeIds = new Set<string>();

  const { clusterByRoot: subjectClusters } = buildAxisClusters(
    rawCells,
    subjectRoots,
    (cell) => cell.subject,
    totalModels,
    usedSubjectIds
  );
  const { clusterByRoot: attributeClusters } = buildAxisClusters(
    rawCells,
    attributeRoots,
    (cell) => cell.attribute,
    totalModels,
    usedAttributeIds
  );

  // Group raw cells by (subjectRoot, attributeRoot) — the actual grid cells.
  const cellGroups = new Map<string, number[]>();
  for (let i = 0; i < rawCells.length; i++) {
    const key = `${subjectRoots[i]}::${attributeRoots[i]}`;
    if (!cellGroups.has(key)) cellGroups.set(key, []);
    cellGroups.get(key)!.push(i);
  }

  const aggregatedCells: AggregatedComparisonCell[] = [];

  for (const idxs of cellGroups.values()) {
    const subject = subjectClusters.get(subjectRoots[idxs[0]])!;
    const attribute = attributeClusters.get(attributeRoots[idxs[0]])!;

    const valuesByModel = new Map<ModelId, string>();
    const verdictByModel = new Map<ModelId, "better" | "worse" | "even">();
    let rationale: string | undefined;
    const sourcesSet = new Set<string>();

    for (const i of idxs) {
      const { modelId, cell } = rawCells[i];
      if (!valuesByModel.has(modelId)) valuesByModel.set(modelId, cell.value);
      if (cell.verdict && !verdictByModel.has(modelId)) verdictByModel.set(modelId, cell.verdict);
      if (!rationale && cell.rationale && cell.rationale.trim().length > 0) rationale = cell.rationale;
      for (const s of cell.sources || []) sourcesSet.add(s);
    }

    const modelValuePairs = Array.from(valuesByModel.entries());
    const coverageCount = modelValuePairs.length;

    let agreement: AlignedClaimStatus;
    let consensusValue: string | undefined;

    if (coverageCount === 1) {
      agreement = "single_source";
    } else {
      const valueRoots = clusterTexts(
        modelValuePairs.map(([, value]) => value),
        valuesMatch
      );
      const rootCounts = new Map<number, number[]>();
      valueRoots.forEach((root, idx) => {
        if (!rootCounts.has(root)) rootCounts.set(root, []);
        rootCounts.get(root)!.push(idx);
      });
      const largestGroup = Array.from(rootCounts.values()).sort((a, b) => b.length - a.length)[0];

      if (largestGroup.length === coverageCount) {
        agreement = "consensus";
        consensusValue = modeOrLongest(largestGroup.map((idx) => modelValuePairs[idx][1]));
      } else if (largestGroup.length / coverageCount > 0.5) {
        agreement = "majority";
        consensusValue = modeOrLongest(largestGroup.map((idx) => modelValuePairs[idx][1]));
      } else {
        agreement = "split";
      }
    }

    const verdictTally: Partial<Record<"better" | "worse" | "even", number>> = {};
    for (const verdict of verdictByModel.values()) {
      verdictTally[verdict] = (verdictTally[verdict] ?? 0) + 1;
    }

    aggregatedCells.push({
      subjectId: subject.id,
      subject: subject.label,
      attributeId: attribute.id,
      attribute: attribute.label,
      valuesByModel: Object.fromEntries(valuesByModel) as Record<ModelId, string>,
      coverageCount,
      totalModels,
      coverageRatio: totalModels > 0 ? coverageCount / totalModels : 0,
      agreement,
      consensusValue,
      verdictTally: Object.keys(verdictTally).length > 0 ? verdictTally : undefined,
      rationale,
      sources: sourcesSet.size > 0 ? Array.from(sourcesSet).slice(0, 5) : undefined,
    });
  }

  const { main: mainSubjects, lowConfidence: lowConfidenceSubjectsRaw } = sortAndSplitByCoverage(
    Array.from(subjectClusters.values()),
    totalModels
  );
  const { main: mainAttributes, lowConfidence: lowConfidenceAttributesRaw } = sortAndSplitByCoverage(
    Array.from(attributeClusters.values()),
    totalModels
  );

  return {
    subjects: stripFirstSeenIndex(mainSubjects) as AggregatedComparisonSubject[],
    lowConfidenceSubjects: stripFirstSeenIndex(lowConfidenceSubjectsRaw) as AggregatedComparisonSubject[],
    attributes: stripFirstSeenIndex(mainAttributes) as AggregatedComparisonAttribute[],
    lowConfidenceAttributes: stripFirstSeenIndex(lowConfidenceAttributesRaw) as AggregatedComparisonAttribute[],
    cells: aggregatedCells,
    hasVerifiedSourceData: false,
    totalModels,
  };
}
