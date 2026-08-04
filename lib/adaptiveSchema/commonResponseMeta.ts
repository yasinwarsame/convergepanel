/**
 * Query-Routing Redesign, Phase 1 — the single shared CommonResponseMeta
 * builder for the 9 active Milestone 2 dedicated schemas, plus the
 * schema-aware source-coverage / human-review / limitation adapters it
 * calls. Exists so this logic is computed once, centrally, rather than
 * reimplemented independently inside nine alignment modules (the
 * non-negotiable rule this phase is built around).
 *
 * Deliberately narrow in scope: this module only reads already-computed
 * schema results (AggregatedX fields each alignment module already
 * produces) — it never re-derives evidence strength, coverage, or
 * disagreement from scratch. The central discipline threaded through every
 * adapter below: requiresHumanReview is never set from model agreement or
 * model count alone, and limitations are concrete, computed statements
 * about THIS result's own completeness — never generic boilerplate.
 */

import "server-only";
import { ModelId, ModelResult } from "@/lib/types";
import {
  AdaptiveModelResult,
  AdaptiveSourceCoverage,
  BiasBlindspotAuditResult,
  CausalExplanationResult,
  ChecklistTaxonomyResult,
  CommonResponseMeta,
  ComparisonMatrixResult,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  EvidenceReviewResult,
  QueryClassification,
  QueryType,
  RankedEnumerationResult,
  ResultSchema,
} from "./types";
import { PersistedAdaptiveSchemaId, SCHEMA_ANSWER_SHAPE } from "./persistedOutput";

/** The union of every schema-specific result shape this builder accepts — one per active Milestone 2 schema. */
export type AdaptiveSchemaResult =
  | RankedEnumerationResult
  | ComparisonMatrixResult
  | DefinitionExplanationResult
  | CausalExplanationResult
  | ChecklistTaxonomyResult
  | DeepResearchResult
  | EvidenceReviewResult
  | BiasBlindspotAuditResult
  | DecisionSupportResult;

// ─── Source coverage adapters ───────────────────────────────────────────

interface CoverageAccumulator {
  supportedUnits: number;
  totalUnits: number;
}

function ratioOf({ supportedUnits, totalUnits }: CoverageAccumulator): AdaptiveSourceCoverage | undefined {
  if (totalUnits === 0) return undefined;
  return { supportedUnits, totalUnits, ratio: supportedUnits / totalUnits };
}

/**
 * Schema-aware unit-level source coverage, using each schema's own real
 * answer units — never a fabricated item-level precision when the
 * underlying result only carries a response-level boolean. Returns
 * `sourceCoverage: undefined` in that case; callers must not zero-fill it.
 */
