"use client";

/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot + Phase 2A rollout) —
 * the "Panel Evidence" section: the FULL evidentiary record (consensus,
 * disagreement, sources, uncertainty, claim severity, model coverage),
 * collapsed by default. The primary view + PrimarySynthesisStrip already
 * surface the single highest-priority consensus/disagreement point — this
 * section is the complete record behind that headline, not a repeat of it.
 * Self-wraps in one <details> so callers never need extra wrapping logic.
 *
 * Branches on schemaId, one branch per schema family, so later rollout is
 * additive branches here, not a rewrite:
 *
 * - comparison_matrix: entirely new content — this schema never computes
 *   gate/trustSummary/claims, so there is no synthesis-report data to
 *   relocate. Built fresh from ComparisonMatrixResult.cells (the same data
 *   TopSummaryBar's Consensus badge already collapses into one number,
 *   disaggregated here into a real tally + a disagreement list + a source
 *   list). Deliberately excludes directConclusion/uncertainties/tradeoffs/
 *   bestUseRecommendations — ComparisonMatrixView already shows those.
 *
 * - procedural/generic (any schema still on gate+synthesisReport): reuses
 *   4 of AdaptiveSynthesisReportView's exported functions verbatim.
 *   UnifiedAnswerCard and PanelVerdictCard are DELIBERATELY NOT rendered
 *   here — the former now lives in PrimarySynthesisStrip (primary report),
 *   the latter moved to ReviewGovernanceSection (verdict is a governance
 *   artifact, not raw evidence) — rendering either here would duplicate
 *   information already shown elsewhere, which the design explicitly rules
 *   out.
 *
 * - Phase 2A batch 1 (deep_research/decision_support/causal_explanation/
 *   definition_explanation): each of these 4 Milestone-2 renderers is
 *   already unusually thorough in its own primary view (findings,
 *   disputes, uncertainties, and a full options×criteria matrix for
 *   decision_support are ALL already primary content — confirmed by
 *   reading each view before writing this) — so unlike comparison_matrix,
 *   there is genuinely little "hidden" evidence left to relocate here
 *   without duplicating the primary report. Each branch below is
 *   deliberately modest: an aggregated coverage/evidence-strength TALLY
 *   (the one view these renderers never compute — they show per-item
 *   badges, never a rolled-up count) built from the exact same
 *   coverageCount/totalModels/evidenceStrength fields the primary view
 *   already reads (never a new scoring pass), plus whichever specific
 *   sub-list a primary view only summarizes by count rather than listing
 *   in full (deep_research's lowConfidenceFindings) or scatters instead of
 *   consolidating (definition_explanation's per-interpretation sources).
 */

import { ModelId } from "@/lib/types";
import {
  AdaptiveGateResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  CausalExplanationResult,
  ComparisonMatrixResult,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  QueryType,
} from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel, TintBadge, BadgeTone } from "./shared";
import ClaimMatrix from "./ClaimMatrix";
import { TrustSummaryTable, AgreementDisagreementMap, SingleModelInsightsList, DisagreementsSection } from "./AdaptiveSynthesisReportView";

export interface PanelEvidenceSectionProps {
  schemaId: QueryType;
  // gate/synthesisReport-driven family (procedural/generic this pilot):
  gate?: AdaptiveGateResult;
  synthesisReport?: AdaptiveSynthesisReport;
  trustSummary?: AdaptiveTrustSummary;
  alignedClaims?: AlignedClaim[];
  modelsUsed: ModelId[];
  /** true only for procedural (step_diff) this pilot — relocates the ClaimMatrix block that used to live under the Compare tab. */
  showClaimMatrix?: boolean;
  // comparison_matrix's own family:
  comparisonMatrix?: ComparisonMatrixResult;
  // Phase 2A batch 1 — each present only for its own schemaId:
  deepResearch?: DeepResearchResult;
  decisionSupport?: DecisionSupportResult;
  causalExplanation?: CausalExplanationResult;
  definitionExplanation?: DefinitionExplanationResult;
}

const AGREEMENT_TALLY_LABEL: Record<"consensus" | "majority" | "split" | "single_source", string> = {
  consensus: "Consensus",
  majority: "Majority",
  split: "Split",
  single_source: "Single source",
};

const AGREEMENT_TALLY_TONE: Record<"consensus" | "majority" | "split" | "single_source", BadgeTone> = {
  consensus: "success",
  majority: "accent",
  split: "danger",
  single_source: "warning",
};

function ComparisonMatrixEvidence({ comparisonMatrix }: { comparisonMatrix: ComparisonMatrixResult }) {
  const tally = { consensus: 0, majority: 0, split: 0, single_source: 0 };
  for (const cell of comparisonMatrix.cells) tally[cell.agreement] += 1;

  const disagreements = comparisonMatrix.cells.filter((c) => c.agreement === "split");
  const allSources = Array.from(new Set(comparisonMatrix.cells.flatMap((c) => c.sources ?? [])));

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Panel agreement</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(tally) as (keyof typeof tally)[]).map((key) =>
            tally[key] > 0 ? (
              <TintBadge key={key} tone={AGREEMENT_TALLY_TONE[key]}>
                {AGREEMENT_TALLY_LABEL[key]}: {tally[key]}
              </TintBadge>
            ) : null
          )}
        </div>
      </Card>

      {disagreements.length > 0 && (
        <Card>
          <SectionLabel>Where the panel disagrees</SectionLabel>
          <ul className="space-y-2">
            {disagreements.map((cell) => (
              <li key={`${cell.subjectId}::${cell.attributeId}`} className="text-sm">
                <p className="font-medium text-slate-900">
                  {cell.subject} <span className="text-slate-400">·</span> {cell.attribute}
                </p>
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(cell.valuesByModel).map(([modelId, value]) => (
                    <li key={modelId} className="text-xs text-slate-600">
                      <span className="text-slate-400">{modelId}:</span> {value}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {allSources.length > 0 && (
        <Card>
          <SectionLabel>Sources cited</SectionLabel>
          <ul className="list-disc list-outside pl-5 space-y-1 text-xs text-slate-600">
            {allSources.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** Shared coverage/evidence-strength tally strip — same tallied-badge pattern as ComparisonMatrixEvidence's agreement tally above, reused across the 4 Phase 2A batch 1 branches so each one stays a thin, honest summary rather than reinventing the layout. */
function CoverageTally({ tally, toneMap, labelMap }: { tally: Record<string, number>; toneMap: Record<string, BadgeTone>; labelMap: Record<string, string> }) {
  const entries = Object.entries(tally).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([key, count]) => (
        <TintBadge key={key} tone={toneMap[key] ?? "accent"}>
          {labelMap[key] ?? key}: {count}
        </TintBadge>
      ))}
    </div>
  );
}

const EVIDENCE_STRENGTH_LABEL: Record<string, string> = {
  strong: "Strong",
  moderate: "Moderate",
  weak: "Weak",
  contested: "Contested",
  unknown: "Unrated",
};
const EVIDENCE_STRENGTH_TONE: Record<string, BadgeTone> = {
  strong: "success",
  moderate: "accent",
  weak: "warning",
  contested: "danger",
  unknown: "warning",
};

function DeepResearchEvidence({ deepResearch }: { deepResearch: DeepResearchResult }) {
  const { findings, lowConfidenceFindings, disagreements } = deepResearch;
  const tally: Record<string, number> = { strong: 0, moderate: 0, weak: 0, contested: 0, unknown: 0 };
  for (const f of findings) tally[f.evidenceStrength] += 1;

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Finding evidence strength</SectionLabel>
        <CoverageTally tally={tally} toneMap={EVIDENCE_STRENGTH_TONE} labelMap={EVIDENCE_STRENGTH_LABEL} />
      </Card>

      {disagreements.length === 0 && (
        <Card>
          <p className="text-sm text-slate-500 italic">The panel did not flag any material disagreements for this research.</p>
        </Card>
      )}

      {lowConfidenceFindings.length > 0 && (
        <Card>
          <SectionLabel>Lower-confidence findings, raised by only 1-2 models ({lowConfidenceFindings.length})</SectionLabel>
          <ul className="space-y-2">
            {lowConfidenceFindings.map((f) => (
              <li key={f.id} className="text-sm">
                <p className="font-medium text-slate-900">{f.title}</p>
                <p className="text-xs text-slate-600">{f.summary}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function DecisionSupportEvidence({ decisionSupport }: { decisionSupport: DecisionSupportResult }) {
  const { assessments, recommendation } = decisionSupport;
  const tally: Record<string, number> = { strong: 0, moderate: 0, weak: 0, contested: 0, unknown: 0 };
  for (const a of assessments) tally[a.evidenceStrength] += 1;

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Assessment evidence strength ({assessments.length} option × criterion cell{assessments.length === 1 ? "" : "s"})</SectionLabel>
        <CoverageTally tally={tally} toneMap={EVIDENCE_STRENGTH_TONE} labelMap={EVIDENCE_STRENGTH_LABEL} />
      </Card>

      {recommendation.isContested ? (
        <Card className="bg-amber-50 border-amber-200">
          <p className="text-sm text-amber-900">
            The panel&apos;s recommendation is contested — models did not fully converge, whether on the action itself or on which option to
            choose. See the rationale and caveats above for the specific split.
          </p>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-slate-500 italic">The panel&apos;s recommended actions converged — no material split.</p>
        </Card>
      )}
    </div>
  );
}

function CausalExplanationEvidence({ causalExplanation }: { causalExplanation: CausalExplanationResult }) {
  const { factors, causalChain, disputedInterpretations } = causalExplanation;
  const tally: Record<string, number> = { strong: 0, moderate: 0, weak: 0, contested: 0, unknown: 0 };
  for (const f of factors) tally[f.evidenceStrength] += 1;

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Factor evidence strength ({factors.length} factor{factors.length === 1 ? "" : "s"}, {causalChain.length} causal link{causalChain.length === 1 ? "" : "s"})</SectionLabel>
        <CoverageTally tally={tally} toneMap={EVIDENCE_STRENGTH_TONE} labelMap={EVIDENCE_STRENGTH_LABEL} />
      </Card>

      {disputedInterpretations.length === 0 && (
        <Card>
          <p className="text-sm text-slate-500 italic">The panel did not flag any disputed interpretations of this causal account.</p>
        </Card>
      )}
    </div>
  );
}

function DefinitionExplanationEvidence({ definitionExplanation }: { definitionExplanation: DefinitionExplanationResult }) {
  const { primary, alternateInterpretations } = definitionExplanation;
  const allInterpretations = primary ? [primary, ...alternateInterpretations] : alternateInterpretations;
  const allSources = Array.from(new Set(allInterpretations.flatMap((i) => i.sources ?? [])));

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Interpretation coverage</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {allInterpretations.map((interp, idx) => (
            <TintBadge key={idx} tone={interp.coverageRatio >= 0.6 ? "accent" : "warning"}>
              {interp.term !== "none" ? interp.term : idx === 0 ? "Primary" : `Alternate ${idx}`}: {interp.coverageCount}/{interp.totalModels}
            </TintBadge>
          ))}
        </div>
      </Card>

      {allSources.length > 0 && (
        <Card>
          <SectionLabel>Sources cited (across all interpretations)</SectionLabel>
          <ul className="list-disc list-outside pl-5 space-y-1 text-xs text-slate-600">
            {allSources.map((s, idx) => (
              <li key={idx}>{s}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function SynthesisDrivenEvidence({
  synthesisReport,
  trustSummary,
  alignedClaims,
  modelsUsed,
  showClaimMatrix,
}: Required<Pick<PanelEvidenceSectionProps, "synthesisReport" | "modelsUsed">> &
  Pick<PanelEvidenceSectionProps, "trustSummary" | "alignedClaims" | "showClaimMatrix">) {
  const rows = alignedClaims || [];
  return (
    <div className="space-y-4">
      {trustSummary && <TrustSummaryTable trustSummary={trustSummary} />}
      <AgreementDisagreementMap claims={rows} modelsUsed={modelsUsed} />
      <SingleModelInsightsList claims={rows} />
      {showClaimMatrix && alignedClaims && alignedClaims.length > 0 && (
        <Card>
          <SectionLabel>Cross-model comparison</SectionLabel>
          <ClaimMatrix claims={alignedClaims} modelIds={modelsUsed} />
        </Card>
      )}
      <DisagreementsSection report={synthesisReport} />
    </div>
  );
}

export default function PanelEvidenceSection(props: PanelEvidenceSectionProps) {
  const hasContent =
    !!props.comparisonMatrix ||
    !!props.deepResearch ||
    !!props.decisionSupport ||
    !!props.causalExplanation ||
    !!props.definitionExplanation ||
    (!!props.gate && !!props.synthesisReport);
  if (!hasContent) return null;

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Panel Evidence</summary>
      <div className="mt-3">
        {props.comparisonMatrix ? (
          <ComparisonMatrixEvidence comparisonMatrix={props.comparisonMatrix} />
        ) : props.deepResearch ? (
          <DeepResearchEvidence deepResearch={props.deepResearch} />
        ) : props.decisionSupport ? (
          <DecisionSupportEvidence decisionSupport={props.decisionSupport} />
        ) : props.causalExplanation ? (
          <CausalExplanationEvidence causalExplanation={props.causalExplanation} />
        ) : props.definitionExplanation ? (
          <DefinitionExplanationEvidence definitionExplanation={props.definitionExplanation} />
        ) : (
          <SynthesisDrivenEvidence
            synthesisReport={props.synthesisReport!}
            trustSummary={props.trustSummary}
            alignedClaims={props.alignedClaims}
            modelsUsed={props.modelsUsed}
            showClaimMatrix={props.showClaimMatrix}
          />
        )}
      </div>
    </details>
  );
}
