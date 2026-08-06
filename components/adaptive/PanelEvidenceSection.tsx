"use client";

/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — the "Panel Evidence"
 * section: the FULL evidentiary record (consensus, disagreement, sources,
 * uncertainty, claim severity, model coverage), collapsed by default. The
 * primary view + PrimarySynthesisStrip already surface the single
 * highest-priority consensus/disagreement point — this section is the
 * complete record behind that headline, not a repeat of it. Self-wraps in
 * one <details> so callers never need extra wrapping logic.
 *
 * Branches on schemaId, one branch per schema family, so later rollout of
 * the remaining 15 schemas is additive branches here, not a rewrite:
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
 */

import { ModelId } from "@/lib/types";
import {
  AdaptiveGateResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  ComparisonMatrixResult,
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
  const hasContent = !!props.comparisonMatrix || (!!props.gate && !!props.synthesisReport);
  if (!hasContent) return null;

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Panel Evidence</summary>
      <div className="mt-3">
        {props.comparisonMatrix ? (
          <ComparisonMatrixEvidence comparisonMatrix={props.comparisonMatrix} />
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
