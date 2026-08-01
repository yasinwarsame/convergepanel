/**
 * Decision Support Alignment (Milestone 2 — ninth activated schema in the
 * query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline, and deliberately NOT
 * reusing claim alignment at all (per the approved design) — a decision's
 * atomic units are two independent axes (options × criteria, the same
 * architectural shape as comparisonAlignment.ts's subject × attribute grid)
 * plus a recommendation layered on top of them.
 *
 * The single most important rule in this file: `recommendation` is NEVER a
 * raw vote count. Every contributing model's own recommended action is
 * collected, but the aggregate action is only ever a genuine, UNIFORM signal
 * across those models — any real split (different actions, or the same
 * "choose_option" action naming different options) falls back to a
 * conservative action ("escalate"/"defer"/"conditional_go") plus a plainly
 * stated explanation of the disagreement, never a silently-picked majority.
 * `supportCount`/`totalModelsWithRecommendation` report plain convergence for
 * transparency only, exactly like every other coverageCount in this system —
 * never converted into a certainty/confidence score.
 *
 * Clustering uses the same three-tier bar this system has used since
 * causal_explanation: options are short named entities (tight, subset-merge
 * disabled — same subjectsMatch-style matcher comparisonAlignment.ts uses
 * for subjects, since "HubSpot Marketing Hub" and "HubSpot Sales Hub" are
 * different real things), criteria are short labels (tight, "avoid merging
 * on shared broad vocabulary"), and risk labels are full-sentence prose
 * (loose, matching causalAlignment.ts's PROSE_DEDUP_THRESHOLDS).
 */

import "server-only";
import { ModelId } from "@/lib/types";
import {
  AggregatedDecisionAssessment,
  AggregatedDecisionCriterion,
  AggregatedDecisionOption,
  AggregatedDecisionRisk,
  CausalEvidenceStrength,
  DecisionAssessment,
  DecisionRecommendation,
  DecisionRecommendationAction,
  DecisionRisk,
  DecisionSupportResult,
  RiskLevel,
} from "./types";
import { dedupeTextList, hasIdenticalTokenSet, normalizeSlug, textsAreNearDuplicates, UnionFind } from "./textSimilarity";

/** Criteria are short labels ("Total cost", "Ease of integration") — tight bar, avoids merging distinct criteria that merely share vocabulary. Same bar causalAlignment.ts uses for factor labels. */
const CRITERION_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.7 };
/** Risk labels are full-sentence prose — looser bar, matching causalAlignment.ts's causal-link/disputed-interpretation bar. */
const RISK_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.35, tokenOverlapMin: 0.45 };
/** Plain list-style strings (assumptions/uncertainties/caveats/sensitivity findings) — same bar used throughout Milestone 2. */
const LIST_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

/**
 * Options are short named entities where a false merge silently conflates
 * two distinct real-world choices (e.g. "HubSpot Marketing Hub" and "HubSpot
 * Sales Hub" are different products). Same reasoning and same matcher shape
 * as comparisonAlignment.ts's subjectsMatch: tokenOverlapMin is set above 1
 * to disable textsAreNearDuplicates' subset-containment branch entirely,
 * leaving only tight Levenshtein (formatting/case drift) plus
 * hasIdenticalTokenSet (pure word reordering) active.
 */
function optionsMatch(a: string, b: string): boolean {
  return textsAreNearDuplicates(a, b, { levenshteinMaxRatio: 0.15, tokenOverlapMin: 1.01 }) || hasIdenticalTokenSet(a, b);
}

function criteriaMatch(a: string, b: string): boolean {
  return textsAreNearDuplicates(a, b, CRITERION_DEDUP_THRESHOLDS);
}

function risksMatch(a: string, b: string): boolean {
  return textsAreNearDuplicates(a, b, RISK_DEDUP_THRESHOLDS);
}

const ASSUMPTIONS_CAP = 5;
const UNCERTAINTIES_CAP = 5;
const SENSITIVITY_FINDINGS_CAP = 4;
const RECOMMENDATION_CAVEATS_CAP = 5;