export function getAdaptiveSourceCoverage(
  schemaId: PersistedAdaptiveSchemaId,
  result: AdaptiveSchemaResult
): { sourceBacked: boolean; sourceCoverage?: AdaptiveSourceCoverage } {
  switch (schemaId) {
    case "ranked_enumeration": {
      const r = result as RankedEnumerationResult;
      const all = [...r.items, ...r.lowConfidenceItems];
      const supportedUnits = all.filter((i) => i.sources && i.sources.length > 0).length;
      const coverage = ratioOf({ supportedUnits, totalUnits: all.length });
      return { sourceBacked: supportedUnits > 0, sourceCoverage: coverage };
    }
    case "comparison_matrix": {
      const r = result as ComparisonMatrixResult;
      const supportedUnits = r.cells.filter((c) => c.sources && c.sources.length > 0).length;
      const coverage = ratioOf({ supportedUnits, totalUnits: r.cells.length });
      return { sourceBacked: supportedUnits > 0, sourceCoverage: coverage };
    }
    case "definition_explanation": {
      const r = result as DefinitionExplanationResult;
      const interpretations = [r.primary, ...r.alternateInterpretations].filter(
        (i): i is NonNullable<typeof i> => !!i
      );
      const supportedUnits = interpretations.filter((i) => i.sources.length > 0).length;
      const coverage = ratioOf({ supportedUnits, totalUnits: interpretations.length });
      return { sourceBacked: r.sourceBacked, sourceCoverage: coverage };
    }
    case "causal_explanation": {
      const r = result as CausalExplanationResult;
      // AggregatedCausalFactor.sourceBacked is itself an approximation (no
      // per-factor source list exists at the wire layer) — reused as-is,
      // not re-derived, since that's the one real signal this schema has.
      const supportedUnits = r.factors.filter((f) => f.sourceBacked).length;
      const coverage = ratioOf({ supportedUnits, totalUnits: r.factors.length });
      return { sourceBacked: r.sourceBacked, sourceCoverage: coverage };
    }
    case "checklist_taxonomy": {
      // No source signal exists at any level for this schema — the wire
      // contract never asked models to cite sources for checklist/taxonomy
      // items (see checklistTaxonomyFields). Honest false, not a guess.
      return { sourceBacked: false, sourceCoverage: undefined };
    }
    case "deep_research": {
      const r = result as DeepResearchResult;
      const all = [...r.findings, ...r.lowConfidenceFindings];
      const supportedUnits = all.filter((f) => f.sourceBacked).length;
      const coverage = ratioOf({ supportedUnits, totalUnits: all.length });
      return { sourceBacked: r.sourceCoverage.findingsWithSources > 0, sourceCoverage: coverage };
    }
    case "evidence_review": {
      const r = result as EvidenceReviewResult;
      // No per-dimension source list exists — only the response-level
      // sourceBacked boolean. Documented limitation, not fabricated precision.
      return { sourceBacked: r.sourceBacked, sourceCoverage: undefined };
    }
    case "bias_blindspot_audit": {
      const r = result as BiasBlindspotAuditResult;
      const { citationCoverage } = r.structuralDiagnostics;
      const coverage =
        citationCoverage.totalModels > 0
          ? { supportedUnits: citationCoverage.modelsWithSources, totalUnits: citationCoverage.totalModels, ratio: citationCoverage.ratio }
          : undefined;
      return { sourceBacked: citationCoverage.modelsWithSources > 0, sourceCoverage: coverage };
    }
    case "decision_support": {
      const r = result as DecisionSupportResult;
      // Assessments carry no per-cell source list (see decisionSupportAlignment.ts) —
      // only the response-level sourceBacked boolean.
      return { sourceBacked: r.sourceBacked, sourceCoverage: undefined };
    }
  }
}

// ─── Human-review adapters ───────────────────────────────────────────────

const HIGH_STAKES_RISK_LEVELS = new Set(["safety_critical", "high_stakes"]);

/**
 * requiresHumanReview is computed from real per-schema signals — never from
 * model agreement/count alone. Each schema's own already-computed fields
 * (evidenceStrength, isAmbiguous, humanReviewNeeded, etc.) are reused
 * directly where they exist, rather than re-derived.
 */
export function getAdaptiveHumanReviewSignals(
  schemaId: PersistedAdaptiveSchemaId,
  classification: QueryClassification,
  result: AdaptiveSchemaResult
): boolean {
  if (HIGH_STAKES_RISK_LEVELS.has(classification.riskLevel)) return true;

  switch (schemaId) {
    case "comparison_matrix": {
      const r = result as ComparisonMatrixResult;
      const totalSubjects = r.subjects.length + r.lowConfidenceSubjects.length;
      // Incomplete comparison data: more than half the subjects the panel
      // raised never reached full confidence.
      return totalSubjects > 0 && r.lowConfidenceSubjects.length / totalSubjects > 0.5;
    }
    case "definition_explanation":
      return (result as DefinitionExplanationResult).isAmbiguous;
    case "causal_explanation": {
      const r = result as CausalExplanationResult;
      return r.disputedInterpretations.length > 0 || r.factors.some((f) => f.evidenceStrength === "contested");
    }
    case "evidence_review": {
      const strength = (result as EvidenceReviewResult).overallStrength;
      return strength === "weak" || strength === "contested";
    }
    case "decision_support":
      // decision_support already computes this honestly (riskLevel,
      // contested recommendation, weak evidence on the recommended option)
      // — reused directly, never recomputed.
      return (result as DecisionSupportResult).humanReviewNeeded;
    case "ranked_enumeration":
    case "checklist_taxonomy":
    case "deep_research":
    case "bias_blindspot_audit":
      return false;
  }
}

