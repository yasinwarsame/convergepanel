"use client";

/**
 * Query-Routing Redesign, Milestone 2 — bias_blindspot_audit's dedicated
 * renderer, the eighth schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell, and
 * deliberately never renders a "bias score" — Tier 1/Tier 2/Tier 3 are kept
 * visually distinct sections, matching the embedded system's own tiering.
 * Tier 1 reuses `BiasFindingCards` verbatim (AdaptiveSynthesisReportView.tsx)
 * since this schema's `attributedBiases` is the exact same
 * `AdaptiveBiasFinding[]` shape, produced by the exact same
 * `detectAdaptiveBiases` call.
 */

import { AggregatedPanelBlindSpot, BiasBlindspotAuditResult, BiasStructuralDiagnostics } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge } from "./shared";
import { BiasFindingCards } from "./AdaptiveSynthesisReportView";
import { BIAS_EMPTY_REASON_LABELS } from "@/lib/adaptiveSchema/config";

function BlindSpotCard({ blindSpot, onRunFollowUp }: { blindSpot: AggregatedPanelBlindSpot; onRunFollowUp?: (question: string) => void }) {
  return (
    <div className="rounded-lg bg-sky-50 border border-sky-200 p-4">
      <h3 className="text-sky-900 font-semibold mb-1">{blindSpot.missingDimension}</h3>
      {blindSpot.whyItMatters && <p className="text-sm text-sky-800 mb-2">{blindSpot.whyItMatters}</p>}
      <p className="text-xs text-sky-600 mb-2">{blindSpot.coverageReason}</p>
      {blindSpot.followUpQuestion && (
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <p className="text-xs text-sky-700 italic flex-1 min-w-[12rem]">&ldquo;{blindSpot.followUpQuestion}&rdquo;</p>
          {onRunFollowUp && (
            <button
              type="button"
              onClick={() => onRunFollowUp(blindSpot.followUpQuestion!)}
              className="shrink-0 rounded-lg border border-sky-300 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100"
            >
              Run follow-up
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Tier 3 — compact, scannable inline stats, never cards. Homogeneity warning is prominent but framed as an explanatory caveat, not an alarm. */
function StructuralDiagnosticsStrip({ diagnostics }: { diagnostics: BiasStructuralDiagnostics }) {
  const { citationCoverage, sourceConcentration, homogeneityFlag, homogeneityMessage } = diagnostics;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {citationCoverage.totalModels > 0 && (
          <TintBadge tone={citationCoverage.ratio < 0.5 ? "warning" : "accent"}>
            Citations: {citationCoverage.modelsWithSources} of {citationCoverage.totalModels} models cite a source
          </TintBadge>
        )}
        {sourceConcentration && (
          <TintBadge tone={sourceConcentration.concentrationRatio >= 0.75 ? "warning" : "accent"} title={`${sourceConcentration.distinctSources} distinct sources across ${sourceConcentration.totalCitations} citations`}>
            Source concentration: {Math.round(sourceConcentration.concentrationRatio * 100)}%
          </TintBadge>
        )}
      </div>
      {homogeneityFlag && homogeneityMessage && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs text-amber-900 leading-relaxed">{homogeneityMessage}</p>
        </div>
      )}
    </div>
  );
}

export default function BiasBlindspotAuditView({
  biasBlindspotAudit,
  onRunFollowUp,
}: {
  biasBlindspotAudit: BiasBlindspotAuditResult;
  onRunFollowUp?: (question: string) => void;
}) {
  const {
    summary,
    attributedBiases,
    biasEmptyReason,
    panelBlindSpots,
    sharedAssumptions,
    missingStakeholders,
    structuralDiagnostics,
    followUpQuestions,
    totalModels,
  } = biasBlindspotAudit;

  const hasT1 = attributedBiases.length > 0;
  const hasT2 = panelBlindSpots.length > 0;
  // A "0 of N models cite a source" stat isn't meaningful content on its
  // own — only count Tier 3 as present when there's an actual signal
  // (some citation coverage, a concentration ratio, or a homogeneity flag).
  const hasT3 =
    structuralDiagnostics.citationCoverage.modelsWithSources > 0 ||
    !!structuralDiagnostics.sourceConcentration ||
    structuralDiagnostics.homogeneityFlag;

  // Tier 1's OWN "no model-specific bias was confidently attributable"
  // message is itself meaningful content, per the safeguard that an empty
  // Tier 1 must never look like a generic empty state — so the true
  // "nothing at all" case is reserved for when the schema never had any
  // models to work with in the first place, not for when every tier
  // legitimately came back empty/explained.
  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  return (
    <div className="space-y-3">
      <Card>
        {/* 1. Summary — answer-first. */}
        {summary && <p className="text-base font-semibold text-slate-900 leading-snug">{summary}</p>}

        {/* 2. Tier 1 — attributed model-specific bias, visually distinct. A lack of findings is never silently blank. */}
        <div className="mt-3">
          <SectionLabel>Attributed model-specific bias</SectionLabel>
          {hasT1 ? (
            <BiasFindingCards findings={attributedBiases} />
          ) : (
            <p className="text-sm text-slate-500 italic">
              No model-specific bias was confidently attributable
              {biasEmptyReason ? ` (${BIAS_EMPTY_REASON_LABELS[biasEmptyReason]})` : ""}. This does not mean the answer is unbiased —
              see the panel-level and structural signals below.
            </p>
          )}
        </div>

        {/* 3. Tier 2 — panel-level omissions, visually distinct, renders independently of Tier 1. */}
        {hasT2 && (
          <div className="mt-3">
            <SectionLabel>What the panel did not cover</SectionLabel>
            <div className="space-y-3">
              {panelBlindSpots.map((b) => (
                <BlindSpotCard key={b.id} blindSpot={b} onRunFollowUp={onRunFollowUp} />
              ))}
            </div>
          </div>
        )}

        {/* 4. Shared assumptions. */}
        {sharedAssumptions.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Shared assumptions</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {sharedAssumptions.map((a, idx) => (
                <li key={idx}>{a}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 5. Missing stakeholders or perspectives. */}
        {missingStakeholders.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Missing stakeholders or perspectives</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {missingStakeholders.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 6. Tier 3 — structural diagnostics, compact and scannable. */}
        {hasT3 && (
          <div className="mt-3">
            <SectionLabel>Structural diagnostics</SectionLabel>
            <StructuralDiagnosticsStrip diagnostics={structuralDiagnostics} />
          </div>
        )}

        {/* 7. Follow-up questions. */}
        {followUpQuestions.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Follow-up questions</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {followUpQuestions.map((q, idx) => (
                <li key={idx}>{q}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 8. Collapsible model-level detail — never primary. */}
        <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Panel detail ({totalModels} model{totalModels === 1 ? "" : "s"})
          </summary>
          <p className="mt-1.5 text-xs text-slate-500">
            Tier 1 is an independent audit of each model&apos;s own raw response; Tier 2 combines that same audit with what models
            self-reported as missing; Tier 3 is computed directly from the panel&apos;s responses. None of these convert model
            agreement into proof of neutrality.
          </p>
        </details>
      </Card>
    </div>
  );
}
