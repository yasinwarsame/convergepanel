/**
 * Causal Explanation Alignment (Milestone 2 — fourth activated schema in the
 * query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline, same reasoning as the
 * other Milestone 2 parallel paths (enumAlignment.ts/comparisonAlignment.ts/
 * definitionAlignment.ts) — but with one design risk sharper here than
 * anywhere else in this system: FIVE MODELS REPEATING THE SAME CAUSAL STORY
 * IS NOT INDEPENDENT PROOF THAT STORY IS TRUE. Every score this module
 * produces (coverageCount/coverageRatio) is reported as exactly what it is —
 * how many models converged on a factor — and is NEVER rolled into a
 * "certainty", "confidence", or "evidenceStrength: strong" value derived
 * from that count alone. `evidenceStrength` only ever reflects a genuinely
 * independent signal (the panel's OWN flagged disagreement), defaulting to
 * "unknown" otherwise — never inferred from popularity.
 *
 * Clustering runs on two different kinds of text with two different bars:
 *   - Short causal-factor labels/phrases (directCauses, contributingFactors,
 *     triggers, amplifiers, alternativeExplanations): a TIGHTER bar than
 *     prose, because "avoid merging causes merely because they share broad
 *     vocabulary" (approved design) — two genuinely distinct causes that
 *     both mention "demand" or "the economy" must not collapse into one.
 *   - Full-sentence prose (causalLinks' mechanism sentences,
 *     disputedInterpretations): a LOOSER bar, matching
 *     definitionAlignment.ts's directAnswer threshold — paraphrase drift
 *     over a full sentence produces a larger edit distance even when the
 *     underlying meaning is identical.
 *
 * Each of the 5 factor categories is clustered SEPARATELY (never across
 * categories) — a "direct cause" and a "contributing factor" naming the
 * same real-world thing stay in their own buckets, since collapsing them
 * would blur exactly the distinction this schema exists to preserve.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import {
  AggregatedCausalFactor,
  AggregatedCausalInterpretation,
  AggregatedCausalLink,
  CausalEvidenceStrength,
  CausalExplanationResult,
  CausalFactorCategory,
} from "./types";
import { dedupeTextList, normalizeSlug, textsAreNearDuplicates, UnionFind } from "./textSimilarity";

/** Short causal-factor phrases — tighter than prose, to avoid merging distinct causes that merely share common vocabulary. */
const FACTOR_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.7 };
/** Full-sentence mechanism/interpretation prose — looser, matching definitionAlignment.ts's directAnswer bar. */
const PROSE_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.35, tokenOverlapMin: 0.45 };
/** Confounders/unknowns/tests-needed — plain string lists, same bar enumAlignment.ts/definitionAlignment.ts use for keyPoints-style merging. */
const LIST_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

const CONFOUNDERS_CAP = 5;
const UNKNOWNS_CAP = 5;
const TESTS_NEEDED_CAP = 5;

const CATEGORY_BY_FIELD: Record<string, CausalFactorCategory> = {
  directCauses: "direct_cause",
  contributingFactors: "contributing_factor",
  triggers: "trigger",
  amplifiers: "amplifier",
  alternativeExplanations: "alternative_explanation",
};

/** causalAlignment's per-model raw shape — mirrors schemaRegistry.ts's causalExplanationFields keys after extraction from AdaptiveModelResult.data. */
export interface CausalExplanationFields {
  directAnswer: string;
  directCauses: string[];
  contributingFactors: string[];
  triggers: string[];
  amplifiers: string[];
  alternativeExplanations: string[];
  causalLinks: string[];
  confounders: string[];
  disputedInterpretations: string[];
  unknowns: string[];
  testsOrEvidenceNeeded: string[];
  sources: string[];
}

