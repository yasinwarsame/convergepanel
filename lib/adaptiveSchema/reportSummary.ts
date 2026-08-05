/**
 * Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
 * §4.1) — the top summary bar's "Report type", "Consensus", and "Source
 * grounding" fields. Client-safe (no "server-only").
 *
 * Every derivation here reads an ALREADY-COMPUTED signal — never a new
 * alignment/scoring pass. Two families exist, matching §1/§2 of the design
 * doc:
 *   - The 9 Milestone-2 schemas (comparison_matrix, checklist_taxonomy,
 *     decision_support, causal_explanation, definition_explanation,
 *     ranked_enumeration, deep_research, evidence_review,
 *     bias_blindspot_audit) each have their own per-schema aggregate signal
 *     (cell agreement, coverageRatio, recommendation support, etc.), read
 *     directly from that schema's own result type.
 *   - The 8 original schemas plus factual_lookup use `gate.status`
 *     (pass/caution/fail, from the claim-alignment/certainty pipeline) for
 *     consensus and `trustSummary.overallTrust` for source grounding — the
 *     only two schema-agnostic scalars that pipeline computes.
 * `graceful_limitation` never reaches this module (see the design doc's §1
 * finding — it's short-circuited to LimitationNotice before any renderer
 * runs, so it has no report to summarize).
 */

import {
  AdaptiveGateResult,
  AdaptiveTrustSummary,
  BiasBlindspotAuditResult,
  CausalExplanationResult,
  ChecklistTaxonomyResult,
  CommonResponseMeta,
  ComparisonMatrixResult,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  EvidenceReviewResult,
  QueryType,
  RankedEnumerationResult,
} from "./types";
import { isRiskShapedChecklistResult } from "./types";

// ─── Report type label ──────────────────────────────────────────────────

const REPORT_TYPE_LABELS: Partial<Record<QueryType, string>> = {
  ranked_enumeration: "Ranked List",
  comparison_matrix: "Comparison Report",
  definition_explanation: "Definition",
  causal_explanation: "Causal Explanation",
  checklist_taxonomy: "Checklist",
  deep_research: "Research Brief",
  evidence_review: "Evidence Review",
  bias_blindspot_audit: "Bias & Blind Spot Audit",
  decision_support: "Recommendation Memo",
  factual_lookup: "Direct Answer",
  contested_empirical: "Consensus Analysis",
  legal_regulatory: "Regulatory Analysis",
  financial_valuation: "Financial Analysis",
  procedural: "Step-by-Step Guide",
  medical_health: "Medical Evidence Review",
  forecast_speculative: "Trend Analysis",
  creative_generative: "Creative Output",
  generic: "Research Summary",
};

/**
 * `checklistTaxonomy` risk-shape detection reuses `isRiskShapedChecklistResult()`
 * verbatim (types.ts) — the exact same data-driven check that already picks
 * `RiskAnalysisView` over `ChecklistTaxonomyView` — never a second,
 * independently-drifting classification of the same result.
 *
 * `causal_explanation` intentionally stays "Causal Explanation" rather than
 * "Diagnostic Report" here — the design doc's §5.2 called for a
 * diagnostic-specific relabel "when domain suggests diagnosis," but unlike
 * checklist_taxonomy's severity/likelihood fields, CausalExplanationResult
 * has no equivalent data signal to detect that distinction from. Left as a
 * disclosed gap rather than an unfounded per-run guess — see this
 * function's own module doc.
 */
export function getReportTypeLabel(schemaId: QueryType, checklistTaxonomy?: ChecklistTaxonomyResult): string {
  if (schemaId === "checklist_taxonomy" && checklistTaxonomy && isRiskShapedChecklistResult(checklistTaxonomy)) {
    return "Risk Analysis";
  }
  return REPORT_TYPE_LABELS[schemaId] ?? "Research Report";
}

// ─── Consensus level ─────────────────────────────────────────────────────

export type ConsensusLevel = "strong" | "moderate" | "weak" | "split" | "unscored";

