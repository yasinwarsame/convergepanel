"use client";

/**
 * Query-Routing Redesign, Milestone 2 — evidence_review's dedicated
 * renderer, the seventh schema activated behind the new taxonomy.
 *
 * Deliberately NOT the claims-matrix/synthesis-report shell. Same design
 * discipline as CausalExplanationView: every strength label here reflects
 * the panel's OWN judgment about evidence quality — a coverage badge reads
 * "N of M models agree", never a certainty percentage, and overallStrength
 * is a roll-up of per-dimension model judgments, never a popularity count.
 */

import { AggregatedEvidenceDimension, EvidenceReviewResult, RiskLevel } from "@/lib/adaptiveSchema/types";
import { Card, EmptyStateCard, SectionLabel, TintBadge, formatModelCoverage } from "./shared";
import ModelChip from "@/components/ModelChip";

function StrengthBadge({ strength }: { strength: AggregatedEvidenceDimension["strength"] }) {
  if (strength === "unknown") return null;
  const tone = strength === "strong" ? "accent" : strength === "contested" ? "danger" : "warning";
  const label = strength.charAt(0).toUpperCase() + strength.slice(1);
  return <TintBadge tone={tone}>{label}</TintBadge>;
}

function CoverageBadge({ coverageCount, totalModels }: { coverageCount: number; totalModels: number }) {
  return (
    <TintBadge tone={coverageCount / Math.max(totalModels, 1) >= 0.6 ? "accent" : "warning"} title="How many models raised this dimension — not a certainty score">
      {formatModelCoverage({ covered: coverageCount, total: totalModels, mode: "covered" })}
    </TintBadge>
  );
}

/** Milestone 2 UI consistency cleanup — sourceBacked was already computed but never rendered, despite materially affecting how an evidence review should be read. Placed right next to the overall assessment, phrased as an evidence-support signal, never a confidence/certainty score. */
function SourceBackedBadge({ sourceBacked }: { sourceBacked: boolean }) {
  return (
    <TintBadge
      tone={sourceBacked ? "accent" : "warning"}
      title="Whether at least one contributing model cited a source — not a measure of how strong or reliable that source is"
    >
      {sourceBacked ? "Source-backed assessment" : "No source support captured"}
    </TintBadge>
  );
}

function DimensionRow({ dimension }: { dimension: AggregatedEvidenceDimension }) {
  return (
    <li className="py-2 border-b border-slate-100 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-900">{dimension.dimension}</span>
        <StrengthBadge strength={dimension.strength} />
        <CoverageBadge coverageCount={dimension.coverageCount} totalModels={dimension.totalModels} />
      </div>
      <p className="mt-1 text-sm text-slate-700">{dimension.assessment}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {dimension.contributingModels.map((modelId) => (
          <ModelChip key={modelId} modelId={modelId} size="xs" />
        ))}
      </div>
    </li>
  );
}

const HIGH_STAKES_RISK_LEVELS = new Set<RiskLevel>(["safety_critical", "high_stakes"]);

export default function EvidenceReviewView({
  evidenceReview,
  riskLevel,
}: {
  evidenceReview: EvidenceReviewResult;
  riskLevel?: RiskLevel;
}) {
  const {
    overallAssessment,
    overallStrength,
    dimensions,
    lowConfidenceDimensions,
    redFlags,
    strengths,
    applicabilityCaveats,
    recommendedChecks,
    sourceBacked,
    totalModels,
  } = evidenceReview;

  if (totalModels === 0) {
    return <EmptyStateCard state="no_models" />;
  }

  const hasAnyContent =
    overallAssessment ||
    dimensions.length > 0 ||
    redFlags.length > 0 ||
    strengths.length > 0 ||
    applicabilityCaveats.length > 0 ||
    recommendedChecks.length > 0;

  if (!hasAnyContent) {
    return <EmptyStateCard state="models_no_usable_output" schemaSpecificMessage="No evidence review could be produced for this question." />;
  }

  const contributingModels = Array.from(new Set(dimensions.flatMap((d) => d.contributingModels)));

  return (
    <div className="space-y-3">
      {riskLevel && HIGH_STAKES_RISK_LEVELS.has(riskLevel) && (
        <Card className="bg-amber-50 border-amber-200">
          <p className="text-xs text-amber-900 leading-relaxed">
            This touches a high-stakes domain — treat this evidence review as a starting point, not a substitute for professional or
            expert review.
          </p>
        </Card>
      )}

      <Card>
        {/* Answer-first overall assessment. */}
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-base font-semibold text-slate-900 leading-snug">{overallAssessment}</p>
          <StrengthBadge strength={overallStrength} />
          <SourceBackedBadge sourceBacked={sourceBacked} />
        </div>

        {/* Dimension breakdown. */}
        {dimensions.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Quality dimensions</SectionLabel>
            <ul>
              {dimensions.map((d) => (
                <DimensionRow key={d.id} dimension={d} />
              ))}
            </ul>
          </div>
        )}

        {/* Red flags. */}
        {redFlags.length > 0 && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
            <SectionLabel>Red flags</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-red-800">
              {redFlags.map((f, idx) => (
                <li key={idx}>{f}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Positive credibility signals. */}
        {strengths.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Strengths</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {strengths.map((s, idx) => (
                <li key={idx}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Applicability caveats. */}
        {applicabilityCaveats.length > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <SectionLabel>Applicability caveats</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-xs text-slate-600">
              {applicabilityCaveats.map((c, idx) => (
                <li key={idx}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Recommended checks. */}
        {recommendedChecks.length > 0 && (
          <div className="mt-3">
            <SectionLabel>Recommended checks</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm text-slate-700">
              {recommendedChecks.map((c, idx) => (
                <li key={idx}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Collapsible model-level detail — never primary. */}
        <details className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
            Panel detail ({totalModels} model{totalModels === 1 ? "" : "s"})
          </summary>
          <p className="mt-1.5 text-xs text-slate-500">
            Coverage badges above show how many models raised each dimension — this reflects panel agreement, not independent
            verification of evidence quality.
          </p>
          {contributingModels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {contributingModels.map((modelId) => (
                <ModelChip key={modelId} modelId={modelId} size="xs" />
              ))}
            </div>
          )}
          {lowConfidenceDimensions.length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              {lowConfidenceDimensions.length} additional lower-confidence dimension{lowConfidenceDimensions.length === 1 ? "" : "s"},
              raised by only 1-2 models, omitted above.
            </p>
          )}
        </details>
      </Card>
    </div>
  );
}