const VALID_ACTIONS: DecisionRecommendationAction[] = [
  "go",
  "conditional_go",
  "defer",
  "no_go",
  "escalate",
  "monitor",
  "choose_option",
];

/** Tolerates minor casing/spacing/hyphen drift ("Go", "no-go") without accepting an unrecognized value — an unparseable action contributes no vote at all, never a fabricated default. */
function parseRecommendationAction(raw: string): DecisionRecommendationAction | null {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (VALID_ACTIONS as string[]).includes(normalized) ? (normalized as DecisionRecommendationAction) : null;
}

/** decisionSupportAlignment's per-model raw shape — mirrors schemaRegistry.ts's decisionSupportFields keys after extraction from AdaptiveModelResult.data. */
export interface DecisionSupportFields {
  decisionQuestion: string;
  options: string[];
  criteria: string[];
  userProvidedCriteria: string[];
  assessments: DecisionAssessment[];
  recommendationAction: string;
  recommendedOption: string;
  recommendationRationale: string;
  recommendationCaveats: string[];
  assumptions: string[];
  uncertainties: string[];
  risks: DecisionRisk[];
  sensitivityFindings: string[];
  reversibleNextStep: string;
  sources: string[];
}

/** Extracts the schema's 15 flat keys from one model's validated data, defaulting missing/malformed fields safely rather than throwing — a salvaged partial response may be missing any of them. */
export function extractDecisionSupportFields(data: Record<string, any>): DecisionSupportFields {
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    decisionQuestion: typeof data.decisionQuestion === "string" ? data.decisionQuestion : "",
    options: strArr(data.options),
    criteria: strArr(data.criteria),
    userProvidedCriteria: strArr(data.userProvidedCriteria),
    assessments: Array.isArray(data.assessments) ? data.assessments : [],
    recommendationAction: typeof data.recommendationAction === "string" ? data.recommendationAction : "",
    recommendedOption: typeof data.recommendedOption === "string" ? data.recommendedOption : "none",
    recommendationRationale: typeof data.recommendationRationale === "string" ? data.recommendationRationale : "",
    recommendationCaveats: strArr(data.recommendationCaveats),
    assumptions: strArr(data.assumptions),
    uncertainties: strArr(data.uncertainties),
    risks: Array.isArray(data.risks) ? data.risks : [],
    sensitivityFindings: strArr(data.sensitivityFindings),
    reversibleNextStep: typeof data.reversibleNextStep === "string" ? data.reversibleNextStep : "",
    sources: strArr(data.sources),
  };
}

