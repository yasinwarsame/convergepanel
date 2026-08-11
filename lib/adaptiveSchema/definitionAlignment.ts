/**
 * Definition Explanation Alignment (Milestone 2 — third activated schema in
 * the query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline, same reasoning as
 * enumAlignment.ts/comparisonAlignment.ts: a definition's atomic unit is a
 * whole INTERPRETATION of the term (directAnswer + explanation + its
 * supporting fields together), not a single claim to score for stance
 * agreement. Forcing "accuracy vs precision" or "What is a model?" through a
 * claim-agreement score would either falsely average together two
 * legitimately different domain meanings, or falsely flag ordinary
 * paraphrase drift as disagreement — exactly what the product spec forbids
 * ("do not assign a false consensus score to subjective wording
 * differences").
 *
 * Clustering runs once, on `directAnswer` only (the one field guaranteed to
 * state what the term IS, unlike `explanation`, which may elaborate very
 * differently even when two models agree on the core answer) — models whose
 * directAnswer clusters together are treated as one interpretation; every
 * other field for that interpretation is then merged/deduped WITHIN the
 * cluster. A model whose directAnswer clusters separately becomes its own
 * interpretation, preserved rather than merged away — this is deliberately
 * the ONLY signal for "is this a materially different interpretation," since
 * this module cannot (and doesn't try to) distinguish "these models
 * genuinely mean different things" from "one model is simply wrong" — see
 * DefinitionExplanationResult.isAmbiguous's doc comment in types.ts.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import {
  AggregatedDefinitionInterpretation,
  DefinitionDistinction,
  DefinitionExplanationResult,
  DefinitionProcessStep,
} from "./types";
import { dedupeTextList, textsAreNearDuplicates, UnionFind } from "./textSimilarity";

/** definitionAlignment's per-model raw shape — mirrors schemaRegistry.ts's definitionExplanationFields keys after extraction from AdaptiveModelResult.data. */
export interface DefinitionExplanationFields {
  term: string;
  directAnswer: string;
  explanation: string;
  keyPoints: string[];
  example: string;
  analogyText: string;
  analogyLimits: string;
  distinctions: DefinitionDistinction[];
  processSteps: DefinitionProcessStep[];
  advancedDetail: string;
  commonMisconceptions: string[];
  relatedConcepts: string[];
  sources: string[];
}

/** directAnswer is a 1-2 sentence paraphrase of the same idea across models — a looser bar than comparison_matrix's subject axis, since merging paraphrases here is exactly the intended behavior, not a risk. */
const DIRECT_ANSWER_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.35, tokenOverlapMin: 0.45 };
/** Sub-field text items (keyPoints/misconceptions/relatedConcepts/distinction concepts/process step titles) — same moderate bar throughout. */
const SUBFIELD_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

const KEY_POINTS_CAP = 5;
const DISTINCTIONS_CAP = 4;
const PROCESS_STEPS_CAP = 8;
const MISCONCEPTIONS_CAP = 3;
const RELATED_CONCEPTS_CAP = 5;
const SOURCES_CAP = 5;

/** Every optional field uses the "none" sentinel at the wire/validation layer (matching factual_lookup's caveat / graceful_limitation's convention) — converted to real optionality once aggregated, so the renderer never has to string-compare against "none". */
function noneToUndefined(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}

