"use client";

/**
 * Query-Routing Redesign, Milestone 2 — deep_research's dedicated renderer,
 * the sixth schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell, and
 * deliberately never renders a single certainty/confidence score: same
 * design discipline as CausalExplanationView — coverage badges read "N of M
 * models agree" (panel convergence), never a percentage of confidence.
 * Grouped findings, a separate disagreements section, visible source
 * coverage, and expandable panel blind spots (Bias & Blind Spots Tier 2,
 * reused as-is from coverageAudit.ts).
 */

import { AggregatedResearchFinding, DeepResearchResult } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";

const GENERAL_CATEGORY = "General";

function CoverageBadge({ coverageCount, totalModels }: { coverageCount: number; totalModels: number }) {
  return (
    <TintBadge tone={coverageCount / Math.max(totalModels, 1) >= 0.6 ? "accent" : "warning"} title="How many models raised this — not a certainty score">
      {formatModelCoverage({ covered: coverageCount, total: totalModels, mode: "covered" })}
    </TintBadge>
  );
}

function FindingRow({
  finding,
  runId,
  onVerifyClaim,
}: {
  finding: AggregatedResearchFinding;
  runId?: string | null;
  onVerifyClaim?: (args: { runId: string; claimId: string }) => void;
}) {
  // Phase 11A.4 — eligibility is exactly "the server attached a canonical
  // selector for this finding, and we know which run it came from." Never
  // derived from finding.id or this row's position in the array — those
  // are exactly the unsound schemes claimId's own design (see
  // lib/verification/claimVerificationOrigin.ts) replaced.
  const canVerify = Boolean(runId) && typeof finding.claimId === "string" && finding.claimId.length > 0;

  return (
    <li className="py-2 border-b border-slate-100 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900">{finding.title}</span>
        <CoverageBadge coverageCount={finding.coverageCount} totalModels={finding.totalModels} />
        {finding.evidenceStrength === "contested" && <TintBadge tone="danger">Contested</TintBadge>}
        {finding.sourceBacked && (
          <span className="text-[11px] text-slate-500" title="At least one contributing model cited a source for this finding">
            Source-cited
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-700">{finding.summary}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {finding.contributingModels.map((modelId) => (
            <ModelChip key={modelId} modelId={modelId} size="xs" />
          ))}
        </div>
        {canVerify && (
          <button
            type="button"
            // data-run-id/data-claim-id deliberately mirror the exact
            // values the click handler closes over — this is what
            // components/adaptive/__tests__/DeepResearchView.spec.tsx
            // asserts against (via renderToStaticMarkup, this codebase's
            // existing convention for these renderers — onClick closures
            // themselves cannot be inspected from static markup).
            data-run-id={runId}
            data-claim-id={finding.claimId}
            onClick={() => onVerifyClaim?.({ runId: runId as string, claimId: finding.claimId as string })}
            className="ml-auto text-xs font-medium text-sky-700 hover:text-sky-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1 rounded px-1"
          >
            Verify this claim
          </button>
        )}
      </div>
    </li>
  );
}

