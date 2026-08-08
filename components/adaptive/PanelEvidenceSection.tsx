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
 *
 * - Phase 2B batch 2 (ranked_enumeration/checklist_taxonomy/evidence_review/
 *   bias_blindspot_audit): same modest-tally discipline as batch 1.
 *   ranked_enumeration gets a coverage-tier tally plus the full list of
 *   items with per-model rank disagreement (RankedListView only flags this
 *   inline per-item; the full list lives here — see RANK_DISAGREEMENT_MIN_VARIANCE
 *   in RankedListView.tsx, reused rather than redefined). checklist_taxonomy
 *   MUST branch on isRiskShapedChecklistResult the exact same way
 *   AdaptivePanelResponse.tsx does — a severity tally for the risk-shaped
 *   path, a coverage-tier tally for the plain-checklist path — so the two
 *   presentations stay visibly distinct all the way into Panel Evidence,
 *   never a single shared tally that would blur them back together.
 *   evidence_review gets a strength tally (reusing the exact
 *   EVIDENCE_STRENGTH_LABEL/TONE vocabulary already used for causal
 *   factors/decision assessments — evidence strength means the same thing
 *   everywhere in this app) plus the full lowConfidenceDimensions list
 *   (EvidenceReviewView's "Panel detail" only mentions its count).
 *   bias_blindspot_audit surfaces geographicBiasConcerns/
 *   sourceConcentrationConcerns/evidenceTypeConcerns — Tier 3 fields that
 *   biasBlindspotAlignment.ts computes but that NO renderer displays
 *   anywhere today (confirmed by repo-wide search before writing this) —
 *   explicitly labeled as deterministic, pattern-based concerns, never as
 *   confirmed bias, to keep the tier distinction (observed/plausible/
 *   speculative) intact all the way into this section too.
 */

import { ModelId } from "@/lib/types";
import {
  AdaptiveGateResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  AlignedClaim,
  BiasBlindspotAuditResult,
  CausalExplanationResult,
  ChecklistTaxonomyResult,
  ComparisonMatrixResult,
  DecisionSupportResult,
  DeepResearchResult,
  DefinitionExplanationResult,
  EvidenceReviewResult,
  QueryType,
  RankedEnumerationResult,
  isRiskShapedChecklistResult,
} from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel, TintBadge, BadgeTone } from "./shared";
import ClaimMatrix from "./ClaimMatrix";
import { TrustSummaryTable, AgreementDisagreementMap, SingleModelInsightsList, DisagreementsSection } from "./AdaptiveSynthesisReportView";
import { RANK_DISAGREEMENT_MIN_VARIANCE } from "./RankedListView";

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
  // Phase 2B batch 2 — each present only for its own schemaId:
  rankedEnumeration?: RankedEnumerationResult;
  checklistTaxonomy?: ChecklistTaxonomyResult;
  evidenceReview?: EvidenceReviewResult;
  biasBlindspotAudit?: BiasBlindspotAuditResult;
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

/** Coverage-ratio tiering shared by ranked_enumeration's and plain checklist_taxonomy's tallies below — same 0.75/0.5 cut points reportSummary.ts's tierFromRatio already uses for these two schemas' consensus level, so the tally and the TopSummaryBar badge never disagree about what "strong" coverage means. */
function coverageTier(ratio: number): "strong" | "moderate" | "weak" {
  if (ratio >= 0.75) return "strong";
  if (ratio >= 0.5) return "moderate";
  return "weak";
}

const COVERAGE_TIER_LABEL: Record<string, string> = { strong: "Strong coverage", moderate: "Moderate coverage", weak: "Weak coverage" };
const COVERAGE_TIER_TONE: Record<string, BadgeTone> = { strong: "success", moderate: "accent", weak: "warning" };