function longestNonNone(values: string[]): string | undefined {
  let best: string | undefined;
  for (const v of values) {
    const cleaned = noneToUndefined(v);
    if (cleaned && (!best || cleaned.length > best.length)) best = cleaned;
  }
  return best;
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

/** Merges near-duplicate {concept, explanation} items across models, keyed on `concept` text similarity — keeps the longest explanation per merged concept. */
function mergeDistinctions(items: DefinitionDistinction[], cap: number): DefinitionDistinction[] {
  if (items.length === 0) return [];
  const uf = new UnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (textsAreNearDuplicates(items[i].concept, items[j].concept, SUBFIELD_DEDUP_THRESHOLDS)) uf.union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return Array.from(groups.values())
    .map((idxs) => ({
      concept: modeOrLongest(idxs.map((i) => items[i].concept)),
      explanation: idxs.map((i) => items[i].explanation).reduce((longest, text) => (text.length > longest.length ? text : longest), ""),
    }))
    .slice(0, cap);
}

/** Merges near-duplicate process steps across models, keyed on `title` text similarity — keeps the longest explanation, then renumbers sequentially by mean original order (a cross-model merge can't preserve any one model's own numbering). */
function mergeProcessSteps(items: DefinitionProcessStep[], cap: number): DefinitionProcessStep[] {
  if (items.length === 0) return [];
  const uf = new UnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (textsAreNearDuplicates(items[i].title, items[j].title, SUBFIELD_DEDUP_THRESHOLDS)) uf.union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }
  return Array.from(groups.values())
    .map((idxs) => ({
      title: modeOrLongest(idxs.map((i) => items[i].title)),
      explanation: idxs.map((i) => items[i].explanation).reduce((longest, text) => (text.length > longest.length ? text : longest), ""),
      meanOrder: idxs.reduce((sum, i) => sum + items[i].number, 0) / idxs.length,
    }))
    .sort((a, b) => a.meanOrder - b.meanOrder)
    .slice(0, cap)
    .map((step, idx) => ({ number: idx + 1, title: step.title, explanation: step.explanation }));
}

/** Extracts the schema's 13 flat keys from one model's validated data, defaulting missing/malformed fields safely rather than throwing — a salvaged partial response may be missing any of them. */
export function extractDefinitionFields(data: Record<string, any>): DefinitionExplanationFields {
  return {
    term: typeof data.term === "string" ? data.term : "none",
    directAnswer: typeof data.directAnswer === "string" ? data.directAnswer : "",
    explanation: typeof data.explanation === "string" ? data.explanation : "",
    keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints : [],
    example: typeof data.example === "string" ? data.example : "none",
    analogyText: typeof data.analogyText === "string" ? data.analogyText : "none",
    analogyLimits: typeof data.analogyLimits === "string" ? data.analogyLimits : "none",
    distinctions: Array.isArray(data.distinctions) ? data.distinctions : [],
    processSteps: Array.isArray(data.processSteps) ? data.processSteps : [],
    advancedDetail: typeof data.advancedDetail === "string" ? data.advancedDetail : "none",
    commonMisconceptions: Array.isArray(data.commonMisconceptions) ? data.commonMisconceptions : [],
    relatedConcepts: Array.isArray(data.relatedConcepts) ? data.relatedConcepts : [],
    sources: Array.isArray(data.sources) ? data.sources : [],
  };
}

interface RawEntry {
  index: number;
  modelId: ModelId;
  fields: DefinitionExplanationFields;
}