// ─── Limitation adapters ─────────────────────────────────────────────────

/** Concrete, schema-specific statements about THIS result's own completeness/provenance — distinct from a schema's own self-reported uncertainties/caveats content. */
export function getAdaptiveLimitations(schemaId: PersistedAdaptiveSchemaId, result: AdaptiveSchemaResult): string[] {
  const limitations: string[] = [];

  switch (schemaId) {
    case "ranked_enumeration": {
      const r = result as RankedEnumerationResult;
      if (r.shortfallNote) limitations.push(r.shortfallNote);
      if (r.lowConfidenceItems.length > 0) {
        limitations.push(`${r.lowConfidenceItems.length} item${r.lowConfidenceItems.length === 1 ? " is" : "s are"} supported by only 1-2 models.`);
      }
      break;
    }
    case "comparison_matrix": {
      const r = result as ComparisonMatrixResult;
      const totalSubjects = r.subjects.length + r.lowConfidenceSubjects.length;
      const totalAttributes = r.attributes.length + r.lowConfidenceAttributes.length;
      const possibleCells = totalSubjects * totalAttributes;
      const missing = possibleCells - r.cells.length;
      if (possibleCells > 0 && missing > 0) {
        limitations.push(`${missing} comparison cell${missing === 1 ? " had" : "s had"} no supported value.`);
      }
      break;
    }
    case "definition_explanation": {
      const r = result as DefinitionExplanationResult;
      if (r.isAmbiguous) limitations.push("The term has multiple accepted interpretations.");
      break;
    }
    case "causal_explanation": {
      const r = result as CausalExplanationResult;
      if (r.disputedInterpretations.length > 0) {
        limitations.push("The causal picture includes interpretations models disagree on.");
      }
      if (r.unknowns.length > 0) {
        limitations.push(`${r.unknowns.length} aspect${r.unknowns.length === 1 ? "" : "s"} of the causal picture remain unknown.`);
      }
      break;
    }
    case "checklist_taxonomy": {
      const r = result as ChecklistTaxonomyResult;
      if (r.lowConfidenceItems.length > 0) {
        limitations.push(`${r.lowConfidenceItems.length} item${r.lowConfidenceItems.length === 1 ? " is" : "s are"} supported by only 1-2 models.`);
      }
      break;
    }
    case "deep_research": {
      const r = result as DeepResearchResult;
      if (r.evidenceGaps.length > 0) {
        limitations.push(`The research identified ${r.evidenceGaps.length} evidence gap${r.evidenceGaps.length === 1 ? "" : "s"}.`);
      }
      if (r.lowConfidenceFindings.length > 0) {
        limitations.push(`${r.lowConfidenceFindings.length} finding${r.lowConfidenceFindings.length === 1 ? " is" : "s are"} supported by only 1-2 models.`);
      }
      break;
    }
    case "evidence_review": {
      const r = result as EvidenceReviewResult;
      if (r.redFlags.length > 0) {
        limitations.push(`${r.redFlags.length} credibility red flag${r.redFlags.length === 1 ? "" : "s"} ${r.redFlags.length === 1 ? "was" : "were"} identified.`);
      }
      break;
    }
    case "bias_blindspot_audit": {
      const r = result as BiasBlindspotAuditResult;
      if (r.attributedBiases.length === 0 && r.biasEmptyReason) {
        limitations.push("No model-specific bias could be confidently attributed for this run.");
      }
      if (r.structuralDiagnostics.homogeneityFlag) {
        limitations.push("Panel agreement was unusually uniform, which is not independent verification.");
      }
      break;
    }
    case "decision_support": {
      const r = result as DecisionSupportResult;
      limitations.push(...r.recommendation.caveats);
      if (r.criteria.length > 0 && r.criteria.every((c) => c.source === "model")) {
        limitations.push("The recommendation depends on inferred rather than user-provided criteria.");
      }
      break;
    }
  }

  // Exact-string dedup — these are programmatically generated meta
  // statements, not model-authored free text, so fuzzy near-duplicate
  // merging (textSimilarity.ts's job elsewhere) isn't needed here.
  return Array.from(new Set(limitations));
}

