/**
 * Deep Research Alignment (Milestone 2 — sixth activated schema in the
 * query-routing redesign).
 *
 * Deliberately NOT funneled through AlignedClaim/agreementComparators.ts/
 * the gate+synthesisReport+trustSummary pipeline — deep_research computes
 * its OWN executive summary deterministically from findings, never through
 * the shared narrative-synthesis call, and never assigns an overall
 * certainty/confidence score. Same central design discipline as
 * causal_explanation: panel repetition is convergence, never proof — a
 * finding's `evidenceStrength` defaults to "unknown" regardless of how many
 * models raised it, flipping to "contested" only on a genuine independent
 * signal (the same idea also appears among `disagreements`).
 *
 * Reuses two pieces of existing infrastructure rather than reinventing
 * them:
 *   - `textSimilarity.ts`'s dedupeTextList/UnionFind/textsAreNearDuplicates,
 *     the same clustering primitives every other Milestone 2 schema uses.
 *   - `coverageAudit.ts`'s `auditPanelCoverage` (Bias & Blind Spots Tier 2)
 *     for `panelBlindSpots` — a dedicated model call that already does
 *     exactly what "detect when all models omit the same important
 *     dimension" requires. That function's signature was broadened from
 *     `AlignedClaim[]` to plain `string[]` specifically to make this reuse
 *     possible without forcing deep_research's findings through claim
 *     alignment first.
 *
 * This is the only Milestone 2 alignment function that's `async` — the
 * blind-spot audit is a real (Gemini) model call.
 */

import "server-only";
import { ModelId } from "@/lib/types";
import {
  AggregatedResearchDisagreement,
  AggregatedResearchFinding,
  CausalEvidenceStrength,
  DeepResearchResult,
  QueryType,
  ResearchFinding,
} from "./types";
import { dedupeTextList, textsAreNearDuplicates, UnionFind } from "./textSimilarity";
import { auditPanelCoverage } from "./coverageAudit";

/** Finding summaries and disagreement statements are full-sentence prose — same bar causalAlignment.ts/definitionAlignment.ts use for prose-length text (looser than short-label clustering, since paraphrase drift over a full sentence produces a larger edit distance even when the meaning is identical). */
const PROSE_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.35, tokenOverlapMin: 0.45 };
/** Gaps/open-questions/boundaries/next-steps — plain caveat-style strings, same bar used throughout Milestone 2 for list merging. */
const LIST_DEDUP_THRESHOLDS = { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 };

/** Below this coverage, a finding moves to the low-confidence bucket — but only when the panel actually had more than 2 models. Identical rule to every other Milestone 2 schema's low-confidence bucket. */
const LOW_CONFIDENCE_MAX_COVERAGE = 2;

const EVIDENCE_GAPS_CAP = 5;
const OPEN_QUESTIONS_CAP = 5;
const RESEARCH_BOUNDARIES_CAP = 3;
const NEXT_STEPS_CAP = 3;

const DEEP_RESEARCH_SCHEMA_ID: QueryType = "deep_research";

/** deepResearchAlignment's per-model raw shape — mirrors schemaRegistry.ts's deepResearchFields keys after extraction from AdaptiveModelResult.data. */
export interface DeepResearchFields {
  executiveSummary: string;
  findings: ResearchFinding[];
  disagreements: string[];
  evidenceGaps: string[];
  openQuestions: string[];
  researchBoundaries: string[];
  recommendedNextSteps: string[];
  sources: string[];
}