function buildInterpretation(entries: RawEntry[], totalModels: number): AggregatedDefinitionInterpretation {
  const term = longestNonNone(entries.map((e) => e.fields.term)) ?? "none";
  const directAnswer = modeOrLongest(entries.map((e) => e.fields.directAnswer));
  const explanation = entries
    .map((e) => e.fields.explanation)
    .reduce((longest, text) => (text.length > longest.length ? text : longest), "");

  const keyPoints = dedupeTextList(entries.flatMap((e) => e.fields.keyPoints), { ...SUBFIELD_DEDUP_THRESHOLDS, cap: KEY_POINTS_CAP });
  const example = longestNonNone(entries.map((e) => e.fields.example));

  // Analogy text + its limits must come from the SAME model — never mix an
  // analogy from one model with a limitation caveat from a different model.
  // `limits` (nested one level inside `analogy`) is itself optional-not-
  // -nullable — the same conditional-spread treatment applies inside this
  // nested object too, not just at the top level.
  const analogySource = entries.find((e) => noneToUndefined(e.fields.analogyText));
  const analogyLimits = analogySource ? noneToUndefined(analogySource.fields.analogyLimits) : undefined;
  const analogy = analogySource
    ? { text: noneToUndefined(analogySource.fields.analogyText)!, ...(analogyLimits !== undefined ? { limits: analogyLimits } : {}) }
    : undefined;

  const distinctions = mergeDistinctions(entries.flatMap((e) => e.fields.distinctions), DISTINCTIONS_CAP);
  const processSteps = mergeProcessSteps(entries.flatMap((e) => e.fields.processSteps), PROCESS_STEPS_CAP);
  const advancedDetail = longestNonNone(entries.map((e) => e.fields.advancedDetail));
  const commonMisconceptions = dedupeTextList(entries.flatMap((e) => e.fields.commonMisconceptions), {
    ...SUBFIELD_DEDUP_THRESHOLDS,
    cap: MISCONCEPTIONS_CAP,
  });
  const relatedConcepts = dedupeTextList(entries.flatMap((e) => e.fields.relatedConcepts), {
    ...SUBFIELD_DEDUP_THRESHOLDS,
    cap: RELATED_CONCEPTS_CAP,
  });
  const sources = Array.from(new Set(entries.flatMap((e) => e.fields.sources))).slice(0, SOURCES_CAP);

  // Producer canonicalization: example/analogy/advancedDetail are all
  // genuinely absent when every model used the "none" sentinel — conditional
  // spread keeps the key genuinely absent rather than an own-property with
  // value undefined (see buildComparisonMatrixResult's own comment).
  return {
    coverageCount: entries.length,
    totalModels,
    coverageRatio: totalModels > 0 ? entries.length / totalModels : 0,
    contributingModels: entries.map((e) => e.modelId),
    term,
    directAnswer,
    explanation,
    keyPoints,
    ...(example !== undefined ? { example } : {}),
    ...(analogy !== undefined ? { analogy } : {}),
    distinctions,
    processSteps,
    ...(advancedDetail !== undefined ? { advancedDetail } : {}),
    commonMisconceptions,
    relatedConcepts,
    sources,
  };
}

/**
 * Clusters every model's own DefinitionExplanationFields into one or more
 * merged interpretations — definition_explanation's equivalent of
 * alignClaims()/buildRankedEnumerationResult()/buildComparisonMatrixResult().
 * `totalModels` is passed explicitly (rather than derived from `perModel`)
 * because `perModel` here contains only models that produced usable data —
 * unlike ranked_enumeration/comparison_matrix, a model with no parseable
 * response has no fields object at all to include as an empty placeholder.
 * Never throws; empty `perModel` yields `{ primary: null, ... }`, not an
 * error.
 */
export function buildDefinitionExplanationResult(
  perModel: { modelId: ModelId; fields: DefinitionExplanationFields }[],
  totalModels: number
): DefinitionExplanationResult {
  if (perModel.length === 0) {
    return { primary: null, alternateInterpretations: [], isAmbiguous: false, sourceBacked: false, totalModels };
  }

  const entries: RawEntry[] = perModel.map((p, index) => ({ index, modelId: p.modelId, fields: p.fields }));

  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (textsAreNearDuplicates(entries[i].fields.directAnswer, entries[j].fields.directAnswer, DIRECT_ANSWER_DEDUP_THRESHOLDS)) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map<number, RawEntry[]>();
  for (const entry of entries) {
    const root = uf.find(entry.index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(entry);
  }

  const interpretations = Array.from(groups.values())
    .map((group) => ({ group, firstSeenIndex: Math.min(...group.map((e) => e.index)) }))
    .sort((a, b) => b.group.length - a.group.length || a.firstSeenIndex - b.firstSeenIndex)
    .map(({ group }) => buildInterpretation(group, totalModels));

  const [primary, ...alternateInterpretations] = interpretations;

  return {
    primary,
    alternateInterpretations,
    isAmbiguous: alternateInterpretations.length > 0,
    sourceBacked: (primary?.sources.length ?? 0) > 0,
    totalModels,
  };
}