// ─── The shared builder ──────────────────────────────────────────────────

export interface BuildCommonResponseMetaArgs {
  schema: ResultSchema;
  classification: QueryClassification;
  /** Raw connector results for every selected model — the honest totalModels/successfulModels/failedModels denominator. */
  modelResults: ModelResult[];
  /** Post-validation adaptive results — the modelsWithUsableOutput signal (connector success is not the same as usable adaptive output). */
  adaptiveResults: AdaptiveModelResult[];
  /** This schema's own finished, aggregated result. */
  schemaResult: AdaptiveSchemaResult;
}

/** The one shared builder every active Milestone 2 schema's finalizeAdaptiveRun branch calls — never reimplemented per-schema. */
export function buildCommonResponseMeta(args: BuildCommonResponseMetaArgs): CommonResponseMeta {
  const { schema, classification, modelResults, adaptiveResults, schemaResult } = args;
  const schemaId = schema.id as PersistedAdaptiveSchemaId;

  const totalModels = modelResults.length;
  const successfulModels = modelResults.filter((r) => r.status === "ok" || r.status === "substituted").length;
  const failedModels = totalModels - successfulModels;
  const modelsWithUsableOutput = adaptiveResults.filter((r) => r.ok && r.data).length;

  const executionStatus: CommonResponseMeta["executionStatus"] =
    modelsWithUsableOutput === 0 ? "failed" : successfulModels === totalModels && modelsWithUsableOutput === totalModels ? "completed" : "partial";

  const { sourceBacked, sourceCoverage } = getAdaptiveSourceCoverage(schemaId, schemaResult);
  const requiresHumanReview = getAdaptiveHumanReviewSignals(schemaId, classification, schemaResult);

  const limitations = getAdaptiveLimitations(schemaId, schemaResult);
  if (modelsWithUsableOutput < totalModels) {
    const missing = totalModels - modelsWithUsableOutput;
    limitations.unshift(
      `${missing} of ${totalModels} selected model${totalModels === 1 ? "" : "s"} did not produce usable structured output.`
    );
  }

  return {
    // Legacy CommonResponseMeta fields (unchanged shape/semantics from Milestone 1) —
    // populated with the closest honest equivalent available at this layer.
    schemaVersion: 1,
    queryType: classification.queryType,
    answerShape: SCHEMA_ANSWER_SHAPE[schemaId],
    dataBasis: "training_prior",
    freshness: classification.freshness,
    riskLevel: classification.riskLevel,
    evidenceQuality: "not_applicable",
    uncertainties: [],
    blindSpots: [],
    humanReviewNeeded: requiresHumanReview,
    generatedAt: new Date().toISOString(),

    // Phase 1 execution-metadata fields.
    schemaId: schema.id as QueryType,
    routingKind: "active",
    totalModels,
    successfulModels,
    failedModels,
    modelsWithUsableOutput,
    sourceBacked,
    sourceCoverage,
    limitations: Array.from(new Set(limitations)),
    executionStatus,
  };
}

/** Distinct models contributing across a set of adaptive results — a small shared helper several call sites need, not schema-specific. */
export function distinctContributingModels(adaptiveResults: AdaptiveModelResult[]): ModelId[] {
  return Array.from(new Set(adaptiveResults.filter((r) => r.ok).map((r) => r.modelId)));
}