/** Extracts the schema's 12 flat keys from one model's validated data, defaulting missing/malformed fields safely rather than throwing — a salvaged partial response may be missing any of them. */
export function extractCausalFields(data: Record<string, any>): CausalExplanationFields {
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    directAnswer: typeof data.directAnswer === "string" ? data.directAnswer : "",
    directCauses: arr(data.directCauses),
    contributingFactors: arr(data.contributingFactors),
    triggers: arr(data.triggers),
    amplifiers: arr(data.amplifiers),
    alternativeExplanations: arr(data.alternativeExplanations),
    causalLinks: arr(data.causalLinks),
    confounders: arr(data.confounders),
    disputedInterpretations: arr(data.disputedInterpretations),
    unknowns: arr(data.unknowns),
    testsOrEvidenceNeeded: arr(data.testsOrEvidenceNeeded),
    sources: arr(data.sources),
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

function slugify(label: string, used: Set<string>): string {
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

interface RawText {
  index: number;
  modelId: ModelId;
  text: string;
}

interface TextCluster {
  label: string;
  entries: RawText[];
  coverageCount: number;
  firstSeenIndex: number;
}

/** Clusters a flat list of {modelId, text} entries via union-find + a pairwise matcher, deduping same-model repeats within a cluster before counting coverage. */
function clusterRawTexts(entries: RawText[], matches: (a: string, b: string) => boolean): TextCluster[] {
  if (entries.length === 0) return [];
  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (matches(entries[i].text, entries[j].text)) uf.union(i, j);
    }
  }
  const groups = new Map<number, RawText[]>();
  for (let i = 0; i < entries.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(entries[i]);
  }
  return Array.from(groups.values()).map((group) => ({
    label: modeOrLongest(group.map((e) => e.text)),
    entries: group,
    coverageCount: new Set(group.map((e) => e.modelId)).size,
    firstSeenIndex: Math.min(...group.map((e) => e.index)),
  }));
}

/**
 * Builds every model's own contribution to one category (directCauses,
 * contributingFactors, etc.) into a flat, indexed RawText[] — the input to
 * clusterRawTexts. Preserves cross-model ordering (models earlier in
 * `perModel` come first) so firstSeenIndex reflects a stable, meaningful
 * order rather than an arbitrary one.
 */
function flattenField(perModel: { modelId: ModelId; values: string[] }[]): RawText[] {
  let index = 0;
  const out: RawText[] = [];
  for (const { modelId, values } of perModel) {
    for (const text of values) out.push({ index: index++, modelId, text });
  }
  return out;
}