function modeOrLongest(values: string[]): string {
  const nonEmpty = values.filter((v) => v.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  const counts = new Map<string, number>();
  for (const v of nonEmpty) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = nonEmpty[0];
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

/** Clusters a flat list of {modelId, text} entries (or a subtype carrying extra per-entry data) via union-find + a pairwise matcher, deduping same-model repeats within a cluster before counting coverage. Generic so criteria entries can carry an extra `isUserProvided` flag through clustering untouched. */
function clusterRawTexts<T extends RawText>(entries: T[], matches: (a: string, b: string) => boolean): { label: string; entries: T[]; coverageCount: number; firstSeenIndex: number }[] {
  if (entries.length === 0) return [];
  const uf = new UnionFind(entries.length);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (matches(entries[i].text, entries[j].text)) uf.union(i, j);
    }
  }
  const groups = new Map<number, T[]>();
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

function flattenField(perModel: { modelId: ModelId; values: string[] }[]): RawText[] {
  let index = 0;
  const out: RawText[] = [];
  for (const { modelId, values } of perModel) {
    for (const text of values) out.push({ index: index++, modelId, text });
  }
  return out;
}

interface AxisCluster {
  id: string;
  label: string;
  coverageCount: number;
  totalModels: number;
  coverageRatio: number;
  contributingModels: ModelId[];
  firstSeenIndex: number;
  /** Kept for downstream fuzzy matching (assessments/risks resolving a raw label to this cluster) — stripped before this cluster is exposed as an AggregatedDecisionOption/Criterion. */
  entries: RawText[];
}

function buildAxisClusters(
  entries: RawText[],
  matcher: (a: string, b: string) => boolean,
  totalModels: number,
  usedIds: Set<string>
): AxisCluster[] {
  return clusterRawTexts(entries, matcher).map((c) => ({
    id: slugify(c.label, usedIds),
    label: c.label,
    coverageCount: c.coverageCount,
    totalModels,
    coverageRatio: totalModels > 0 ? c.coverageCount / totalModels : 0,
    contributingModels: Array.from(new Set(c.entries.map((e) => e.modelId))),
    firstSeenIndex: c.firstSeenIndex,
    entries: c.entries,
  }));
}

/** Resolves a raw label (e.g. a DecisionAssessment.optionLabel) to the canonical cluster it refers to — matches against the cluster's merged label OR any individual contributing entry, since a model may phrase its own cross-reference slightly differently than the label that won modeOrLongest. Returns undefined for a stray/hallucinated reference rather than inventing a new axis entry. */
function resolveCluster(text: string, clusters: AxisCluster[], matcher: (a: string, b: string) => boolean): AxisCluster | undefined {
  return clusters.find((c) => matcher(text, c.label) || c.entries.some((e) => matcher(text, e.text)));
}

function stripAxisInternals(clusters: AxisCluster[]): Omit<AxisCluster, "firstSeenIndex" | "entries">[] {
  return clusters.map(({ firstSeenIndex, entries, ...rest }) => rest);
}

/** "unknown" when contributing models' own reads genuinely disagree — never inferred from coverage. Reused for evidenceStrength/likelihood/impact merges below (first occurrence per model wins). */
function mergeEnumRead<T extends string>(valuesByModel: Map<ModelId, T>, unknownValue: T): T | undefined {
  const distinct = new Set(valuesByModel.values());
  if (distinct.size === 0) return undefined;
  if (distinct.size > 1) return unknownValue;
  return Array.from(distinct)[0];
}

export function buildDecisionSupportResult(
  perModel: { modelId: ModelId; fields: DecisionSupportFields }[],
  totalModels: number = perModel.length,
  riskLevel?: RiskLevel
): DecisionSupportResult {
  if (perModel.length === 0) {
    return {
      decisionQuestion: "",
      options: [],
      criteria: [],
      assessments: [],
      recommendation: {
        action: "escalate",
        rationale: "No contributing model produced a usable response, so this decision is escalated for human review.",
        caveats: [],
        isContested: false,
        supportCount: 0,
        totalModelsWithRecommendation: 0,
      },
      assumptions: [],
      uncertainties: [],
      risks: [],
      sensitivityFindings: [],
      humanReviewNeeded: true,
      sourceBacked: false,
      totalModels,
    };
  }

  const decisionQuestion = modeOrLongest(perModel.map((p) => p.fields.decisionQuestion));
  const modelsWithSources = new Set(perModel.filter((p) => p.fields.sources.length > 0).map((p) => p.modelId));
  const sourceBacked = modelsWithSources.size > 0;

  // ── Options axis. DecisionSupportResult has no low-confidence bucket for
  // options (unlike comparison_matrix's subjects/attributes) — a decision's
  // options are almost always few and every one of them matters to show, so
  // they're simply sorted by coverage rather than partially hidden. ──
  const usedOptionIds = new Set<string>();
  const optionEntries = flattenField(perModel.map((p) => ({ modelId: p.modelId, values: p.fields.options })));
  const optionClusters = buildAxisClusters(optionEntries, optionsMatch, totalModels, usedOptionIds);
  const sortedOptionClusters = [...optionClusters].sort((a, b) => b.coverageCount - a.coverageCount || a.firstSeenIndex - b.firstSeenIndex);
  const options: AggregatedDecisionOption[] = stripAxisInternals(sortedOptionClusters) as AggregatedDecisionOption[];

  // ── Criteria axis (with user-vs-model provenance) ──
  const usedCriterionIds = new Set<string>();
  let criterionIndex = 0;
  const criterionRaw: RawText[] = [];
  const userProvidedFlagByEntry = new Map<number, boolean>();
  for (const { modelId, fields } of perModel) {
    const userSet = new Set(fields.userProvidedCriteria.map((c) => c.trim()));
    for (const text of fields.criteria) {
      const idx = criterionIndex++;
      criterionRaw.push({ index: idx, modelId, text });
      userProvidedFlagByEntry.set(idx, userSet.has(text.trim()));
    }
  }
  const criterionClustersRaw = clusterRawTexts(criterionRaw, criteriaMatch);
  const criterionClusters: AxisCluster[] = criterionClustersRaw.map((c) => ({
    id: slugify(c.label, usedCriterionIds),
    label: c.label,
    coverageCount: c.coverageCount,
    totalModels,
    coverageRatio: totalModels > 0 ? c.coverageCount / totalModels : 0,
    contributingModels: Array.from(new Set(c.entries.map((e) => e.modelId))),
    firstSeenIndex: c.firstSeenIndex,
    entries: c.entries,
  }));
  const sortedCriterionClusters = [...criterionClusters].sort(
    (a, b) => b.coverageCount - a.coverageCount || a.firstSeenIndex - b.firstSeenIndex
  );
  const criteria: AggregatedDecisionCriterion[] = sortedCriterionClusters.map((c) => {
    const isUserProvided = c.entries.some((e) => userProvidedFlagByEntry.get(e.index) === true);
    const { firstSeenIndex, entries, ...rest } = c;
    return { ...rest, source: isUserProvided ? "user" : "model" };
  });

  // ── Assessments: match each raw (optionLabel, criterionLabel) pair against the canonical axes above; drop unresolvable references rather than inventing a new axis entry. ──
  interface AssessmentEntry {
    modelId: ModelId;
    item: DecisionAssessment;
  }
  const assessmentGroups = new Map<string, AssessmentEntry[]>();
  for (const { modelId, fields } of perModel) {
    for (const item of fields.assessments) {
      const optionCluster = resolveCluster(item.optionLabel, optionClusters, optionsMatch);
      const criterionCluster = resolveCluster(item.criterionLabel, criterionClusters, criteriaMatch);
      if (!optionCluster || !criterionCluster) continue;
      const key = `${optionCluster.id}::${criterionCluster.id}`;
      if (!assessmentGroups.has(key)) assessmentGroups.set(key, []);
      assessmentGroups.get(key)!.push({ modelId, item });
    }
  }
  const assessments: AggregatedDecisionAssessment[] = Array.from(assessmentGroups.entries()).map(([key, group]) => {
    const [optionId, criterionId] = key.split("::");
    const assessment = group.map((e) => e.item.assessment).reduce((longest, t) => (t.length > longest.length ? t : longest), "");
    const strengthByModel = new Map<ModelId, CausalEvidenceStrength>();
    for (const { modelId, item } of group) {
      if (item.evidenceStrength && !strengthByModel.has(modelId)) strengthByModel.set(modelId, item.evidenceStrength);
    }
    const distinctStrengths = new Set(strengthByModel.values());
    let evidenceStrength: CausalEvidenceStrength;
    if (distinctStrengths.size === 0) evidenceStrength = "unknown";
    else if (distinctStrengths.has("contested") || distinctStrengths.size > 1) evidenceStrength = "contested";
    else evidenceStrength = Array.from(distinctStrengths)[0];
    const contributingModels = Array.from(new Set(group.map((e) => e.modelId)));
    return {
      optionId,
      criterionId,
      assessment,
      evidenceStrength,
      coverageCount: contributingModels.length,
      totalModels,
      contributingModels,
    };
  });

  // ── Risks: prose-clustered, never dropped for low coverage (a minority-flagged risk is exactly what this field exists to keep visible). ──
  const usedRiskIds = new Set<string>();
  let riskIndex = 0;
  interface RiskRawText extends RawText {
    risk: DecisionRisk;
  }
  const riskRaw: RiskRawText[] = [];
  for (const { modelId, fields } of perModel) {
    for (const risk of fields.risks) {
      riskRaw.push({ index: riskIndex++, modelId, text: risk.label, risk });
    }
  }
  const riskClusters = clusterRawTexts(riskRaw, risksMatch);
  const risks: AggregatedDecisionRisk[] = riskClusters
    .sort((a, b) => b.coverageCount - a.coverageCount || a.firstSeenIndex - b.firstSeenIndex)
    .map((cluster) => {
      const contributingModels = Array.from(new Set(cluster.entries.map((e) => e.modelId)));
      const likelihoodByModel = new Map<ModelId, "low" | "medium" | "high" | "unknown">();
      const impactByModel = new Map<ModelId, "low" | "medium" | "high" | "unknown">();
      let mitigation: string | undefined;
      let optionId: string | undefined;
      for (const entry of cluster.entries.sort((a, b) => a.index - b.index)) {
        if (entry.risk.likelihood && !likelihoodByModel.has(entry.modelId)) likelihoodByModel.set(entry.modelId, entry.risk.likelihood);
        if (entry.risk.impact && !impactByModel.has(entry.modelId)) impactByModel.set(entry.modelId, entry.risk.impact);
        if (!mitigation && entry.risk.mitigation && entry.risk.mitigation.trim().length > 0) mitigation = entry.risk.mitigation;
        if (!optionId && entry.risk.optionLabel) {
          const cluster2 = resolveCluster(entry.risk.optionLabel, optionClusters, optionsMatch);
          if (cluster2) optionId = cluster2.id;
        }
      }
      return {
        id: slugify(cluster.label, usedRiskIds),
        label: cluster.label,
        optionId,
        likelihood: mergeEnumRead(likelihoodByModel, "unknown"),
        impact: mergeEnumRead(impactByModel, "unknown"),
        mitigation,
        coverageCount: contributingModels.length,
        totalModels,
        contributingModels,
      };
    });

  // ── Plain string-list fields ──
  const assumptions = dedupeTextList(perModel.flatMap((p) => p.fields.assumptions), { ...LIST_DEDUP_THRESHOLDS, cap: ASSUMPTIONS_CAP });
  const uncertainties = dedupeTextList(perModel.flatMap((p) => p.fields.uncertainties), { ...LIST_DEDUP_THRESHOLDS, cap: UNCERTAINTIES_CAP });
  const sensitivityFindingsList = dedupeTextList(perModel.flatMap((p) => p.fields.sensitivityFindings), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: SENSITIVITY_FINDINGS_CAP,
  });
  const sensitivityFindings = sensitivityFindingsList.length > 0 ? sensitivityFindingsList : [];

  const reversibleNextStepRaw = modeOrLongest(
    perModel.map((p) => p.fields.reversibleNextStep).filter((s) => s.trim().length > 0 && s.trim().toLowerCase() !== "none")
  );
  const reversibleNextStep = reversibleNextStepRaw.trim().length > 0 ? reversibleNextStepRaw : undefined;

  // ── Recommendation: the central honesty-preserving aggregation. ──
  interface ModelRecommendation {
    modelId: ModelId;
    action: DecisionRecommendationAction;
    optionId?: string;
    rationale: string;
    caveats: string[];
  }
  const modelRecs: ModelRecommendation[] = [];
  for (const { modelId, fields } of perModel) {
    const action = parseRecommendationAction(fields.recommendationAction);
    if (!action) continue;
    let optionId: string | undefined;
    if (action === "choose_option" && fields.recommendedOption.trim().toLowerCase() !== "none") {
      const cluster = resolveCluster(fields.recommendedOption, optionClusters, optionsMatch);
      if (cluster) optionId = cluster.id;
    }
    modelRecs.push({ modelId, action, optionId, rationale: fields.recommendationRationale, caveats: fields.recommendationCaveats });
  }

  const totalModelsWithRecommendation = modelRecs.length;
  const distinctActions = new Set(modelRecs.map((r) => r.action));
  const rawCaveats = new Set<string>();
  for (const r of modelRecs) for (const c of r.caveats) if (c.trim().length > 0) rawCaveats.add(c.trim());

  let action: DecisionRecommendationAction;
  let recommendedOptionId: string | undefined;
  let isContested = false;
  let supportCount = 0;
  let rationale: string;

  if (modelRecs.length === 0) {
    action = "escalate";
    rationale = "No contributing model produced a parseable recommendation, so this decision is escalated for human review.";
  } else if (distinctActions.size > 1) {
    isContested = true;
    action = distinctActions.has("escalate") ? "escalate" : "defer";
    supportCount = Math.max(...Array.from(distinctActions).map((a) => modelRecs.filter((r) => r.action === a).length));
    const tally = Array.from(distinctActions)
      .map((a) => `${modelRecs.filter((r) => r.action === a).length} of ${modelRecs.length} recommend ${a.replace(/_/g, " ")}`)
      .join("; ");
    rationale = `Models disagree on the recommended action (${tally}). See caveats and risks for what would resolve this.`;
    rawCaveats.add(`Panel split: ${tally}.`);
  } else {
    action = Array.from(distinctActions)[0];
    supportCount = modelRecs.length;

    if (action === "choose_option") {
      const optionIds = modelRecs.map((r) => r.optionId).filter((id): id is string => !!id);
      const distinctOptionIds = new Set(optionIds);
      if (optionIds.length === 0) {
        action = "conditional_go";
        isContested = true;
        rationale = "Models agree a specific option should be chosen but did not name one this system could confidently resolve.";
      } else if (distinctOptionIds.size === 1 && optionIds.length === modelRecs.length) {
        recommendedOptionId = optionIds[0];
        rationale = modeOrLongest(modelRecs.map((r) => r.rationale));
      } else {
        action = "conditional_go";
        isContested = true;
        const tally = Array.from(distinctOptionIds)
          .map((id) => `${optionIds.filter((o) => o === id).length} of ${optionIds.length} pick ${options.find((o) => o.id === id)?.label ?? id}`)
          .join("; ");
        rationale = `Models agree an option should be chosen but disagree on which one (${tally}).`;
        rawCaveats.add(`Panel split on which option: ${tally}.`);
      }
    } else {
      rationale = modeOrLongest(modelRecs.map((r) => r.rationale));
    }
  }

  const caveats = dedupeTextList(Array.from(rawCaveats), { ...LIST_DEDUP_THRESHOLDS, cap: RECOMMENDATION_CAVEATS_CAP });

  const isHighStakes = riskLevel === "safety_critical" || riskLevel === "high_stakes";
  let weakEvidenceOnRecommended = false;
  if (recommendedOptionId) {
    const relevant = assessments.filter((a) => a.optionId === recommendedOptionId);
    if (relevant.length > 0) {
      const weakCount = relevant.filter((a) => a.evidenceStrength === "weak" || a.evidenceStrength === "contested" || a.evidenceStrength === "unknown").length;
      weakEvidenceOnRecommended = weakCount / relevant.length > 0.5;
    }
  }
  const humanReviewNeeded = isHighStakes || isContested || weakEvidenceOnRecommended || action === "escalate" || action === "defer";

  const recommendation: DecisionRecommendation = {
    action,
    recommendedOptionId,
    rationale,
    caveats,
    isContested,
    supportCount,
    totalModelsWithRecommendation,
  };

  return {
    decisionQuestion,
    options,
    criteria,
    assessments,
    recommendation,
    assumptions,
    uncertainties,
    risks,
    sensitivityFindings,
    reversibleNextStep,
    humanReviewNeeded,
    sourceBacked,
    totalModels,
  };
}