export const CONSENSUS_LABELS: Record<ConsensusLevel, string> = {
  strong: "Strong consensus",
  moderate: "Moderate consensus",
  weak: "Weak consensus",
  split: "Split",
  unscored: "Not scored",
};

function tierFromRatio(ratio: number, strongMin: number, moderateMin: number): "strong" | "moderate" | "weak" {
  if (ratio >= strongMin) return "strong";
  if (ratio >= moderateMin) return "moderate";
  return "weak";
}

export interface ConsensusInput {
  schemaId: QueryType;
  gate?: AdaptiveGateResult;
  comparisonMatrix?: ComparisonMatrixResult;
  checklistTaxonomy?: ChecklistTaxonomyResult;
  decisionSupport?: DecisionSupportResult;
  causalExplanation?: CausalExplanationResult;
  definitionExplanation?: DefinitionExplanationResult;
  rankedEnumeration?: RankedEnumerationResult;
  deepResearch?: DeepResearchResult;
  evidenceReview?: EvidenceReviewResult;
  biasBlindspotAudit?: BiasBlindspotAuditResult;
}

export function deriveConsensusLevel(input: ConsensusInput): ConsensusLevel {
  const { comparisonMatrix, checklistTaxonomy, decisionSupport, causalExplanation, definitionExplanation, rankedEnumeration, deepResearch, evidenceReview, biasBlindspotAudit, gate } = input;

  if (comparisonMatrix) {
    const agreeing = comparisonMatrix.cells.filter((c) => c.agreement === "consensus" || c.agreement === "majority").length;
    const total = comparisonMatrix.cells.length;
    return total === 0 ? "unscored" : tierFromRatio(agreeing / total, 0.75, 0.5);
  }

  if (checklistTaxonomy) {
    const items = checklistTaxonomy.categories.flatMap((c) => c.items);
    if (items.length === 0) return "unscored";
    const avgCoverage = items.reduce((sum, i) => sum + i.coverageRatio, 0) / items.length;
    return tierFromRatio(avgCoverage, 0.75, 0.5);
  }

  if (decisionSupport) {
    if (decisionSupport.recommendation.totalModelsWithRecommendation === 0) return "unscored";
    if (decisionSupport.recommendation.isContested) return "split";
    return tierFromRatio(
      decisionSupport.recommendation.supportCount / decisionSupport.recommendation.totalModelsWithRecommendation,
      0.75,
      0.5
    );
  }

  if (causalExplanation) {
    if (causalExplanation.factors.length === 0) return "unscored";
    const disputeRatio = causalExplanation.disputedInterpretations.length / causalExplanation.factors.length;
    return disputeRatio === 0 ? "strong" : disputeRatio < 0.25 ? "moderate" : disputeRatio < 0.5 ? "weak" : "split";
  }

  if (definitionExplanation) {
    if (!definitionExplanation.primary) return "unscored";
    return definitionExplanation.isAmbiguous ? "split" : "strong";
  }

  if (rankedEnumeration) {
    if (rankedEnumeration.rankCorrelation == null) return "unscored";
    return tierFromRatio(rankedEnumeration.rankCorrelation, 0.7, 0.4);
  }

  if (deepResearch) {
    if (deepResearch.findings.length === 0) return "unscored";
    const disputeRatio = deepResearch.disagreements.length / deepResearch.findings.length;
    return disputeRatio === 0 ? "strong" : disputeRatio < 0.25 ? "moderate" : disputeRatio < 0.5 ? "weak" : "split";
  }

  if (evidenceReview) {
    switch (evidenceReview.overallStrength) {
      case "strong":
        return "strong";
      case "moderate":
        return "moderate";
      case "weak":
        return "weak";
      case "contested":
        return "split";
      default:
        return "unscored";
    }
  }

  if (biasBlindspotAudit) {
    if (biasBlindspotAudit.biasEmptyReason) return "unscored";
    if (biasBlindspotAudit.structuralDiagnostics.homogeneityFlag) return "strong";
    return biasBlindspotAudit.attributedBiases.length === 0 ? "moderate" : "weak";
  }

  // Original-9 / factual_lookup family — the only schema-agnostic signal
  // this pipeline computes for them.
  if (gate) {
    return gate.status === "pass" ? "strong" : gate.status === "caution" ? "moderate" : "weak";
  }

  return "unscored";
}

