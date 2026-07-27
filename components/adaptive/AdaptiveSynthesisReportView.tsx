"use client";

/**
 * Adaptive Synthesis Report tab (R1e/R4).
 *
 * Always renders: Unified Answer, Panel Verdict, gate banner, the
 * agreement/disagreement map (claims sorted by agreementScore, green to
 * red), a certainty gauge, then schema-adaptive narrative sections. Per-model
 * Uncertainties/Follow-ups fields are intentionally NOT duplicated here —
 * they already render inside the schema-specific Compare View block
 * (GenericSectionsView, ConsensusMapView, etc.) and stay there.
 */

import { AlignedClaim, AdaptiveGateResult, AdaptiveSynthesisReport, AdaptiveTrustSummary } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel, ProbabilityBar, getModelLabel } from "./shared";
import ModelChip from "@/components/ModelChip";

const GATE_STYLES: Record<AdaptiveGateResult["status"], { label: string; className: string }> = {
  pass: { label: "Verified — panel converges", className: "bg-green-50 text-green-800 border-green-200" },
  caution: { label: "Caution — partial convergence", className: "bg-amber-50 text-amber-800 border-amber-200" },
  fail: { label: "Could not verify — panel split", className: "bg-red-50 text-red-800 border-red-200" },
};

function GateBanner({ gate }: { gate: AdaptiveGateResult["status"] }) {
  const style = GATE_STYLES[gate];
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${style.className}`}>{style.label}</div>
  );
}

function agreementColorClass(score: number): string {
  if (score >= 0.7) return "bg-green-500";
  if (score >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

function AgreementDisagreementMap({ claims }: { claims: AlignedClaim[] }) {
  if (claims.length === 0) return null;
  const sorted = [...claims].sort((a, b) => b.agreementScore - a.agreementScore);

  return (
    <Card>
      <SectionLabel>Agreement / disagreement map</SectionLabel>
      <div className="space-y-2">
        {sorted.map((claim) => {
          const supportCount = claim.cells.filter((c) => c && (c.stance === "agrees" || c.stance === "partial")).length;
          const totalCount = claim.cells.filter(Boolean).length;
          return (
            <div key={claim.id} className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 truncate">{claim.claimText}</p>
                <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden mt-1">
                  <div
                    className={`h-full ${agreementColorClass(claim.agreementScore)}`}
                    style={{ width: `${Math.round(claim.agreementScore * 100)}%` }}
                  />
                </div>
              </div>
              <span className="shrink-0 text-xs text-slate-500 whitespace-nowrap">
                {supportCount}/{totalCount}
                {claim.disagreementType ? ` · ${claim.disagreementType.replace(/_/g, " ")}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const PARSE_HEALTH_STYLES: Record<string, string> = {
  ok: "bg-green-50 text-green-700 border-green-200",
  degraded: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

function TrustSummaryCard({ trustSummary }: { trustSummary: AdaptiveTrustSummary }) {
  if (trustSummary.perModel.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <SectionLabel>Trust summary</SectionLabel>
        <span className="text-xs font-semibold text-slate-600">
          Overall {Math.round(trustSummary.overallTrust * 100)}%
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="pb-2 pr-4">Model</th>
              <th className="pb-2 pr-4">Trust</th>
              <th className="pb-2 pr-4">Claims</th>
              <th className="pb-2 pr-4">Majority align.</th>
              <th className="pb-2 pr-4">Citations</th>
              <th className="pb-2 pr-4">Contradictions</th>
              <th className="pb-2">Health</th>
            </tr>
          </thead>
          <tbody>
            {trustSummary.perModel.map((m) => (
              <tr key={m.modelId} className="border-t border-slate-100">
                <td className="py-1.5 pr-4">
                  <ModelChip modelId={m.modelId} size="xs" />
                </td>
                <td className="py-1.5 pr-4 font-medium text-slate-800">{Math.round(m.trustScore * 100)}%</td>
                <td className="py-1.5 pr-4 text-slate-600">{m.claimsContributed}</td>
                <td className="py-1.5 pr-4 text-slate-600">{Math.round(m.majorityAlignment * 100)}%</td>
                <td className="py-1.5 pr-4 text-slate-600">{Math.round(m.citationScore * 100)}%</td>
                <td className="py-1.5 pr-4 text-slate-600">{m.contradictionCount}</td>
                <td className="py-1.5">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${PARSE_HEALTH_STYLES[m.parseHealth]}`}
                  >
                    {m.parseHealth}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default function AdaptiveSynthesisReportView({
  report,
  gate,
  alignedClaims,
  trustSummary,
}: {
  report: AdaptiveSynthesisReport;
  gate: AdaptiveGateResult;
  alignedClaims?: AlignedClaim[];
  trustSummary?: AdaptiveTrustSummary;
}) {
  const rows = alignedClaims || [];

  return (
    <div className="space-y-4">
      <GateBanner gate={gate.status} />

      <Card>
        <SectionLabel>Unified answer</SectionLabel>
        <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-line">{report.unifiedAnswer}</p>
      </Card>

      <Card className="bg-slate-50">
        <p className="text-sm font-medium text-slate-900">{report.panelVerdict}</p>
      </Card>

      <Card>
        <SectionLabel>Certainty</SectionLabel>
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <ProbabilityBar probability={report.runCertainty} colorClass={agreementColorClass(report.runCertainty)} />
          </div>
          <span className="text-sm font-semibold text-slate-700">{Math.round(report.runCertainty * 100)}%</span>
        </div>
        <p className="mt-2 text-sm text-slate-600">{report.certaintyAssessment}</p>
      </Card>

      {trustSummary && <TrustSummaryCard trustSummary={trustSummary} />}

      <AgreementDisagreementMap claims={rows} />

      {report.whereModelsAgree.length > 0 && (
        <Card>
          <SectionLabel>Where models agree</SectionLabel>
          <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
            {report.whereModelsAgree.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </Card>
      )}

      {report.whereModelsDisagree.length > 0 && (
        <Card>
          <SectionLabel>Where models disagree</SectionLabel>
          <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
            {report.whereModelsDisagree.map((item, idx) => (
              <li key={idx}>{item}</li>
            ))}
          </ul>
        </Card>
      )}

      {report.narrativeSections.map((section, idx) => (
        <Card key={idx}>
          <SectionLabel>{section.title}</SectionLabel>
          <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-line">{section.body}</p>
        </Card>
      ))}

      {gate.loadBearingClaims.length > 0 && (
        <Card className="bg-slate-50">
          <SectionLabel>Load-bearing claims (top by salience)</SectionLabel>
          <ul className="space-y-1 text-sm text-slate-700">
            {gate.loadBearingClaims.map((claim) => (
              <li key={claim.id}>
                {claim.claimText} — <span className="font-medium">{claim.status}</span>
                {claim.cells.some(Boolean) && (
                  <span className="text-slate-500">
                    {" "}
                    ({claim.cells.filter(Boolean).map((c) => getModelLabel(c!.modelId)).join(", ")})
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
