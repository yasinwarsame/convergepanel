"use client";

/**
 * Risk Analysis renderer — a risk-shaped presentation of checklist_taxonomy
 * results (see checklistAlignment.ts's isRiskShapedChecklistResult).
 *
 * Deliberately NOT a new schema/queryType: "what are the risks of X" already
 * classifies as checklist_taxonomy (an enumeration where order/ranking
 * doesn't apply), and ChecklistItem's risk fields (severity/likelihood/
 * impact/evidence/mitigation/monitoringSignal/residualRisk) are optional
 * additions to that same schema, populated by the model only when the
 * items genuinely are risks. This view reads the exact same
 * ChecklistTaxonomyResult ChecklistTaxonomyView does — it just presents it
 * as a risk register instead of a bare checklist. AdaptivePanelResponse.tsx
 * picks between the two views based on whether the DATA is risk-shaped, not
 * on the query text.
 */

import { AggregatedChecklistItem, ChecklistItemSeverity, ChecklistTaxonomyResult } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, BadgeTone, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";
import { ModelId } from "@/lib/types";

const SEVERITY_TONE: Record<ChecklistItemSeverity, BadgeTone> = {
  low: "accent",
  medium: "warning",
  high: "danger",
  critical: "danger",
};

const SEVERITY_LABEL: Record<ChecklistItemSeverity, string> = {
  low: "Low severity",
  medium: "Medium severity",
  high: "High severity",
  critical: "Critical severity",
};

function LikelihoodBadge({ likelihood }: { likelihood: AggregatedChecklistItem["likelihood"] }) {
  if (!likelihood) return null;
  const tone: BadgeTone = likelihood === "high" ? "danger" : likelihood === "medium" ? "warning" : "accent";
  return <TintBadge tone={tone}>{likelihood[0].toUpperCase() + likelihood.slice(1)} likelihood</TintBadge>;
}

function RiskDetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <p className="mt-1 text-xs text-slate-600">
      <span className="font-semibold text-slate-700">{label}:</span> {value}
    </p>
  );
}

function RiskRegisterRow({ item }: { item: AggregatedChecklistItem }) {
  const modelIds = item.contributingModels as ModelId[];
  return (
    <li className="py-3 border-b border-slate-100 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900">{item.label}</span>
        {item.severity && <TintBadge tone={SEVERITY_TONE[item.severity]}>{SEVERITY_LABEL[item.severity]}</TintBadge>}
        <LikelihoodBadge likelihood={item.likelihood} />
        <TintBadge
          tone={item.coverageRatio >= 0.6 ? "accent" : "warning"}
          title="How many models flagged this risk — a consensus/disagreement signal, not a certainty score."
        >
          {formatModelCoverage({ covered: item.coverageCount, total: item.totalModels, mode: "covered" })}
        </TintBadge>
      </div>
      <RiskDetailRow label="Impact" value={item.impact} />
      <RiskDetailRow label="Evidence" value={item.evidence} />
      <RiskDetailRow label="Mitigation" value={item.mitigation} />
      <RiskDetailRow label="Monitoring signal" value={item.monitoringSignal} />
      <RiskDetailRow label="Residual risk" value={item.residualRisk} />
      {item.rationale && <p className="mt-1 text-xs text-slate-500 italic">{item.rationale}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {modelIds.map((modelId) => (
          <ModelChip key={modelId} modelId={modelId} size="xs" />
        ))}
      </div>
    </li>
  );
}

export default function RiskAnalysisView({ checklistTaxonomy }: { checklistTaxonomy: ChecklistTaxonomyResult }) {
  const { summary, categories, lowConfidenceItems, notes, totalModels } = checklistTaxonomy;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  const isFlatRegister = categories.length <= 1 && (categories.length === 0 || categories[0].category === "General");
  const isEmpty = categories.length === 0 && lowConfidenceItems.length === 0;

  return (
    <div className="space-y-3">
      {summary && (
        <Card className="bg-rose-50/60 border-rose-200">
          <SectionLabel>Executive risk conclusion</SectionLabel>
          <p className="text-sm text-slate-800 leading-relaxed">{summary}</p>
        </Card>
      )}

      <Card>
        <SectionLabel>Risk register</SectionLabel>
        {isEmpty ? (
          <p className="text-sm text-slate-500 italic">No risks were returned for this question.</p>
        ) : isFlatRegister ? (
          <ul>{categories[0]?.items.map((item) => <RiskRegisterRow key={item.id} item={item} />)}</ul>
        ) : (
          <div className="space-y-4">
            {categories.map((group) => (
              <div key={group.category}>
                <SectionLabel>{group.category}</SectionLabel>
                <ul>
                  {group.items.map((item) => (
                    <RiskRegisterRow key={item.id} item={item} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      {lowConfidenceItems.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Lower-confidence risks, raised by only 1-2 models ({lowConfidenceItems.length})
          </summary>
          <ul className="mt-2">
            {lowConfidenceItems.map((item) => (
              <RiskRegisterRow key={item.id} item={item} />
            ))}
          </ul>
        </details>
      )}

      {notes.length > 0 && (
        <Card className="bg-amber-50 border-amber-200">
          <SectionLabel>Unknowns</SectionLabel>
          <ul className="list-disc list-outside pl-5 space-y-1 text-xs text-amber-900">
            {notes.map((n, idx) => (
              <li key={idx}>{n}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