/** Extracts the schema's 8 flat keys from one model's validated data, defaulting missing/malformed fields safely rather than throwing — a salvaged partial response may be missing any of them. */
export function extractDeepResearchFields(data: Record<string, any>): DeepResearchFields {
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    executiveSummary: typeof data.executiveSummary === "string" ? data.executiveSummary : "",
    findings: Array.isArray(data.findings) ? data.findings : [],
    disagreements: strArr(data.disagreements),
    evidenceGaps: strArr(data.evidenceGaps),
    openQuestions: strArr(data.openQuestions),
    researchBoundaries: strArr(data.researchBoundaries),
    recommendedNextSteps: strArr(data.recommendedNextSteps),
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

interface RawFindingEntry {
  index: number;
  modelId: ModelId;
  modelHadSources: boolean;
  finding: ResearchFinding;
}

interface RawTextEntry {
  index: number;
  modelId: ModelId;
  text: string;
}

function clusterByText<T extends { text: string }>(entries: T[], matches: (a: string, b: string) => boolean): T[][] {
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
  return Array.from(groups.values());
}

/**
 * Clusters every model's own ResearchFinding[]/disagreements/etc into one
 * merged research synthesis — this schema's equivalent of
 * buildDefinitionExplanationResult()/buildCausalExplanationResult(). The
 * only async Milestone 2 aggregation function (the blind-spot audit is a
 * real model call). Never throws; empty `perModel` yields an empty result,
 * not an error.
 */
export async function buildDeepResearchResult(
  perModel: { modelId: ModelId; fields: DeepResearchFields }[],
  question: string = ""
): Promise<DeepResearchResult> {
  const totalModels = perModel.length;

  const executiveSummary = modeOrLongest(perModel.map((p) => p.fields.executiveSummary).filter((s) => s.trim().length > 0)) || "";

  // ── Findings: cluster on `summary` (prose bar), resolve category by
  // majority/mode across the cluster (a loose grouping tag, not a
  // structural distinction to preserve — unlike causal_explanation's
  // categories), never infer evidenceStrength from coverage alone. ──
  let findingIndex = 0;
  const rawFindings: RawFindingEntry[] = perModel.flatMap(({ modelId, fields }) =>
    fields.findings.map((finding) => ({
      index: findingIndex++,
      modelId,
      modelHadSources: fields.sources.length > 0,
      finding,
    }))
  );

  const findingTextEntries = rawFindings.map((r) => ({ ...r, text: r.finding.summary }));
  const findingGroups = clusterByText(findingTextEntries, (a, b) => textsAreNearDuplicates(a, b, PROSE_DEDUP_THRESHOLDS));

  const disagreementRaw: RawTextEntry[] = [];
  let disagreementIndex = 0;
  for (const { modelId, fields } of perModel) {
    for (const text of fields.disagreements) disagreementRaw.push({ index: disagreementIndex++, modelId, text });
  }
  const disagreementGroups = clusterByText(disagreementRaw, (a, b) => textsAreNearDuplicates(a, b, PROSE_DEDUP_THRESHOLDS));
  const disagreementLabels = disagreementGroups.map((g) => modeOrLongest(g.map((e) => e.text)));

  function isContested(summary: string): boolean {
    return disagreementLabels.some((label) => textsAreNearDuplicates(label, summary, PROSE_DEDUP_THRESHOLDS));
  }

  interface Aggregated extends AggregatedResearchFinding {
    firstSeenIndex: number;
  }

  const aggregatedFindings: Aggregated[] = findingGroups.map((group) => {
    const title = modeOrLongest(group.map((e) => e.finding.title));
    const summary = modeOrLongest(group.map((e) => e.text));
    const category = modeOrLongest(group.map((e) => (e.finding.category?.trim() ? e.finding.category.trim() : "General")));
    const contributingModels = Array.from(new Set(group.map((e) => e.modelId)));
    const sourceBacked = group.some((e) => (e.finding.sources && e.finding.sources.length > 0) || e.modelHadSources);
    const modelAssertedStrengths = group.map((e) => e.finding.evidenceStrength).filter((s): s is CausalEvidenceStrength => !!s);
    // "contested" wins if the panel itself disputes this finding OR any
    // contributing model already called it contested; otherwise fall back
    // to "unknown" — never derive strong/moderate/weak from coverage alone.
    const evidenceStrength: CausalEvidenceStrength = isContested(summary) || modelAssertedStrengths.includes("contested")
      ? "contested"
      : "unknown";

    return {
      id: group[0].finding.id || summary.slice(0, 40),
      title,
      summary,
      category,
      evidenceStrength,
      sourceBacked,
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
  const findings = aggregatedFindings
    .filter((f) => !lowConfidenceThresholdApplies || f.coverageCount > LOW_CONFIDENCE_MAX_COVERAGE)
    .sort(sortByCoverageThenFirstSeen)
    .map(({ firstSeenIndex, ...rest }) => rest);
  const lowConfidenceFindings = aggregatedFindings
    .filter((f) => lowConfidenceThresholdApplies && f.coverageCount <= LOW_CONFIDENCE_MAX_COVERAGE)
    .sort(sortByCoverageThenFirstSeen)
    .map(({ firstSeenIndex, ...rest }) => rest);

  // ── Disagreements — NEVER filtered by coverage; a minority position is
  // exactly what this field exists to keep visible. ──
  const disagreements: AggregatedResearchDisagreement[] = disagreementGroups
    .map((group) => ({
      label: modeOrLongest(group.map((e) => e.text)),
      supportingModels: Array.from(new Set(group.map((e) => e.modelId))),
      firstSeenIndex: Math.min(...group.map((e) => e.index)),
    }))
    .sort((a, b) => b.supportingModels.length - a.supportingModels.length || a.firstSeenIndex - b.firstSeenIndex)
    .map(({ firstSeenIndex, ...rest }) => rest);

  const evidenceGaps = dedupeTextList(perModel.flatMap((p) => p.fields.evidenceGaps), { ...LIST_DEDUP_THRESHOLDS, cap: EVIDENCE_GAPS_CAP });
  const openQuestions = dedupeTextList(perModel.flatMap((p) => p.fields.openQuestions), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: OPEN_QUESTIONS_CAP,
  });
  const researchBoundaries = dedupeTextList(perModel.flatMap((p) => p.fields.researchBoundaries), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: RESEARCH_BOUNDARIES_CAP,
  });
  const recommendedNextSteps = dedupeTextList(perModel.flatMap((p) => p.fields.recommendedNextSteps), {
    ...LIST_DEDUP_THRESHOLDS,
    cap: NEXT_STEPS_CAP,
  });

  const allFindings = [...findings, ...lowConfidenceFindings];
  const findingsWithSources = allFindings.filter((f) => f.sourceBacked).length;
  const sourceCoverage = {
    findingsWithSources,
    totalFindings: allFindings.length,
    coverageRatio: allFindings.length > 0 ? findingsWithSources / allFindings.length : 0,
  };

  // Tier 2 of the existing Bias & Blind Spots system — a real model call,
  // reused as-is. Degrades to [] on any failure per that function's own
  // contract; never invented here.
  const panelBlindSpots = await auditPanelCoverage(
    question,
    DEEP_RESEARCH_SCHEMA_ID,
    allFindings.map((f) => f.summary)
  );

  return {
    executiveSummary,
    findings,
    lowConfidenceFindings,
    disagreements,
    evidenceGaps,
    openQuestions,
    panelBlindSpots,
    researchBoundaries,
    recommendedNextSteps,
    sourceCoverage,
    totalModels,
  };
}
