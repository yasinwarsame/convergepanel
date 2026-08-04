"use client";

/**
 * Query-Routing Redesign, Milestone 2 — decision_support's dedicated
 * renderer, the ninth schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell, and
 * deliberately never shows a numeric decision-certainty score — the
 * recommendation badge reflects `recommendation.action`
 * (go/conditional_go/defer/no_go/escalate/monitor/choose_option), and any
 * genuine model split is surfaced as "Panel split" text, never averaged into
 * a confident-looking percentage. `humanReviewNeeded` is a real field
 * computed in decisionSupportAlignment.ts (from risk level, contested
 * status, and evidence strength on the recommended option) — this renderer
 * reads it directly rather than re-deriving a high-stakes banner from a
 * separate `riskLevel` prop the way CausalExplanationView/EvidenceReviewView
 * do, since that signal is already folded in.
 */

import { AggregatedDecisionAssessment, AggregatedDecisionCriterion, AggregatedDecisionOption, DecisionRecommendationAction, DecisionSupportResult } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";

const ACTION_LABELS: Record<DecisionRecommendationAction, string> = {
  go: "Go",
  conditional_go: "Conditional go",
  defer: "Defer",
  no_go: "No go",
  escalate: "Escalate",
  monitor: "Monitor",
  choose_option: "Choose option",
};

const ACTION_TONES: Record<DecisionRecommendationAction, "accent" | "warning" | "danger"> = {
  go: "accent",
  conditional_go: "warning",
  defer: "warning",
  no_go: "danger",
  escalate: "danger",
  monitor: "warning",
  choose_option: "accent",
};

function StrengthBadge({ strength }: { strength: AggregatedDecisionAssessment["evidenceStrength"] }) {
  if (strength === "unknown") return null;
  const tone = strength === "strong" ? "accent" : strength === "contested" ? "danger" : "warning";
  const label = strength.charAt(0).toUpperCase() + strength.slice(1);
  return <TintBadge tone={tone}>{label}</TintBadge>;
}

/** Milestone 2 UI consistency cleanup — sourceBacked was already computed but never rendered. Placed near the recommendation metadata, phrased as an evidence-support signal (not a confidence/certainty score). */
function SourceBackedBadge({ sourceBacked }: { sourceBacked: boolean }) {
  return (
    <TintBadge
      tone={sourceBacked ? "accent" : "warning"}
      title="Whether at least one contributing model cited a source for this decision — not a measure of how strong that source is"
    >
      {sourceBacked ? "Source-backed" : "No source support captured"}
    </TintBadge>
  );
}

function cellKey(optionId: string, criterionId: string): string {
  return `${optionId}::${criterionId}`;
}

function AssessmentCell({
  decisionSupport,
  option,
  criterion,
}: {
  decisionSupport: DecisionSupportResult;
  option: AggregatedDecisionOption;
  criterion: AggregatedDecisionCriterion;
}) {
  const cell = decisionSupport.assessments.find((a) => a.optionId === option.id && a.criterionId === criterion.id);
  if (!cell) return <span className="text-slate-300">—</span>;
  return (
    <div className="space-y-1">
      <p className="text-sm text-slate-900">{cell.assessment}</p>
      <div className="flex flex-wrap items-center gap-1">
        <StrengthBadge strength={cell.evidenceStrength} />
        <TintBadge tone="accent">{formatModelCoverage({ covered: cell.coverageCount, total: cell.totalModels, mode: "assessed" })}</TintBadge>
      </div>
    </div>
  );
}