export default function DeepResearchView({
  deepResearch,
  runId,
  onVerifyClaim,
}: {
  deepResearch: DeepResearchResult;
  runId?: string | null;
  onVerifyClaim?: (args: { runId: string; claimId: string }) => void;
}) {
  const {
    executiveSummary,
    findings,
    lowConfidenceFindings,
    disagreements,
    evidenceGaps,
    openQuestions,
    panelBlindSpots,
    researchBoundaries,
    recommendedNextSteps,
    sourceCoverage,
    totalModels,
  } = deepResearch;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  const hasAnyContent =
    executiveSummary ||
    findings.length > 0 ||
    disagreements.length > 0 ||
    evidenceGaps.length > 0 ||
    openQuestions.length > 0 ||
    researchBoundaries.length > 0 ||
    recommendedNextSteps.length > 0;

  if (!hasAnyContent) {
    return <EmptyStateCard state="models_no_usable_output" schemaSpecificMessage="No research synthesis could be produced for this question." />;
  }

  const categoryGroups = new Map<string, AggregatedResearchFinding[]>();
  for (const finding of findings) {
    const category = finding.category || GENERAL_CATEGORY;
    if (!categoryGroups.has(category)) categoryGroups.set(category, []);
    categoryGroups.get(category)!.push(finding);
  }
  const isFlatFindings = categoryGroups.size <= 1;

  const contributingModels = Array.from(
    new Set([
      ...findings.flatMap((f) => f.contributingModels),
      ...disagreements.flatMap((d) => d.supportingModels),
    ])
  );

  return (
    <div className="space-y-3">
      <Card>
        {/* 1. Executive summary — answer-first. */}
        <p className="text-base font-semibold text-slate-900 leading-snug">{executiveSummary}</p>

        {/* 2. Major findings, grouped. */}
        {findings.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Findings</SectionLabel>
            {isFlatFindings ? (
              <ul>{findings.map((f) => <FindingRow key={f.id} finding={f} runId={runId} onVerifyClaim={onVerifyClaim} />)}</ul>
            ) : (
              <div className="space-y-3">
                {Array.from(categoryGroups.entries()).map(([category, items]) => (
                  <div key={category}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">{category}</p>
                    <ul>
                      {items.map((f) => (
                        <FindingRow key={f.id} finding={f} runId={runId} onVerifyClaim={onVerifyClaim} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 3. Areas of disagreement — separate from findings. */}
        {disagreements.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <SectionLabel>Areas of disagreement</SectionLabel>
            <ul className="space-y-1.5">
              {disagreements.map((d, idx) => (
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

        {/* 4. Evidence quality / source coverage — compact, grounded in real metadata. */}
        {sourceCoverage.totalFindings > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <SectionLabel>Source coverage</SectionLabel>
            <span className="text-xs text-slate-500">
              {sourceCoverage.findingsWithSources} of {sourceCoverage.totalFindings} findings are source-cited
            </span>
          </div>
        )}

        {/* 5. Evidence/research gaps. */}
        {evidenceGaps.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Evidence gaps</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {evidenceGaps.map((g, idx) => (
                <li key={idx}>{g}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 6. Open questions. */}
        {openQuestions.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Open questions</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {openQuestions.map((q, idx) => (
                <li key={idx}>{q}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 7. Panel blind spots — expandable, Bias & Blind Spots Tier 2. */}
        {panelBlindSpots.length > 0 && (
          <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
              Panel blind spots ({panelBlindSpots.length})
            </summary>
            <ul className="mt-2 space-y-2">
              {panelBlindSpots.map((gap, idx) => (
                <li key={idx} className="text-sm">
                  <p className="font-medium text-slate-800">{gap.dimension}</p>
                  <p className="text-xs text-slate-600">{gap.whyItMatters}</p>
                  {gap.followUpQuestion && <p className="text-xs text-sky-700 mt-0.5">{gap.followUpQuestion}</p>}
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* 8. Research boundaries. */}
        {researchBoundaries.length > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <SectionLabel>Research boundaries</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-xs text-slate-600">
              {researchBoundaries.map((b, idx) => (
                <li key={idx}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 9. Recommended next steps. */}
        {recommendedNextSteps.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Recommended next steps</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {recommendedNextSteps.map((s, idx) => (
                <li key={idx}>{s}</li>
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
            Coverage badges above show how many models converged on each point — this reflects panel agreement, not independent
            verification.
          </p>
          {contributingModels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {contributingModels.map((modelId) => (
                <ModelChip key={modelId} modelId={modelId} size="xs" />
              ))}
            </div>
          )}
          {lowConfidenceFindings.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              {lowConfidenceFindings.length} additional lower-confidence finding{lowConfidenceFindings.length === 1 ? "" : "s"}, raised
              by only 1-2 models, omitted above.
            </p>
          )}
        </details>
      </Card>
    </div>
  );
}
