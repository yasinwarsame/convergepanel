"use client";

/**
 * Query-Routing Redesign, Milestone 2 — causal_explanation's dedicated
 * renderer, the fourth schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell, and
 * deliberately never renders a single "certainty"/"confidence" number: the
 * central design risk this schema exists to avoid is mistaking panel
 * convergence (N models repeating the same story) for proof a cause is
 * real. Coverage badges below always say "N of M models agree" — never
 * "N% confidence" — and evidence-strength labels only appear when the
 * panel itself flagged genuine disagreement (see causalAlignment.ts),
 * never derived from how many models said the same thing.
 */

import {
  AggregatedCausalFactor,
  AggregatedCausalLink,
  CausalExplanationResult,
  CausalFactorCategory,
  RiskLevel,
} from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";
import { ModelId } from "@/lib/types";

const CATEGORY_LABEL: Record<CausalFactorCategory, string> = {
  direct_cause: "Direct cause",
  contributing_factor: "Contributing factor",
  trigger: "Trigger",
  amplifier: "Amplifier",
  protective_factor: "Protective factor",
  alternative_explanation: "Alternative explanation",
};

function CoverageBadge({ coverageCount, totalModels }: { coverageCount: number; totalModels: number }) {
  return (
    <TintBadge tone={coverageCount / Math.max(totalModels, 1) >= 0.6 ? "accent" : "warning"} title="How many models raised this — not a certainty score">
      {formatModelCoverage({ covered: coverageCount, total: totalModels, mode: "covered" })}
    </TintBadge>
  );
}

function FactorRow({ factor }: { factor: AggregatedCausalFactor }) {
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-800">{factor.label}</span>
        <CoverageBadge coverageCount={factor.coverageCount} totalModels={factor.totalModels} />
        {factor.evidenceStrength === "contested" && (
          <TintBadge tone="danger" title="The panel itself flagged genuine disagreement about this factor">
            Contested
          </TintBadge>
        )}
        {factor.sourceBacked && (
          <span className="text-[11px] text-slate-500" title="At least one contributing model cited a source somewhere in its response">
            Source-cited
          </span>
        )}
      </div>
    </li>
  );
}

function CausalLinkRow({ link }: { link: AggregatedCausalLink }) {
  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 text-slate-400" aria-hidden="true">→</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-slate-800">{link.mechanism}</p>
        <div className="mt-1">
          <CoverageBadge coverageCount={link.coverageCount} totalModels={link.totalModels} />
        </div>
      </div>
    </li>
  );
}

const HIGH_STAKES_RISK_LEVELS = new Set<RiskLevel>(["safety_critical", "high_stakes"]);

export default function CausalExplanationView({
  causalExplanation,
  riskLevel,
}: {
  causalExplanation: CausalExplanationResult;
  riskLevel?: RiskLevel;
}) {
  const { directAnswer, factors, causalChain, confounders, disputedInterpretations, unknowns, testsOrEvidenceNeeded, totalModels } =
    causalExplanation;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  const directCauses = factors.filter((f) => f.category === "direct_cause");
  const contributingFactors = factors.filter(
    (f) => f.category === "contributing_factor" || f.category === "trigger" || f.category === "amplifier" || f.category === "protective_factor"
  );
  const alternativeExplanations = factors.filter((f) => f.category === "alternative_explanation");

  const contributingModels = Array.from(
    new Set<ModelId>([
      ...factors.flatMap((f) => f.contributingModels),
      ...causalChain.flatMap((c) => c.contributingModels),
      ...disputedInterpretations.flatMap((d) => d.supportingModels),
    ])
  );

  const hasAnyContent =
    directAnswer ||
    factors.length > 0 ||
    causalChain.length > 0 ||
    confounders.length > 0 ||
    disputedInterpretations.length > 0 ||
    unknowns.length > 0 ||
    testsOrEvidenceNeeded.length > 0;

  if (!hasAnyContent) {
    return <EmptyStateCard state="models_no_usable_output" schemaSpecificMessage="No causal explanation could be produced for this question." />;
  }

  return (
    <div className="space-y-3">
      {riskLevel && HIGH_STAKES_RISK_LEVELS.has(riskLevel) && (
        <Card className="bg-amber-50 border-amber-200">
          <p className="text-xs text-amber-900 leading-relaxed">
            This touches a high-stakes domain — treat this causal account as a starting point, not a substitute for professional or expert
            review.
          </p>
        </Card>
      )}

      <Card>
        {/* 1. Direct causal answer. */}
        <p className="text-base font-semibold text-slate-900 leading-snug">{directAnswer}</p>

        {/* 2. Main (direct) causes — distinct visual treatment. */}
        {directCauses.length > 0 && (
          <div className="mt-3 border-l-2 border-sky-400 pl-3">
            <SectionLabel>Main causes</SectionLabel>
            <ul>
              {directCauses.map((f) => (
                <FactorRow key={f.id} factor={f} />
              ))}
            </ul>
          </div>
        )}

        {/* 3. Contributing factors (triggers/amplifiers/protective factors folded in as the same tier). */}
        {contributingFactors.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Contributing factors</SectionLabel>
            <ul>
              {contributingFactors.map((f) => (
                <li key={f.id} className="py-1">
                  <TintBadge tone="warning">{CATEGORY_LABEL[f.category]}</TintBadge>{" "}
                  <span className="text-sm text-slate-800">{f.label}</span>{" "}
                  <CoverageBadge coverageCount={f.coverageCount} totalModels={f.totalModels} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 4. Causal chain / mechanism — simple ordered flow, no graph editor. */}
        {causalChain.length > 0 && (
          <div className="mt-3">
            <SectionLabel>How it happens</SectionLabel>
            <ul>
              {causalChain.map((link) => (
                <CausalLinkRow key={link.id} link={link} />
              ))}
            </ul>
          </div>
        )}

        {/* 5. Alternative explanations — visually separate from causes. */}
        {alternativeExplanations.length > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <SectionLabel>Alternative explanations</SectionLabel>
            <ul>
              {alternativeExplanations.map((f) => (
                <FactorRow key={f.id} factor={f} />
              ))}
            </ul>
          </div>
        )}

        {/* 6. Confounders. */}
        {confounders.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Confounders</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {confounders.map((c, idx) => (
                <li key={idx}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 7. Disputed interpretations — distinct treatment, never filtered by coverage. */}
        {disputedInterpretations.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <SectionLabel>Disputed interpretations</SectionLabel>
            <ul className="space-y-1.5">
              {disputedInterpretations.map((d, idx) => (
                <li key={idx} className="text-sm text-amber-900">
                  {d.label}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {d.supportingModels.map((modelId) => (
                      <ModelChip key={modelId} modelId={modelId} size="xs" />
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 8. Unknowns. */}
        {unknowns.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Unknowns</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {unknowns.map((u, idx) => (
                <li key={idx}>{u}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 9. Evidence / tests needed. */}
        {testsOrEvidenceNeeded.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Evidence that would help</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {testsOrEvidenceNeeded.map((t, idx) => (
                <li key={idx}>{t}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 10. Collapsible model-level detail — never primary. */}
        <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Panel detail ({totalModels} model{totalModels === 1 ? "" : "s"})
          </summary>
          <p className="mt-1.5 text-xs text-slate-500">
            Coverage badges above show how many models converged on each point — this reflects panel agreement, not independent proof of
            causality.
          </p>
          {contributingModels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {contributingModels.map((modelId) => (
                <ModelChip key={modelId} modelId={modelId} size="xs" />
              ))}
            </div>
          )}
        </details>
      </Card>
    </div>
  );
}