export default function DecisionSupportView({ decisionSupport }: { decisionSupport: DecisionSupportResult }) {
  const {
    decisionQuestion,
    options,
    criteria,
    recommendation,
    assumptions,
    uncertainties,
    risks,
    sensitivityFindings,
    reversibleNextStep,
    humanReviewNeeded,
    sourceBacked,
    totalModels,
  } = decisionSupport;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  const recommendedOption = recommendation.recommendedOptionId
    ? options.find((o) => o.id === recommendation.recommendedOptionId)
    : undefined;

  return (
    <div className="space-y-3">
      {humanReviewNeeded && (
        <Card className="bg-amber-50 border-amber-200">
          <p className="text-xs text-amber-900 leading-relaxed">
            This decision needs human review — either the stakes are high, the panel&apos;s own recommendations genuinely conflicted, or the
            evidence behind the recommended option is weak or unclear. Treat this as a starting point, not a final call.
          </p>
        </Card>
      )}

      <Card>
        {/* 1. Decision question — framing, not a full section. */}
        {decisionQuestion && <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">{decisionQuestion}</p>}

        {/* 2. Recommendation — first, dominant content. */}
        <div className="flex flex-wrap items-center gap-2">
          <TintBadge tone={ACTION_TONES[recommendation.action]}>{ACTION_LABELS[recommendation.action]}</TintBadge>
          {recommendedOption && <span className="text-base font-semibold text-slate-900">{recommendedOption.label}</span>}
          {recommendation.isContested && (
            <TintBadge tone="danger" title="Contributing models' own recommendations did not converge">
              Panel split
            </TintBadge>
          )}
          <SourceBackedBadge sourceBacked={sourceBacked} />
        </div>

        {/* 3. Why this recommendation. */}
        {recommendation.rationale && <p className="mt-2 text-sm text-slate-700">{recommendation.rationale}</p>}
        {recommendation.caveats.length > 0 && (
          <ul className="mt-2 list-disc list-outside pl-5 space-y-1 text-xs text-slate-600">
            {recommendation.caveats.map((c, idx) => (
              <li key={idx}>{c}</li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-slate-400">
          {formatModelCoverage({ covered: recommendation.supportCount, total: recommendation.totalModelsWithRecommendation, mode: "converged" })} —
          not a certainty score.
        </p>

        {/* 4. Options considered. */}
        {options.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Options considered</SectionLabel>
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <TintBadge
                  key={o.id}
                  tone="accent"
                  title={formatModelCoverage({ covered: o.coverageCount, total: o.totalModels, mode: "covered" })}
                >
                  {o.label}
                </TintBadge>
              ))}
            </div>
          </div>
        )}

        {/* 5 + 6. Decision criteria + option-by-criterion matrix. */}
        {criteria.length > 0 && options.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Decision criteria</SectionLabel>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr>
                    <th className="border-b border-slate-200 p-2 text-xs font-semibold uppercase tracking-wide text-slate-500" />
                    {options.map((option) => (
                      <th key={option.id} className="border-b border-slate-200 p-2 text-sm font-semibold text-slate-900 whitespace-nowrap">
                        {option.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {criteria.map((criterion) => (
                    <tr key={criterion.id}>
                      <th className="border-b border-slate-100 p-2 align-top text-sm font-medium text-slate-700 whitespace-nowrap">
                        {criterion.label}
                        {criterion.source === "user" && (
                          <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-sky-600">your criterion</span>
                        )}
                      </th>
                      {options.map((option) => (
                        <td key={cellKey(option.id, criterion.id)} className="border-b border-slate-100 p-2 align-top">
                          <AssessmentCell decisionSupport={decisionSupport} option={option} criterion={criterion} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 7. Risks and tradeoffs. */}
        {risks.length > 0 && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
            <SectionLabel>Risks and tradeoffs</SectionLabel>
            <ul className="space-y-2">
              {risks.map((risk) => (
                <li key={risk.id} className="text-sm text-red-800">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{risk.label}</span>
                    {risk.optionId && (
                      <span className="text-xs text-red-600">({options.find((o) => o.id === risk.optionId)?.label ?? "option-specific"})</span>
                    )}
                    {risk.likelihood && risk.likelihood !== "unknown" && <TintBadge tone="warning">Likelihood: {risk.likelihood}</TintBadge>}
                    {risk.impact && risk.impact !== "unknown" && <TintBadge tone="warning">Impact: {risk.impact}</TintBadge>}
                  </div>
                  {risk.mitigation && <p className="mt-0.5 text-xs text-red-700">Mitigation: {risk.mitigation}</p>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 8. Assumptions. */}
        {assumptions.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Assumptions</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {assumptions.map((a, idx) => (
                <li key={idx}>{a}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 9. Uncertainties — missing information, never hidden. */}
        {uncertainties.length > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <SectionLabel>What&apos;s still uncertain</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {uncertainties.map((u, idx) => (
                <li key={idx}>{u}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 10. Sensitivity findings — what would change the recommendation. */}
        {sensitivityFindings.length > 0 && (
          <div className="mt-3">
            <SectionLabel>What would change this recommendation</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {sensitivityFindings.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 11. Reversible next step. */}
        {reversibleNextStep && (
          <div className="mt-3 rounded-lg bg-sky-50 border border-sky-200 p-3">
            <SectionLabel>Lowest-regret next step</SectionLabel>
            <p className="text-sm text-sky-900">{reversibleNextStep}</p>
          </div>
        )}

        {/* 12. Collapsible model-level detail — never primary. */}
        <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Panel detail ({totalModels} model{totalModels === 1 ? "" : "s"})
          </summary>
          <p className="mt-1.5 text-xs text-slate-500">
            The recommendation reflects only genuine agreement across contributing models&apos; own recommended actions — a real split falls
            back to a conservative action rather than a vote-counted winner. Coverage badges show how many models raised each option,
            criterion, or assessment, not a certainty score.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {Array.from(new Set(options.flatMap((o) => o.contributingModels))).map((modelId) => (
              <ModelChip key={modelId} modelId={modelId} size="xs" />
            ))}
          </div>
        </details>
      </Card>
    </div>
  );
}
