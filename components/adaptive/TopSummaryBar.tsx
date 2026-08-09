"use client";

/**
 * Adaptive Synthesis Report, Phase 1 (docs/adaptive-synthesis-report-design.md
 * §4.1) — the top summary bar shown inline on every adaptive result, above
 * the schema-specific renderer. Report type / Status / Models / Consensus /
 * Source grounding / Generated, computed from data every caller already
 * has — no new model calls, no new alignment pass (see reportStatus.ts's
 * and reportSummary.ts's own module docs for exactly which existing signal
 * backs each field).
 *
 * This is the design doc's former "ReportStatusBanner" (export design §3.2)
 * generalized across all 18 report-producing schemas, per the synthesis
 * report design's own §8 sequencing — the first implementation step ahead
 * of the bigger §5 category-specific report restructuring.
 */

import {
  AdaptiveGateResult,
  AdaptiveModelResult,
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
} from "@/lib/adaptiveSchema/types";
import { deriveReportStatus, REPORT_STATUS_LABELS, ReportStatusInput } from "@/lib/adaptiveSchema/reportStatus";
import {
  CONSENSUS_LABELS,
  deriveConsensusLevel,
  deriveSourceGrounding,
  deriveTotalModelsFromSchemaResult,
  getReportTypeLabel,
  SOURCE_GROUNDING_LABELS,
} from "@/lib/adaptiveSchema/reportSummary";
import { BadgeTone, Card, TintBadge } from "./shared";
import AdaptiveExportButton from "./AdaptiveExportButton";

type ReportStatusKind = ReturnType<typeof deriveReportStatus>["kind"];

export interface TopSummaryBarProps {
  schemaId: QueryType;
  results: AdaptiveModelResult[];
  /** Adaptive Research Export, Phase 1 — threaded through only so AdaptiveExportButton can target the right run; TopSummaryBar itself does nothing else with it. */
  runId?: string | null;
  generatedAt?: string;
  persistenceStatus?: ReportStatusInput["persistenceStatus"];
  humanReview?: ReportStatusInput["humanReview"];
  reviewRouting?: ReportStatusInput["reviewRouting"];
  gate?: AdaptiveGateResult;
  trustSummary?: AdaptiveTrustSummary;
  meta?: CommonResponseMeta;
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

/** Dot color for the Status field — not a TintBadge tone, since Status is rendered as a dot + wrapping text, not a pill (see TopSummaryBar's own render for why). */
const STATUS_DOT_COLOR: Record<ReportStatusKind, string> = {
  unreviewed_in_queue: "bg-amber-500",
  not_reviewed_no_review_configured: "bg-sky-500",
  approved: "bg-green-500",
  approved_with_conditions: "bg-green-500",
  changes_requested: "bg-amber-500",
  rejected: "bg-red-500",
  incomplete: "bg-red-500",
};

const LEVEL_TONE: Record<"strong" | "moderate" | "weak" | "split" | "unscored", BadgeTone> = {
  strong: "success",
  moderate: "accent",
  weak: "warning",
  split: "danger",
  unscored: "accent",
};

function SummaryField({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function formatGeneratedAt(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function TopSummaryBar(props: TopSummaryBarProps) {
  const { schemaId, results, runId, generatedAt, persistenceStatus, humanReview, reviewRouting, gate, trustSummary, meta } = props;

  const status = deriveReportStatus({ humanReview, reviewRouting, persistenceStatus });
  const consensus = deriveConsensusLevel({
    schemaId,
    gate,
    comparisonMatrix: props.comparisonMatrix,
    checklistTaxonomy: props.checklistTaxonomy,
    decisionSupport: props.decisionSupport,
    causalExplanation: props.causalExplanation,
    definitionExplanation: props.definitionExplanation,
    rankedEnumeration: props.rankedEnumeration,
    deepResearch: props.deepResearch,
    evidenceReview: props.evidenceReview,
    biasBlindspotAudit: props.biasBlindspotAudit,
  });
  const sourceGrounding = deriveSourceGrounding({ meta, trustSummary });

  const reportType = getReportTypeLabel(schemaId, props.checklistTaxonomy);
  const modelCount = results.length;
  const okCount = results.filter((r) => r.ok).length;
  const schemaTotalModels =
    modelCount === 0
      ? deriveTotalModelsFromSchemaResult({
          comparisonMatrix: props.comparisonMatrix,
          checklistTaxonomy: props.checklistTaxonomy,
          decisionSupport: props.decisionSupport,
          causalExplanation: props.causalExplanation,
          definitionExplanation: props.definitionExplanation,
          rankedEnumeration: props.rankedEnumeration,
          deepResearch: props.deepResearch,
          evidenceReview: props.evidenceReview,
          biasBlindspotAudit: props.biasBlindspotAudit,
        })
      : null;

  const statusLabel = status.isOwnerOverride ? `Owner override — ${REPORT_STATUS_LABELS[status.kind]}` : REPORT_STATUS_LABELS[status.kind];

  return (
    <Card className="bg-slate-50/60">
      {/* Report type / Status get their own row — both can run long ("Owner
          override — Reviewed with conditions" is the longest possible
          status label) and must WRAP, never overflow into a neighboring
          field. Status is deliberately not a TintBadge pill here (pills
          don't wrap cleanly) — a dot + wrapping text instead, same tone
          colors. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <SummaryField label="Report type" className="sm:min-w-[160px]">
          <span className="text-sm font-semibold text-slate-900">{reportType}</span>
        </SummaryField>

        <SummaryField label="Status" className="sm:min-w-[220px] sm:flex-1">
          <span className="inline-flex items-start gap-1.5" title={status.conditions?.join("; ")}>
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT_COLOR[status.kind]}`} aria-hidden="true" />
            <span className="text-sm font-medium text-slate-800">{statusLabel}</span>
          </span>
        </SummaryField>

        <AdaptiveExportButton runId={runId} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-4">
        <SummaryField label="Models">
          <span className="text-sm text-slate-800">
            {modelCount > 0 ? `${okCount} of ${modelCount}` : schemaTotalModels != null ? `${schemaTotalModels} models` : "—"}
          </span>
        </SummaryField>

        <SummaryField label="Consensus">
          <TintBadge tone={LEVEL_TONE[consensus]}>{CONSENSUS_LABELS[consensus]}</TintBadge>
        </SummaryField>

        <SummaryField label="Source grounding">
          <TintBadge tone={LEVEL_TONE[sourceGrounding]}>{SOURCE_GROUNDING_LABELS[sourceGrounding]}</TintBadge>
        </SummaryField>

        <SummaryField label="Generated">
          <span className="text-sm text-slate-800">{formatGeneratedAt(generatedAt)}</span>
        </SummaryField>
      </div>
    </Card>
  );
}
