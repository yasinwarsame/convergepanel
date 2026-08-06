"use client";

/**
 * Adaptive Panel Response — three-tab shell (R4).
 *
 * Restores List / Compare / Synthesis Report for adaptive runs, but ONLY
 * when the server computed gate + synthesisReport (ADAPTIVE_VERIFICATION_ENABLED
 * was on for this run). When it's off, this renders exactly the pre-restoration
 * bare AdaptiveResultsView — no behavior change for anyone not opted into the
 * verification engine yet.
 *
 * Compare View is additive: schemas whose renderer already embeds a
 * ClaimMatrix (consensus_map/rule_application/evidence_tiers/generic_sections)
 * are left as-is — the SAME scored `alignedClaims` prop now flows through to
 * that existing matrix. Schemas whose renderer has no claims matrix at all
 * (metrics_grid/verdict_card/step_diff/scenario_tree — their comparable
 * content is metrics/answer/steps/scenarios, not claim[] fields) get the
 * merged matrix rendered as an ADDITIONAL block below, since otherwise their
 * cross-model agreement scoring (R2's tolerance-band/probability-band/
 * order-sensitive comparators) would have no visible surface at all.
 */

import { AnswerShape, BiasBlindspotAuditResult, CausalExplanationResult, ChecklistTaxonomyResult, CommonResponseMeta, ComparisonMatrixResult, DecisionSupportResult, DeepResearchResult, DefinitionExplanationResult, EvidenceReviewResult, QueryType, RankedEnumerationResult, isRiskShapedChecklistResult } from "@/lib/adaptiveSchema/types";
import { AdaptiveGateResult, AdaptiveSynthesisReport, AdaptiveTrustSummary } from "@/lib/adaptiveSchema/types";
import { ReportStatusInput } from "@/lib/adaptiveSchema/reportStatus";
import { AdaptiveRendererProps } from "./types";
import TopSummaryBar from "./TopSummaryBar";
import AdaptiveResultsView from "./AdaptiveResultsView";
import AdaptiveSynthesisReportView from "./AdaptiveSynthesisReportView";
import ClaimMatrix from "./ClaimMatrix";
import ListView from "./ListView";
import DirectAnswerCard from "./DirectAnswerCard";
import LimitationNotice from "./LimitationNotice";
import RankedListView from "./RankedListView";
import ComparisonMatrixView from "./ComparisonMatrixView";
import DefinitionExplanationView from "./DefinitionExplanationView";
import CausalExplanationView from "./CausalExplanationView";
import ChecklistTaxonomyView from "./ChecklistTaxonomyView";
import RiskAnalysisView from "./RiskAnalysisView";
import DeepResearchView from "./DeepResearchView";
import EvidenceReviewView from "./EvidenceReviewView";
import BiasBlindspotAuditView from "./BiasBlindspotAuditView";
import DecisionSupportView from "./DecisionSupportView";
import ModelResponsesSection from "./ModelResponsesSection";
import PanelEvidenceSection from "./PanelEvidenceSection";
import ReviewGovernanceSection from "./ReviewGovernanceSection";
import PrimarySynthesisStrip from "./PrimarySynthesisStrip";
import { Card, SectionLabel } from "./shared";
import PanelViewTabs, { PanelViewMode } from "./PanelViewTabs";
import { routeClassifiedQuery } from "@/lib/adaptiveSchema/routeClassifiedQuery";
import { useEffect, useState } from "react";

const RENDER_HINTS_WITHOUT_MATRIX = new Set<AnswerShape>(["metrics_grid", "verdict_card", "step_diff", "scenario_tree"]);

/** Adaptive Synthesis Report, Phase 2 — 3-schema pilot (see AdaptivePanelResponse's own comment at the branch below). Deliberately not all 18 schemas yet. */
const PHASE2_PILOT_SCHEMAS = new Set<QueryType>(["procedural", "generic"]);