export function buildCausalExplanationResult(
  perModel: { modelId: ModelId; fields: CausalExplanationFields }[],
  totalModels: number
): CausalExplanationResult {
  if (perModel.length === 0) {
    return {
      directAnswer: "",
      factors: [],
      causalChain: [],
      confounders: [],
      disputedInterpretations: [],
      unknowns: [],
      testsOrEvidenceNeeded: [],
      sourceBacked: false,
      sources: [],
      totalModels,
    };
  }

  const directAnswer = modeOrLongest(perModel.map((p) => p.fields.directAnswer).filter((a) => a.trim().length > 0));
  const modelsWithSources = new Set(perModel.filter((p) => p.fields.sources.length > 0).map((p) => p.modelId));
  const sourceBacked = modelsWithSources.size > 0;
  // Phase 10D.1 — exact-string dedup only (mirrors decisionReceiptBuilder.ts's dedupeExact), never fuzzy-clustered.
  const sources = Array.from(new Set(perModel.flatMap((p) => p.fields.sources).map((s) => s.trim()).filter((s) => s.length > 0)));

  const usedFactorIds = new Set<string>();

  // ── Per-category factor clustering (never merged across categories) ──
  const factorFieldKeys: (keyof typeof CATEGORY_BY_FIELD)[] = [
    "directCauses",
    "contributingFactors",
    "triggers",
    "amplifiers",
    "alternativeExplanations",
  ];

  const clustersByCategory = new Map<CausalFactorCategory, TextCluster[]>();
  for (const fieldKey of factorFieldKeys) {
    const raw = flattenField(perModel.map((p) => ({ modelId: p.modelId, values: (p.fields as any)[fieldKey] as string[] })));
    clustersByCategory.set(CATEGORY_BY_FIELD[fieldKey], clusterRawTexts(raw, (a, b) => textsAreNearDuplicates(a, b, FACTOR_DEDUP_THRESHOLDS)));
  }

  // Disputed interpretations are clustered independently (prose bar) BEFORE
  // factor "contested" tagging below, so factors can cross-reference them.
  const disputedRaw = flattenField(perModel.map((p) => ({ modelId: p.modelId, values: p.fields.disputedInterpretations })));
  const disputedClusters = clusterRawTexts(disputedRaw, (a, b) => textsAreNearDuplicates(a, b, PROSE_DEDUP_THRESHOLDS));

  const supportingCategories: CausalFactorCategory[] = ["direct_cause", "contributing_factor", "trigger", "amplifier"];

  function computeEvidenceStrength(label: string, ownCategory: CausalFactorCategory): CausalEvidenceStrength {
    // Deliberately does NOT cross-check factor labels (short phrases)
    // against disputedInterpretations (full sentences): the shared
    // overlap-coefficient matcher scores close to 1.0 whenever a short
    // phrase's few tokens all happen to appear somewhere in a much longer
    // sentence, REGARDLESS of topical relevance — exactly the "merging on
    // shared broad vocabulary" failure mode this schema is required to
    // avoid. Only same-length-class comparisons (factor vs. factor, below)
    // are reliable enough to use here.
    //
    // Contested if models disagree on WHETHER this is a real cause vs. an
    // alternative/competing explanation (category disagreement is itself a
    // genuine, independent disagreement signal — not popularity).
    if (ownCategory === "alternative_explanation") {
      for (const cat of supportingCategories) {
        if ((clustersByCategory.get(cat) || []).some((c) => textsAreNearDuplicates(c.label, label, FACTOR_DEDUP_THRESHOLDS))) {
          return "contested";
        }
      }
    } else {
      const altClusters = clustersByCategory.get("alternative_explanation") || [];
      if (altClusters.some((c) => textsAreNearDuplicates(c.label, label, FACTOR_DEDUP_THRESHOLDS))) {
        return "contested";
      }
    }
    return "unknown";
  }

  const factors: AggregatedCausalFactor[] = [];
  for (const [category, clusters] of clustersByCategory) {
    for (const cluster of clusters) {
      const contributingModelIds = new Set(cluster.entries.map((e) => e.modelId));
      const factorSourceBacked = Array.from(contributingModelIds).some((id) => modelsWithSources.has(id));
      factors.push({
        id: slugify(cluster.label, usedFactorIds),
        label: cluster.label,
        category,
        coverageCount: cluster.coverageCount,
        totalModels,
        coverageRatio: totalModels > 0 ? cluster.coverageCount / totalModels : 0,
        contributingModels: Array.from(contributingModelIds),
        evidenceStrength: computeEvidenceStrength(cluster.label, category),
        sourceBacked: factorSourceBacked,
      });
    }
  }
  // Stable, readable order: highest coverage first, category as a tiebreak
  // (direct causes before contributing factors, etc.), then first-seen.
  const categoryOrder: CausalFactorCategory[] = [
    "direct_cause",
    "contributing_factor",
    "trigger",
    "amplifier",
    "protective_factor",
    "alternative_explanation",
  ];
  factors.sort((a, b) => b.coverageCount - a.coverageCount || categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category));

  // ── Causal chain / mechanisms (prose bar) ──
  const causalLinksRaw = flattenField(perModel.map((p) => ({ modelId: p.modelId, values: p.fields.causalLinks })));
  const usedLinkIds = new Set<string>();
  const causalChain: AggregatedCausalLink[] = clusterRawTexts(causalLinksRaw, (a, b) => textsAreNearDuplicates(a, b, PROSE_DEDUP_THRESHOLDS))
    .sort((a, b) => b.coverageCount - a.coverageCount || a.firstSeenIndex - b.firstSeenIndex)
    .map((c) => ({
      id: slugify(c.label, usedLinkIds),
      mechanism: c.label,
      coverageCount: c.coverageCount,
      totalModels,
      coverageRatio: totalModels > 0 ? c.coverageCount / totalModels : 0,
      contributingModels: Array.from(new Set(c.entries.map((e) => e.modelId))),
    }));

  // ── Disputed interpretations — NEVER filtered by coverage; a minority
  // explanation is exactly what this field exists to keep visible. ──
  const disputedInterpretations: AggregatedCausalInterpretation[] = disputedClusters
    .sort((a, b) => b.entries.length - a.entries.length || a.firstSeenIndex - b.firstSeenIndex)
    .map((c) => ({ label: c.label, supportingModels: Array.from(new Set(c.entries.map((e) => e.modelId))) }));

  // ── Plain string-list fields — dedupe/merge, no per-item structure needed. ──
  const confounders = dedupeTextList(perModel.flatMap((p) => p.fields.confounders), { ...LIST_DEDUP_THRESHOLDS, cap: CONFOUNDERS_CAP });
  const unknowns = dedupeTextList(perModel.flatMap((p) => p.fields.unknowns), { ...LIST_DEDUP_THRESHOLDS, cap: UNKNOWNS_CAP });
  const testsOrEvidenceNeeded = dedupeTextList(perModel.flatMap((p) => p.fields.testsOrEvidenceNeeded), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: TESTS_NEEDED_CAP,
  });

  return {
    directAnswer,
    factors,
    causalChain,
    confounders,
    disputedInterpretations,
    unknowns,
    testsOrEvidenceNeeded,
    sourceBacked,
    sources,
    totalModels,
  };
}