function RankedEnumerationEvidence({ rankedEnumeration }: { rankedEnumeration: RankedEnumerationResult }) {
  const { items, lowConfidenceItems } = rankedEnumeration;
  const allItems = [...items, ...lowConfidenceItems];
  const tally: Record<string, number> = { strong: 0, moderate: 0, weak: 0 };
  for (const item of allItems) tally[coverageTier(item.coverageRatio)] += 1;

  const disputedRankItems = allItems.filter(
    (item) => item.rankVariance !== undefined && item.rankVariance >= RANK_DISAGREEMENT_MIN_VARIANCE
  );

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Item coverage ({allItems.length} item{allItems.length === 1 ? "" : "s"})</SectionLabel>
        <CoverageTally tally={tally} toneMap={COVERAGE_TIER_TONE} labelMap={COVERAGE_TIER_LABEL} />
      </Card>

      {disputedRankItems.length === 0 ? (
        <Card>
          <p className="text-sm text-slate-500 italic">The panel did not place any item at materially different ranks.</p>
        </Card>
      ) : (
        <Card className="bg-amber-50 border-amber-200">
          <SectionLabel>Items where models disagreed on the exact rank ({disputedRankItems.length})</SectionLabel>
          <ul className="space-y-1.5">
            {disputedRankItems.map((item) => (
              <li key={item.id} className="text-sm text-amber-900">
                {item.label} <span className="text-amber-700">— rank variance {item.rankVariance!.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

const SEVERITY_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", unrated: "Unrated" };
const SEVERITY_TONE: Record<string, BadgeTone> = { critical: "danger", high: "danger", medium: "warning", low: "accent", unrated: "warning" };

function ChecklistTaxonomyEvidence({ checklistTaxonomy }: { checklistTaxonomy: ChecklistTaxonomyResult }) {
  const { categories, lowConfidenceItems } = checklistTaxonomy;
  const allItems = [...categories.flatMap((c) => c.items), ...lowConfidenceItems];
  const isRiskShaped = isRiskShapedChecklistResult(checklistTaxonomy);

  if (isRiskShaped) {
    const tally: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, unrated: 0 };
    for (const item of allItems) tally[item.severity ?? "unrated"] += 1;
    const undocumented = allItems.filter((item) => !item.mitigation).length;

    return (
      <div className="space-y-3">
        <Card>
          <SectionLabel>Risk severity ({allItems.length} risk{allItems.length === 1 ? "" : "s"})</SectionLabel>
          <CoverageTally tally={tally} toneMap={SEVERITY_TONE} labelMap={SEVERITY_LABEL} />
        </Card>
        <Card>
          <p className="text-sm text-slate-500 italic">
            {undocumented === 0
              ? "Every risk has a stated mitigation."
              : `${undocumented} of ${allItems.length} risk${allItems.length === 1 ? "" : "s"} ${undocumented === 1 ? "has" : "have"} no stated mitigation.`}
          </p>
        </Card>
      </div>
    );
  }

  const tally: Record<string, number> = { strong: 0, moderate: 0, weak: 0 };
  for (const item of allItems) tally[coverageTier(item.coverageRatio)] += 1;
  const criticalCount = allItems.filter((item) => item.critical).length;

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Item coverage ({allItems.length} item{allItems.length === 1 ? "" : "s"})</SectionLabel>
        <CoverageTally tally={tally} toneMap={COVERAGE_TIER_TONE} labelMap={COVERAGE_TIER_LABEL} />
      </Card>
      <Card>
        <p className="text-sm text-slate-500 italic">
          {criticalCount === 0
            ? "No item was flagged as must-have/blocking."
            : `${criticalCount} of ${allItems.length} item${allItems.length === 1 ? "" : "s"} ${criticalCount === 1 ? "is" : "are"} flagged must-have/blocking.`}
        </p>
      </Card>
    </div>
  );
}

function EvidenceReviewEvidence({ evidenceReview }: { evidenceReview: EvidenceReviewResult }) {
  const { dimensions, lowConfidenceDimensions } = evidenceReview;
  const tally: Record<string, number> = { strong: 0, moderate: 0, weak: 0, contested: 0, unknown: 0 };
  for (const d of dimensions) tally[d.strength] += 1;

  return (
    <div className="space-y-3">
      <Card>
        <SectionLabel>Dimension evidence strength</SectionLabel>
        <CoverageTally tally={tally} toneMap={EVIDENCE_STRENGTH_TONE} labelMap={EVIDENCE_STRENGTH_LABEL} />
      </Card>

      {lowConfidenceDimensions.length > 0 && (
        <Card>
          <SectionLabel>Lower-confidence dimensions, raised by only 1-2 models ({lowConfidenceDimensions.length})</SectionLabel>
          <ul className="space-y-2">
            {lowConfidenceDimensions.map((d) => (
              <li key={d.id} className="text-sm">
                <p className="font-medium text-slate-900">{d.dimension}</p>
                <p className="text-xs text-slate-600">{d.assessment}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function BiasBlindspotAuditEvidence({ biasBlindspotAudit }: { biasBlindspotAudit: BiasBlindspotAuditResult }) {
  const { geographicBiasConcerns, sourceConcentrationConcerns, evidenceTypeConcerns } = biasBlindspotAudit.structuralDiagnostics;
  const hasAnyConcern = geographicBiasConcerns.length > 0 || sourceConcentrationConcerns.length > 0 || evidenceTypeConcerns.length > 0;

  return (
    <div className="space-y-3">
      <Card>
        <p className="text-xs text-slate-500 leading-relaxed">
          The three lists below are Tier 3 — deterministic, pattern-based concerns computed directly from the panel&apos;s own responses.
          They are not confirmed bias (that is Tier 1, shown in the primary report) and not the panel&apos;s own self-reported gaps (Tier 2,
          also in the primary report) — treat them as speculative signals worth a second look, never as established findings.
        </p>
      </Card>

      {!hasAnyConcern ? (
        <Card>
          <p className="text-sm text-slate-500 italic">No geographic, source-concentration, or evidence-type concerns were detected.</p>
        </Card>
      ) : (
        <>
          {geographicBiasConcerns.length > 0 && (
            <Card>
              <SectionLabel>Geographic/cultural framing concerns</SectionLabel>
              <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
                {geographicBiasConcerns.map((c, idx) => (
                  <li key={idx}>{c}</li>
                ))}
              </ul>
            </Card>
          )}
          {sourceConcentrationConcerns.length > 0 && (
            <Card>
              <SectionLabel>Source concentration concerns</SectionLabel>
              <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
                {sourceConcentrationConcerns.map((c, idx) => (
                  <li key={idx}>{c}</li>
                ))}
              </ul>
            </Card>
          )}
          {evidenceTypeConcerns.length > 0 && (
            <Card>
              <SectionLabel>Evidence-type concerns</SectionLabel>
              <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
                {evidenceTypeConcerns.map((c, idx) => (
                  <li key={idx}>{c}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
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
    !!props.rankedEnumeration ||
    !!props.checklistTaxonomy ||
    !!props.evidenceReview ||
    !!props.biasBlindspotAudit ||
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
        ) : props.rankedEnumeration ? (
          <RankedEnumerationEvidence rankedEnumeration={props.rankedEnumeration} />
        ) : props.checklistTaxonomy ? (
          <ChecklistTaxonomyEvidence checklistTaxonomy={props.checklistTaxonomy} />
        ) : props.evidenceReview ? (
          <EvidenceReviewEvidence evidenceReview={props.evidenceReview} />
        ) : props.biasBlindspotAudit ? (
          <BiasBlindspotAuditEvidence biasBlindspotAudit={props.biasBlindspotAudit} />
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