export interface AdaptivePanelResponseProps extends AdaptiveRendererProps {
  gate?: AdaptiveGateResult;
  synthesisReport?: AdaptiveSynthesisReport;
  trustSummary?: AdaptiveTrustSummary;
  /** Present only for schema.renderHint === "ranked_list" (Milestone 2). */
  rankedEnumeration?: RankedEnumerationResult;
  /** Present only for schema.renderHint === "comparison_grid" (Milestone 2). */
  comparisonMatrix?: ComparisonMatrixResult;
  /** Present only for schema.renderHint === "definition_card" (Milestone 2). */
  definitionExplanation?: DefinitionExplanationResult;
  /** Present only for schema.renderHint === "causal_map" (Milestone 2). */
  causalExplanation?: CausalExplanationResult;
  /** Present only for schema.renderHint === "checklist_taxonomy_view" (Milestone 2). */
  checklistTaxonomy?: ChecklistTaxonomyResult;
  /** Present only for schema.renderHint === "deep_research_view" (Milestone 2). */
  deepResearch?: DeepResearchResult;
  /** Present only for schema.renderHint === "evidence_review_view" (Milestone 2). */
  evidenceReview?: EvidenceReviewResult;
  /** Present only for schema.renderHint === "bias_blindspot_audit_view" (Milestone 2). */
  biasBlindspotAudit?: BiasBlindspotAuditResult;
  /** Present only for schema.renderHint === "decision_support_view" (Milestone 2). */
  decisionSupport?: DecisionSupportResult;
  question: string;
  runId?: string | null;
  /** Threaded down to the Synthesis Report's Bias & Blind Spots Tier 2 cards' "Run follow-up" action. */
  onRunFollowUp?: (question: string) => void;

  // ── Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
  // §4.1) — the top summary bar's own inputs. All optional so this component
  // still renders (with an "Incomplete"/"Not scored" degrade) for any caller
  // that hasn't threaded them through yet.
  generatedAt?: string;
  persistenceStatus?: ReportStatusInput["persistenceStatus"];
  humanReview?: ReportStatusInput["humanReview"];
  reviewRouting?: ReportStatusInput["reviewRouting"];
  /** PersistedAdaptiveOutputV1.meta — present for the 9 Milestone-2 schemas only (see reportSummary.ts). */
  meta?: CommonResponseMeta;
}