// ─── Total models (history-reload fallback) ──────────────────────────────

/**
 * Live runs pass a populated `results: AdaptiveModelResult[]` (TopSummaryBar
 * derives Models from `results.length`/`.filter(ok)`). History reload's
 * `adaptPersistedOutputToPanelPayload()` deliberately passes `results: []`
 * (see that adapter's own module doc — no per-model raw data is persisted,
 * it's redundant with runDocument.perModel) for all 9 Milestone-2 schemas.
 * Every one of those 9 result types independently carries its own
 * `totalModels: number` (models that contributed to that schema's
 * aggregation) — reusing it here is the only way to show a non-zero, honest
 * Models count on reload. Deliberately rendered as "N models", not "N of
 * N" — the ok/fail split isn't preserved in the envelope, only the total,
 * and "N of N" would fabricate a 100%-success claim the data doesn't back.
 */
export interface TotalModelsFallbackInput {
  comparisonMatrix?: ComparisonMatrixResult;
  checklistTaxonomy?: ChecklistTaxonomyResult;
  decisionSupport?: DecisionSupportResult;
  causalExplanation?: CausalExplanationResult;
  definitionExplanation?: DefinitionExplanationResult;
  rankedEnumeration?: RankedEnumerationResult;
  deepResearch?: DeepResearchResult;
  evidenceReview?: EvidenceReviewResult;
  biasBlindspotAudit?: BiasBlindspotAuditResult;
}

export function deriveTotalModelsFromSchemaResult(input: TotalModelsFallbackInput): number | null {
  return (
    input.comparisonMatrix?.totalModels ??
    input.checklistTaxonomy?.totalModels ??
    input.decisionSupport?.totalModels ??
    input.causalExplanation?.totalModels ??
    input.definitionExplanation?.totalModels ??
    input.rankedEnumeration?.totalModels ??
    input.deepResearch?.totalModels ??
    input.evidenceReview?.totalModels ??
    input.biasBlindspotAudit?.totalModels ??
    null
  );
}

// ─── Source grounding level ──────────────────────────────────────────────

export type SourceGroundingLevel = "strong" | "moderate" | "weak" | "unscored";

export const SOURCE_GROUNDING_LABELS: Record<SourceGroundingLevel, string> = {
  strong: "Strong",
  moderate: "Moderate",
  weak: "Weak",
  unscored: "Not scored",
};

export interface SourceGroundingInput {
  /** PersistedAdaptiveOutputV1.meta — present for the 9 Milestone-2 schemas on both live and reload (same envelope either way), absent for the original-9/factual_lookup family (buildCommonResponseMeta only runs for Milestone-2 schemas). */
  meta?: CommonResponseMeta;
  /** Original-9/factual_lookup family's only schema-agnostic grounding signal — trust score already factors in citation presence (TRUST_WEIGHTS_BY_SCHEMA). */
  trustSummary?: AdaptiveTrustSummary;
}

export function deriveSourceGrounding(input: SourceGroundingInput): SourceGroundingLevel {
  if (input.meta?.sourceCoverage) {
    return tierFromRatio(input.meta.sourceCoverage.ratio, 0.7, 0.35);
  }
  if (input.meta) {
    // Milestone-2 schema with no per-unit source tracking (checklist_taxonomy,
    // evidence_review, decision_support — see commonResponseMeta.ts's own
    // "no fabricated unit-level ratio" fallback) — the response-level
    // boolean is all that exists; not enough to tier, but not "unscored"
    // either (a bare presence/absence, shown at moderate confidence).
    return input.meta.sourceBacked ? "moderate" : "weak";
  }
  if (input.trustSummary) {
    return tierFromRatio(input.trustSummary.overallTrust, 0.6, 0.35);
  }
  return "unscored";
}
