"use client";

/**
 * Query-Routing Redesign, Milestone 2 — definition_explanation's dedicated
 * renderer, the third schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell, and
 * deliberately answer-first: direct answer, then explanation, then
 * example/analogy, then distinctions/process, then misconceptions, then a
 * collapsed advanced-detail section, then related concepts/sources — no
 * Trust Summary, Agreement Map, or Panel Verdict, since this schema never
 * computes a claim-agreement score (see definitionAlignment.ts's header
 * comment for why). Model-level attribution is present but collapsible,
 * never the primary content.
 */

import { AggregatedDefinitionInterpretation, DefinitionExplanationResult } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";

function CoverageBadge({ interpretation }: { interpretation: AggregatedDefinitionInterpretation }) {
  const label = formatModelCoverage({ covered: interpretation.coverageCount, total: interpretation.totalModels, mode: "covered" });
  return (
    <TintBadge tone={interpretation.coverageRatio >= 0.6 ? "accent" : "warning"} title={label}>
      {label}
    </TintBadge>
  );
}

function PrimaryInterpretation({ interpretation }: { interpretation: AggregatedDefinitionInterpretation }) {
  const hasDistinctionsOrSteps = interpretation.distinctions.length > 0 || interpretation.processSteps.length > 0;
  const hasFooter = interpretation.relatedConcepts.length > 0 || interpretation.sources.length > 0 || interpretation.contributingModels.length > 0;

  return (
    <Card>
      {interpretation.term !== "none" && <SectionLabel>{interpretation.term}</SectionLabel>}

      {/* 1. Direct answer — answer-first. */}
      <p className="text-base font-semibold text-slate-900 leading-snug">{interpretation.directAnswer}</p>

      {/* 2. Plain explanation. */}
      <p className="mt-2 text-sm text-slate-700 leading-relaxed">{interpretation.explanation}</p>

      {interpretation.keyPoints.length > 0 && (
        <ul className="mt-2 list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
          {interpretation.keyPoints.map((point, idx) => (
            <li key={idx}>{point}</li>
          ))}
        </ul>
      )}

      {/* 3. Example / analogy (with limits callout). */}
      {interpretation.example && (
        <p className="mt-3 text-sm text-slate-700">
          <span className="font-medium text-slate-500">Example: </span>
          {interpretation.example}
        </p>
      )}
      {interpretation.analogy && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-sm text-slate-700">{interpretation.analogy.text}</p>
          {interpretation.analogy.limits && (
            <p className="mt-1 text-xs text-amber-700">
              <span className="font-medium">Where this analogy breaks down: </span>
              {interpretation.analogy.limits}
            </p>
          )}
        </div>
      )}

      {/* 4. Distinctions / process steps. */}
      {hasDistinctionsOrSteps && (
        <div className="mt-3 space-y-3">
          {interpretation.distinctions.length > 0 && (
            <div>
              <SectionLabel>Distinctions</SectionLabel>
              <dl className="space-y-1.5">
                {interpretation.distinctions.map((d, idx) => (
                  <div key={idx} className="text-sm">
                    <dt className="font-medium text-slate-800 inline">{d.concept}: </dt>
                    <dd className="inline text-slate-700">{d.explanation}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {interpretation.processSteps.length > 0 && (
            <div>
              <SectionLabel>How it works</SectionLabel>
              <ol className="space-y-1.5">
                {interpretation.processSteps.map((step) => (
                  <li key={step.number} className="text-sm text-slate-700">
                    <span className="font-medium text-slate-800">{step.number}. {step.title} — </span>
                    {step.explanation}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {/* 5. Misconceptions. */}
      {interpretation.commonMisconceptions.length > 0 && (
        <div className="mt-3">
          <SectionLabel>Common misconceptions</SectionLabel>
          <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
            {interpretation.commonMisconceptions.map((m, idx) => (
              <li key={idx}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 6. Advanced detail — collapsible, never primary. */}
      {interpretation.advancedDetail && (
        <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Advanced detail</summary>
          <p className="mt-1.5 text-sm text-slate-700 leading-relaxed">{interpretation.advancedDetail}</p>
        </details>
      )}

      {/* 7. Related concepts / sources / model attribution — footer, collapsible. */}
      {hasFooter && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
          <CoverageBadge interpretation={interpretation} />
          {interpretation.relatedConcepts.map((c, idx) => (
            <span key={idx} className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {c}
            </span>
          ))}
          {interpretation.sources.length > 0 && (
            <details className="w-full">
              <summary className="cursor-pointer text-xs text-slate-500">Sources ({interpretation.sources.length})</summary>
              <ul className="mt-1 list-disc list-outside pl-5 text-xs text-slate-600">
                {interpretation.sources.map((s, idx) => (
                  <li key={idx}>{s}</li>
                ))}
              </ul>
            </details>
          )}
          {interpretation.contributingModels.length > 0 && (
            <details className="w-full">
              <summary className="cursor-pointer text-xs text-slate-500">Contributing models ({interpretation.contributingModels.length})</summary>
              <div className="mt-1 flex flex-wrap gap-1">
                {interpretation.contributingModels.map((modelId) => (
                  <ModelChip key={modelId} modelId={modelId} size="xs" />
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}

const AMBIGUITY_BANNER =
  "This term has more than one accepted meaning across the panel. Showing the most-supported interpretation below, plus the others the panel found — none is presented as the single correct answer.";

export default function DefinitionExplanationView({ definitionExplanation }: { definitionExplanation: DefinitionExplanationResult }) {
  const { primary, alternateInterpretations, isAmbiguous, totalModels } = definitionExplanation;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  if (!primary) {
    return <EmptyStateCard state="models_no_usable_output" schemaSpecificMessage="No definition could be produced for this question." />;
  }

  return (
    <div className="space-y-3">
      {isAmbiguous && (
        <Card className="bg-amber-50 border-amber-200">
          <p className="text-xs text-amber-900 leading-relaxed">{AMBIGUITY_BANNER}</p>
        </Card>
      )}

      <PrimaryInterpretation interpretation={primary} />

      {alternateInterpretations.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Other meanings the panel found ({alternateInterpretations.length})
          </summary>
          <div className="mt-2 space-y-2">
            {alternateInterpretations.map((interpretation, idx) => (
              <div key={idx} className="rounded-lg border border-slate-100 p-2.5">
                {interpretation.term !== "none" && <p className="text-xs font-semibold text-slate-600">{interpretation.term}</p>}
                <p className="text-sm text-slate-800">{interpretation.directAnswer}</p>
                <div className="mt-1">
                  <CoverageBadge interpretation={interpretation} />
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