export default function AdaptivePanelResponse(props: AdaptivePanelResponseProps) {
  const {
    schema,
    classification,
    results,
    alignedClaims,
    gate,
    synthesisReport,
    trustSummary,
    rankedEnumeration,
    comparisonMatrix,
    definitionExplanation,
    causalExplanation,
    checklistTaxonomy,
    deepResearch,
    evidenceReview,
    biasBlindspotAudit,
    decisionSupport,
    question,
    runId,
    onRunFollowUp,
  } = props;
  const [viewMode, setViewMode] = useState<PanelViewMode>("list");
  const [pendingScrollSection, setPendingScrollSection] = useState<string | null>(null);

  // List View's Panel Pulse cards jump into the Synthesis Report at a
  // specific section — switch tabs, then scroll once that tab has mounted.
  useEffect(() => {
    if (viewMode !== "synthesis" || !pendingScrollSection) return;
    const el = document.querySelector(`[data-section="${pendingScrollSection}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingScrollSection(null);
  }, [viewMode, pendingScrollSection]);

  // Query-routing redesign, Milestone 1/1.5 — the routing guarantee. Must
  // run BEFORE any other branch below: a classification that isn't
  // "active" (disabled, handoff, clarification, unanswerable, or
  // unrecognized) may never reach GenericSectionsView,
  // AdaptiveSynthesisReportView, ClaimMatrix, or any other schema-specific
  // renderer — only LimitationNotice. Same routeClassifiedQuery() call the
  // server used (via planAdaptiveRun) to decide whether to run the panel
  // at all — client and server can never diverge since it's one function.
  const routing = routeClassifiedQuery(classification);
  if (routing.kind !== "active") {
    return <LimitationNotice limitation={routing.response} />;
  }

  // Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
  // §4.1/§4.2) — rendered above EVERY schema-specific report below, uniformly,
  // via the shared `withBar()` wrapper rather than duplicated per branch.
  // Deliberately after the routing guard above: a classification that never
  // reaches an active schema has no report to summarize.
  const summaryBar = (
    <TopSummaryBar
      schemaId={schema.id}
      results={results}
      generatedAt={props.generatedAt}
      persistenceStatus={props.persistenceStatus}
      humanReview={props.humanReview}
      reviewRouting={props.reviewRouting}
      gate={gate}
      trustSummary={trustSummary}
      meta={props.meta}
      comparisonMatrix={comparisonMatrix}
      checklistTaxonomy={checklistTaxonomy}
      decisionSupport={decisionSupport}
      causalExplanation={causalExplanation}
      definitionExplanation={definitionExplanation}
      rankedEnumeration={rankedEnumeration}
      deepResearch={deepResearch}
      evidenceReview={evidenceReview}
      biasBlindspotAudit={biasBlindspotAudit}
    />
  );
  const withBar = (body: React.ReactNode) => (
    <div className="space-y-4">
      {summaryBar}
      {body}
    </div>
  );

  // factual_lookup (Milestone 1): lightweight single card, not the full
  // synthesis-report shell. Fields/prompt/parser/verification are
  // unchanged — only this rendering choice differs from every other active
  // schema below.
  if (schema.renderHint === "direct_answer") {
    return withBar(<DirectAnswerCard results={results} alignedClaims={alignedClaims} gate={gate} />);
  }

  // ranked_enumeration (Milestone 2): its own standalone view — coverage/
  // rank/rank-correlation, not the claims-matrix/synthesis-report shell.
  // rankedEnumeration should always be present here (orchestrate.ts always
  // computes it for this schema), but fail safe to the generic view rather
  // than crash if it's ever missing.
  if (schema.renderHint === "ranked_list") {
    if (rankedEnumeration) {
      return withBar(<RankedListView rankedEnumeration={rankedEnumeration} />);
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // comparison_matrix (Milestone 2): its own standalone view — a two-axis
  // (subject, attribute) grid, not the claims-matrix/synthesis-report shell.
  // comparisonMatrix should always be present here (orchestrate.ts always
  // computes it for this schema), but fail safe to the generic view rather
  // than crash if it's ever missing.
  //
  // Adaptive Synthesis Report, Phase 2 (3-schema pilot) — Model Responses/
  // Panel Evidence/Review & Governance render below the primary view, never
  // replacing it. This is the pilot's one Milestone-2 schema.
  if (schema.renderHint === "comparison_grid") {
    if (comparisonMatrix) {
      return withBar(
        <div className="space-y-4">
          <ComparisonMatrixView comparisonMatrix={comparisonMatrix} />
          <ModelResponsesSection schema={schema} results={results} />
          <PanelEvidenceSection schemaId={schema.id} comparisonMatrix={comparisonMatrix} modelsUsed={results.map((r) => r.modelId)} />
          <ReviewGovernanceSection
            humanReview={props.humanReview}
            reviewRouting={props.reviewRouting}
            persistenceStatus={props.persistenceStatus}
            runId={runId}
          />
        </div>
      );
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // definition_explanation (Milestone 2): its own standalone, answer-first
  // view — no Trust Summary/Agreement Map/Panel Verdict, since this schema
  // never computes a claim-agreement score. definitionExplanation should
  // always be present here (orchestrate.ts always computes it for this
  // schema), but fail safe to the generic view rather than crash if it's
  // ever missing.
  if (schema.renderHint === "definition_card") {
    if (definitionExplanation) {
      return withBar(<DefinitionExplanationView definitionExplanation={definitionExplanation} />);
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // causal_explanation (Milestone 2): its own standalone view — coverage
  // badges say "N of M models agree", never a certainty/confidence score,
  // since panel convergence is never proof of causality. No Trust Summary/
  // Agreement Map/Panel Verdict/claim matrix. causalExplanation should
  // always be present here (orchestrate.ts always computes it for this
  // schema), but fail safe to the generic view rather than crash if it's
  // ever missing.
  if (schema.renderHint === "causal_map") {
    if (causalExplanation) {
      return withBar(<CausalExplanationView causalExplanation={causalExplanation} riskLevel={classification.riskLevel} />);
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // checklist_taxonomy (Milestone 2): its own standalone view — a flat
  // checklist or a categorized taxonomy depending on what the panel
  // actually produced, never a claims matrix. checklistTaxonomy should
  // always be present here (orchestrate.ts always computes it for this
  // schema), but fail safe to the generic view rather than crash if it's
  // ever missing.
  if (schema.renderHint === "checklist_taxonomy_view") {
    if (checklistTaxonomy) {
      // A checklist_taxonomy result whose items are genuinely risks (severity/
      // likelihood/mitigation/etc. populated) renders as a risk register
      // instead of a bare checklist — see isRiskShapedChecklistResult's doc
      // comment for why this stays checklist_taxonomy rather than a new schema.
      return withBar(
        isRiskShapedChecklistResult(checklistTaxonomy) ? (
          <RiskAnalysisView checklistTaxonomy={checklistTaxonomy} />
        ) : (
          <ChecklistTaxonomyView checklistTaxonomy={checklistTaxonomy} />
        )
      );
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // deep_research (Milestone 2): its own standalone view — grouped
  // findings, a separate disagreements section, source coverage, and
  // expandable panel blind spots, never a claims matrix or a single
  // certainty score. deepResearch should always be present here
  // (orchestrate.ts always computes it for this schema), but fail safe to
  // the generic view rather than crash if it's ever missing.
  if (schema.renderHint === "deep_research_view") {
    if (deepResearch) {
      return withBar(<DeepResearchView deepResearch={deepResearch} />);
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // evidence_review (Milestone 2): its own standalone view — dimension
  // breakdown, red flags/strengths, never a claims matrix or a single
  // certainty score. evidenceReview should always be present here
  // (orchestrate.ts always computes it for this schema), but fail safe to
  // the generic view rather than crash if it's ever missing.
  if (schema.renderHint === "evidence_review_view") {
    if (evidenceReview) {
      return withBar(<EvidenceReviewView evidenceReview={evidenceReview} riskLevel={classification.riskLevel} />);
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // bias_blindspot_audit (Milestone 2): its own standalone, three-tier
  // view — never a claims matrix, Panel Verdict Card, or a "bias score".
  // biasBlindspotAudit should always be present here (orchestrate.ts
  // always computes it for this schema), but fail safe to the generic view
  // rather than crash if it's ever missing.
  if (schema.renderHint === "bias_blindspot_audit_view") {
    if (biasBlindspotAudit) {
      return withBar(<BiasBlindspotAuditView biasBlindspotAudit={biasBlindspotAudit} onRunFollowUp={onRunFollowUp} />);
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  // decision_support (Milestone 2): its own standalone, recommendation-first
  // view — never a claims matrix, Panel Verdict Card, or a numeric
  // decision-certainty score. decisionSupport should always be present here
  // (orchestrate.ts always computes it for this schema), but fail safe to
  // the generic view rather than crash if it's ever missing.
  if (schema.renderHint === "decision_support_view") {
    if (decisionSupport) {
      return withBar(<DecisionSupportView decisionSupport={decisionSupport} />);
    }
    return withBar(<AdaptiveResultsView {...props} />);
  }

  if (!gate || !synthesisReport) {
    return withBar(<AdaptiveResultsView {...props} />);
  }

  const modelIds = results.map((r) => r.modelId);

  // Adaptive Synthesis Report, Phase 2 — 3-schema pilot. procedural and
  // generic get a progressive-disclosure layout: PrimarySynthesisStrip
  // (the answer-first headline — unifiedAnswer plus the single top
  // consensus/disagreement point, so a reader can answer "what's the
  // answer / how confident / what do models agree-disagree on" without
  // expanding anything) + the schema's own primary view
  // (StepDiffView/GenericSectionsView, unchanged) together make up the
  // primary report — then Model Responses/Panel Evidence/Review &
  // Governance, each its OWN collapsed section (never expanded by
  // default — "never hidden behind tabs" does not mean "show everything
  // at once"), hold the full record behind that headline. Explicit,
  // self-documenting allowlist — trivially reversible, and provably scoped
  // to exactly these 2 schemas; the other 6 original schemas
  // (contested_empirical/legal_regulatory/financial_valuation/
  // medical_health/forecast_speculative/creative_generative) fall through
  // to the unchanged tri-tab shell below. Broader rollout to the remaining
  // 15 schemas is deliberately deferred to a follow-up pass — see
  // docs/adaptive-synthesis-report-design.md.
  if (PHASE2_PILOT_SCHEMAS.has(schema.id)) {
    return withBar(
      <div className="space-y-4">
        <PrimarySynthesisStrip synthesisReport={synthesisReport} />
        <AdaptiveResultsView {...props} />
        <ModelResponsesSection
          schema={schema}
          results={results}
          listView={{ alignedClaims, gate, synthesisReport, trustSummary }}
        />
        <PanelEvidenceSection
          schemaId={schema.id}
          gate={gate}
          synthesisReport={synthesisReport}
          trustSummary={trustSummary}
          alignedClaims={alignedClaims}
          modelsUsed={modelIds}
          showClaimMatrix={schema.renderHint === "step_diff"}
        />
        <ReviewGovernanceSection
          humanReview={props.humanReview}
          reviewRouting={props.reviewRouting}
          persistenceStatus={props.persistenceStatus}
          runId={runId}
          gate={gate}
          synthesisReport={synthesisReport}
          trustSummary={trustSummary}
          alignedClaims={alignedClaims}
          modelsUsed={modelIds}
          question={question}
          onRunFollowUp={onRunFollowUp}
        />
      </div>
    );
  }
  const showExtraMatrix = RENDER_HINTS_WITHOUT_MATRIX.has(schema.renderHint) && !!alignedClaims && alignedClaims.length > 0;

  const navigateToSynthesisSection = (sectionId: string) => {
    setPendingScrollSection(sectionId);
    setViewMode("synthesis");
  };

  return (
    <div className="space-y-4">
      {summaryBar}
      <PanelViewTabs viewMode={viewMode} onChange={setViewMode} />

      {viewMode === "list" && (
        <ListView
          schema={schema}
          results={results}
          alignedClaims={alignedClaims}
          gate={gate}
          synthesisReport={synthesisReport}
          trustSummary={trustSummary}
          onNavigateToSynthesis={navigateToSynthesisSection}
        />
      )}

      {viewMode === "compare" && (
        <div className="space-y-4">
          <AdaptiveResultsView {...props} />
          {showExtraMatrix && (
            <Card>
              <SectionLabel>Cross-model comparison</SectionLabel>
              <ClaimMatrix claims={alignedClaims!} modelIds={modelIds} />
            </Card>
          )}
        </div>
      )}

      {viewMode === "synthesis" && (
        <AdaptiveSynthesisReportView
          report={synthesisReport}
          gate={gate}
          alignedClaims={alignedClaims}
          trustSummary={trustSummary}
          question={question}
          modelsUsed={modelIds}
          runId={runId}
          onRunFollowUp={onRunFollowUp}
        />
      )}
    </div>
  );
}
