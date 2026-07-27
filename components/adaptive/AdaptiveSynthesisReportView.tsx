"use client";

/**
 * Adaptive Synthesis Report tab (R1e/R4, extended by Synthesis Report Polish
 * Part A, then restored+extended again after Part A's layout assembly
 * regressed Unified Answer + Trust Summary).
 *
 * Order (each wrapped in a `data-section` marker — see
 * ADAPTIVE_SYNTHESIS_SECTION_IDS below, kept in sync with this list):
 * gate banner → Unified Answer (deterministic, citation-attributed) →
 * Executive Summary (A1, prose) → Certainty → Trust Summary table (per-model
 * trust/claims/majority-align/citations/contradictions/health) →
 * Agreement/Disagreement map (stakes tags + per-model agree/dispute/silent
 * chips, A5) → Where models agree → Disagreements (A2 — orange cards with
 * per-model quoted positions) → Bias & Blind Spots (A3 — amber cards) →
 * schema-adaptive narrative sections → load-bearing claims → Panel Verdict
 * Card (A4) → disclaimer → export actions — mirroring the legacy
 * PanelSynthesisView.tsx layout order. Sections added here are ADDITIVE:
 * nothing that rendered before Part A may be dropped by a later change.
 */

import { useCallback, useState } from "react";
import { ModelId } from "@/lib/types";
import {
  AlignedClaim,
  AlignedClaimCell,
  AdaptiveGateResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  ModelTrustSummary,
} from "@/lib/adaptiveSchema/types";
import { TRUST_SCORE_CAP_REASON } from "@/lib/adaptiveSchema/config";

/** Canonical, ordered list of `data-section` values rendered below — the single source of truth the snapshot test asserts against, so a future edit can't silently drop a section without also updating this list. */
export const ADAPTIVE_SYNTHESIS_SECTION_IDS = [
  "gate-banner",
  "unified-answer",
  "executive-summary",
  "certainty",
  "trust-summary",
  "agreement-disagreement-map",
  "single-model-insights",
  "where-models-agree",
  "disagreements",
  "bias-blind-spots",
  "narrative-sections",
  "load-bearing-claims",
  "panel-verdict",
  "disclaimer",
  "export-actions",
] as const;
import { Card, SectionLabel, ProbabilityBar, StakesBadge, getModelLabel } from "./shared";
import ModelChip from "@/components/ModelChip";
import { classifyClaimSeverity } from "@/lib/verificationGate/claimSeverity";
import { VerificationActions } from "@/components/VerificationActions";
import { generateVerificationMemo, downloadTextFile } from "@/lib/verification/generateMemo";
import { copyToClipboardWithFallback } from "@/lib/ui/copyFormats";
import {
  buildAdaptiveSynthesisMarkdown,
  buildAdaptiveMemoInput,
  buildAdaptiveLinkedInPost,
  buildAdaptiveXPost,
} from "@/lib/adaptiveSchema/shareBuilders";

const GATE_STYLES: Record<AdaptiveGateResult["status"], { label: string; className: string }> = {
  pass: { label: "Verified — panel converges", className: "bg-green-50 text-green-800 border-green-200" },
  caution: { label: "Caution — partial convergence", className: "bg-amber-50 text-amber-800 border-amber-200" },
  fail: { label: "Could not verify — panel split", className: "bg-red-50 text-red-800 border-red-200" },
};

const GATE_BADGE_STYLES: Record<AdaptiveGateResult["status"], string> = {
  pass: "bg-green-50 text-green-700 border-green-200",
  caution: "bg-amber-50 text-amber-700 border-amber-200",
  fail: "bg-red-50 text-red-700 border-red-200",
};

const GATE_ACCENT: Record<AdaptiveGateResult["status"], string> = {
  pass: "bg-emerald-400",
  caution: "bg-amber-400",
  fail: "bg-red-400",
};

function GateBanner({ gate }: { gate: AdaptiveGateResult["status"] }) {
  const style = GATE_STYLES[gate];
  return <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${style.className}`}>{style.label}</div>;
}

function agreementColorClass(score: number): string {
  if (score >= 0.7) return "bg-green-500";
  if (score >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

function UnifiedAnswerCard({ answer }: { answer: string }) {
  return (
    <Card className="bg-sky-50/60 border-sky-200">
      <SectionLabel>Unified answer</SectionLabel>
      <p className="text-sm leading-relaxed text-slate-900 whitespace-pre-line">{answer}</p>
    </Card>
  );
}

const PARSE_HEALTH_STYLES: Record<ModelTrustSummary["parseHealth"], string> = {
  ok: "bg-green-50 text-green-700 border-green-200",
  degraded: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

function TrustSummaryTable({ trustSummary }: { trustSummary: AdaptiveTrustSummary }) {
  if (trustSummary.perModel.length === 0) return null;
  return (
    <Card>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <SectionLabel>Trust summary</SectionLabel>
        <span className="text-xs font-semibold text-slate-600">
          Panel reliability: {Math.round(trustSummary.overallTrust * 100)}%
        </span>
      </div>
      <p className="text-xs text-slate-500 mb-2">How well the models behaved — citations, consistency, contradictions — not how sure the panel is about the answer.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-4 font-medium">Model</th>
              <th className="py-2 pr-4 font-medium">Trust</th>
              <th className="py-2 pr-4 font-medium">Claims</th>
              <th className="py-2 pr-4 font-medium">Majority align</th>
              <th className="py-2 pr-4 font-medium">Citations</th>
              <th className="py-2 pr-4 font-medium">Contradictions</th>
              <th className="py-2 pr-4 font-medium">Health</th>
            </tr>
          </thead>
          <tbody>
            {trustSummary.perModel.map((m) => (
              <tr key={m.modelId} className="border-b border-slate-100 last:border-0">
                <td className="py-2 pr-4">
                  <ModelChip modelId={m.modelId} size="xs" />
                </td>
                <td className="py-2 pr-4 font-medium text-slate-800">
                  {Math.round(m.trustScore * 100)}%
                  {m.capped && TRUST_SCORE_CAP_REASON[m.parseHealth] && (
                    <span
                      className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-100 text-[9px] font-bold text-amber-700 cursor-help align-text-top"
                      title={TRUST_SCORE_CAP_REASON[m.parseHealth]!}
                    >
                      !
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-700">{m.claimsContributed}</td>
                <td className="py-2 pr-4 text-slate-700">{Math.round(m.majorityAlignment * 100)}%</td>
                <td className="py-2 pr-4 text-slate-700">{Math.round(m.citationScore * 100)}%</td>
                <td className="py-2 pr-4 text-slate-700">{m.contradictionCount}</td>
                <td className="py-2 pr-4">
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

function ExecutiveSummaryCard({ summary }: { summary: string }) {
  const paragraphs = summary.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return (
    <Card>
      <SectionLabel>Executive summary</SectionLabel>
      <div className="space-y-3 text-sm leading-relaxed text-slate-800">
        {(paragraphs.length > 0 ? paragraphs : [summary]).map((p, idx) => (
          <p key={idx} className="whitespace-pre-line">
            {p}
          </p>
        ))}
      </div>
    </Card>
  );
}

/** Model buckets for one claim row, normalized against the FULL panel (not just respondents) — "unclear" cells count as silent since the reader can't tell whether that model agreed or disputed. */
function bucketModelsByStance(
  claim: AlignedClaim,
  modelsUsed: ModelId[]
): { agreeModels: ModelId[]; disputeModels: ModelId[]; silentModels: ModelId[] } {
  const nonNullCells = claim.cells.filter((c): c is AlignedClaimCell => !!c);
  const agreeModels = nonNullCells.filter((c) => c.stance === "agrees" || c.stance === "partial").map((c) => c.modelId);
  const disputeModels = nonNullCells.filter((c) => c.stance === "disputes").map((c) => c.modelId);
  const respondedWithStance = new Set([...agreeModels, ...disputeModels]);
  const silentModels = modelsUsed.filter((m) => !respondedWithStance.has(m));
  return { agreeModels, disputeModels, silentModels };
}

/** "2 of 5 agree · 1 dispute · 2 silent" — plain counts against the full panel, not a same-denominator fraction like "2/2" that hides how many models were silent. */
function agreementLabel(agreeCount: number, disputeCount: number, silentCount: number, total: number): string {
  const parts = [`${agreeCount} of ${total} agree`];
  if (disputeCount > 0) parts.push(`${disputeCount} dispute${disputeCount === 1 ? "" : "s"}`);
  if (silentCount > 0) parts.push(`${silentCount} silent`);
  return parts.join(" · ");
}

/** Three-segment bar (agree/dispute/silent), always normalized to the full panel size — segments always sum to 100% of the bar width, so a low-coverage claim visibly shows more silent than a fully-covered one instead of stretching a thin agreement score across the whole bar. */
function AgreementSegmentBar({ agreeCount, disputeCount, silentCount, total }: { agreeCount: number; disputeCount: number; silentCount: number; total: number }) {
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="h-1.5 w-full rounded-full overflow-hidden mt-1 flex">
      <div className="h-full bg-green-500" style={{ width: `${pct(agreeCount)}%` }} />
      <div className="h-full bg-orange-500" style={{ width: `${pct(disputeCount)}%` }} />
      <div className="h-full bg-slate-300" style={{ width: `${pct(silentCount)}%` }} />
    </div>
  );
}

const STATUS_SORT_ORDER: Record<"consensus" | "majority" | "split", number> = { consensus: 0, majority: 1, split: 2 };

function AgreementDisagreementMap({ claims, modelsUsed }: { claims: AlignedClaim[]; modelsUsed: ModelId[] }) {
  // Coverage-1 claims (a single model's own claim, never corroborated or
  // disputed by anyone else) aren't agreement data — they're rendered
  // separately by SingleModelInsightsList below this section.
  const mapClaims = claims.filter((c) => c.status !== "single_source");
  if (mapClaims.length === 0) return null;

  const sorted = [...mapClaims].sort((a, b) => {
    const statusDelta = STATUS_SORT_ORDER[a.status as "consensus" | "majority" | "split"] - STATUS_SORT_ORDER[b.status as "consensus" | "majority" | "split"];
    if (statusDelta !== 0) return statusDelta;
    return b.agreementScore - a.agreementScore;
  });

  return (
    <Card>
      <SectionLabel>Agreement / disagreement map</SectionLabel>
      <div className="space-y-3">
        {sorted.map((claim) => {
          const { agreeModels, disputeModels, silentModels } = bucketModelsByStance(claim, modelsUsed);
          const isSplit = claim.status === "split";
          const severity = classifyClaimSeverity(claim.claimText, undefined, agreeModels.length + disputeModels.length, isSplit);
          return (
            <div
              key={claim.id}
              className={`space-y-1.5 ${isSplit ? "border-l-2 border-orange-400 pl-2 -ml-0.5" : ""}`}
            >
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm text-slate-800 truncate">{claim.claimText}</p>
                    <StakesBadge stakes={severity.severity} />
                  </div>
                  <AgreementSegmentBar
                    agreeCount={agreeModels.length}
                    disputeCount={disputeModels.length}
                    silentCount={silentModels.length}
                    total={modelsUsed.length}
                  />
                </div>
                <span className="shrink-0 text-xs text-slate-500 whitespace-nowrap">
                  {agreementLabel(agreeModels.length, disputeModels.length, silentModels.length, modelsUsed.length)}
                  {claim.disagreementType ? ` · ${claim.disagreementType.replace(/_/g, " ")}` : ""}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {agreeModels.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-600">Agree</span>
                    {agreeModels.map((m) => (
                      <ModelChip key={`agree-${m}`} modelId={m} size="xs" className="ring-1 ring-emerald-300" />
                    ))}
                  </div>
                )}
                {disputeModels.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-rose-600">Dispute</span>
                    {disputeModels.map((m) => (
                      <ModelChip key={`dispute-${m}`} modelId={m} size="xs" className="ring-1 ring-rose-300" />
                    ))}
                  </div>
                )}
                {silentModels.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Silent</span>
                    {silentModels.map((m) => (
                      <ModelChip key={`silent-${m}`} modelId={m} size="xs" className="opacity-50" />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Coverage-1 claims — a single model's own observation, never corroborated or disputed by any other model — pulled out of the Agreement/Disagreement Map since a lone claim isn't agreement data. */
function SingleModelInsightsList({ claims }: { claims: AlignedClaim[] }) {
  const singleSource = claims.filter((c) => c.status === "single_source");
  if (singleSource.length === 0) return null;

  return (
    <Card className="bg-slate-50">
      <SectionLabel>Single-model insights</SectionLabel>
      <p className="text-xs text-slate-500 mb-2">
        Raised by only one model in this run — not corroborated or disputed by any other model.
      </p>
      <ul className="space-y-2">
        {singleSource.map((claim) => {
          const soleCell = claim.cells.find((c): c is AlignedClaimCell => !!c);
          return (
            <li key={claim.id} className="flex items-start gap-2 text-sm">
              {soleCell && <ModelChip modelId={soleCell.modelId} size="xs" className="mt-0.5 shrink-0" />}
              <span className="text-slate-700">{claim.claimText}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function DisagreementsSection({ report }: { report: AdaptiveSynthesisReport }) {
  if (report.disagreements.length === 0) return null;

  return (
    <Card>
      <SectionLabel>Disagreements</SectionLabel>
      <div className="space-y-3">
        {report.disagreements.map((d, idx) => {
          const severity = classifyClaimSeverity(`${d.topic} ${d.whyTheyDiffer}`, undefined, undefined, true);
          return (
            <div key={idx} className="relative rounded-lg bg-orange-50 border border-orange-200 p-4">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-orange-400" />
              <div className="pl-4">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <StakesBadge stakes={d.stakes ?? severity.severity} />
                </div>
                <h3 className="text-orange-900 font-semibold mb-2">{d.topic}</h3>
                <p className="text-orange-800 mb-3 text-sm">{d.whyTheyDiffer}</p>
                <div className="space-y-2 mt-3">
                  {d.positions.map((p, posIdx) => (
                    <div key={posIdx} className="pl-3 border-l-2 border-orange-300">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-orange-900">{getModelLabel(p.modelId)}:</span>
                      </div>
                      <p className="text-sm text-orange-800">&ldquo;{p.position}&rdquo;</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function BiasBlindSpotsSection({ report }: { report: AdaptiveSynthesisReport }) {
  return (
    <Card>
      <SectionLabel>Bias &amp; blind spots</SectionLabel>
      {report.biasAndBlindSpots.length === 0 ? (
        <p className="text-sm text-slate-500 italic">
          No model-specific bias signals were confidently attributable from this run. Consider adding constraints or
          counter-sources.
        </p>
      ) : (
        <div className="space-y-3">
          {report.biasAndBlindSpots.map((b, idx) => (
            <div key={idx} className="relative rounded-lg bg-slate-50 border border-slate-300 p-4">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-amber-400" />
              <div className="pl-4">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  {b.modelsImplicated.map((m) => (
                    <ModelChip key={m} modelId={m} size="xs" />
                  ))}
                </div>
                <h3 className="text-slate-900 font-semibold mb-1">{b.biasType}</h3>
                <p className="text-sm text-slate-700 mb-3">{b.description}</p>

                {b.evidence.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {b.evidence.map((e, evIdx) => (
                      <div key={evIdx} className="pl-3 border-l-2 border-slate-300">
                        <p className="text-sm text-slate-700">
                          <span className="font-medium">{getModelLabel(e.modelId)}:</span> &ldquo;{e.excerpt}&rdquo;
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">{e.rationale}</p>
                      </div>
                    ))}
                  </div>
                )}

                {b.likelyCauses.length > 0 && (
                  <p className="text-xs text-slate-600 mb-1">
                    <span className="font-medium">Likely causes:</span> {b.likelyCauses.join("; ")}
                  </p>
                )}
                {b.impact && (
                  <p className="text-xs text-slate-600 mb-1">
                    <span className="font-medium">Impact:</span> {b.impact}
                  </p>
                )}
                {b.mitigationSteps.length > 0 && (
                  <p className="text-xs text-slate-600">
                    <span className="font-medium">Mitigation:</span> {b.mitigationSteps.join("; ")}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function PanelVerdictCard({ report, gate }: { report: AdaptiveSynthesisReport; gate: AdaptiveGateResult }) {
  const v = report.verdictCard;
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-6 overflow-hidden">
      <div className={`absolute left-0 top-0 h-1.5 w-full ${GATE_ACCENT[gate.status]}`} />

      <div className="rounded-lg bg-sky-50 border border-sky-200 px-4 py-3 text-xs text-sky-800 mb-4">
        ConvergePanel is an AI-assisted research tool, not a forensic or fact-checking authority. Synthesis informs
        judgment — it doesn&apos;t replace it.
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h3 className="text-lg font-semibold text-slate-900">Panel Verdict</h3>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${GATE_BADGE_STYLES[gate.status]}`}>
          {gate.status}
        </span>
      </div>

      <p className="text-sm font-medium text-slate-900 mb-4">{v.question}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Top consensus</span>
          <p className="text-sm text-slate-800 mt-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5" />
            {v.topConsensus}
            {v.consensusModelCount > 0 && (
              <span className="text-slate-500"> — agreed by {v.consensusModelCount} model{v.consensusModelCount === 1 ? "" : "s"}</span>
            )}
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Key disagreement</span>
          {v.keyDisagreement ? (
            <p className="text-sm text-slate-800 mt-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-500 mr-1.5" />
              {v.keyDisagreement}
              {v.disagreementDetail && <span className="block text-slate-500 mt-0.5">{v.disagreementDetail}</span>}
            </p>
          ) : (
            <p className="text-sm text-slate-500 italic mt-1">No major disagreements detected.</p>
          )}
        </div>
      </div>

      {v.caveat && (
        <div className="mb-4">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Caveat</span>
          <p className="text-sm text-slate-700 mt-1">{v.caveat}</p>
        </div>
      )}

      <div>
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Recommended next steps</span>
        <ul className="list-disc list-outside pl-5 mt-1 space-y-1 text-sm text-slate-700">
          {v.recommendedNextSteps.map((step, idx) => (
            <li key={idx}>{step}</li>
          ))}
        </ul>
      </div>

      <div data-section="disclaimer" className="mt-8 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        <p className="font-semibold text-slate-700 mb-1">Disclaimer</p>
        <p className="mb-2">
          Research results are synthesized from multiple AI language models and reflect their training data, not
          real-time or authoritative sources. AI models may produce inaccurate, incomplete, or outdated information.
          Consensus between models does not guarantee factual accuracy — models may share common biases or training
          data errors.
        </p>
        <p>
          These results are for informational purposes only and do not constitute professional advice of any kind,
          including but not limited to legal, medical, financial, or investment advice.
        </p>
      </div>
    </div>
  );
}

export default function AdaptiveSynthesisReportView({
  report,
  gate,
  alignedClaims,
  trustSummary,
  question,
  modelsUsed,
  runId,
}: {
  report: AdaptiveSynthesisReport;
  gate: AdaptiveGateResult;
  alignedClaims?: AlignedClaim[];
  trustSummary?: AdaptiveTrustSummary;
  question: string;
  modelsUsed: ModelId[];
  runId?: string | null;
}) {
  const rows = alignedClaims || [];
  const [generatedPost, setGeneratedPost] = useState<{ type: "linkedin" | "x"; text: string } | null>(null);

  const handleCopy = useCallback(async () => {
    const markdown = buildAdaptiveSynthesisMarkdown(question, report);
    const ok = await copyToClipboardWithFallback(markdown);
    if (!ok) throw new Error("copy failed");
  }, [question, report]);

  const handleExportMemo = useCallback(() => {
    const memoInput = buildAdaptiveMemoInput(question, report, modelsUsed, runId || "");
    const memo = generateVerificationMemo(memoInput);
    downloadTextFile(memo, `research-memo-${runId || "adaptive"}.txt`);
  }, [question, report, modelsUsed, runId]);

  const handleGenerateLinkedIn = useCallback(() => {
    setGeneratedPost({ type: "linkedin", text: buildAdaptiveLinkedInPost(question, report) });
  }, [question, report]);

  const handleGenerateX = useCallback(() => {
    setGeneratedPost({ type: "x", text: buildAdaptiveXPost(question, report) });
  }, [question, report]);

  return (
    <div className="space-y-4">
      <div data-section="gate-banner">
        <GateBanner gate={gate.status} />
      </div>

      <div data-section="unified-answer">
        <UnifiedAnswerCard answer={report.unifiedAnswer} />
      </div>

      <div data-section="executive-summary">
        <ExecutiveSummaryCard summary={report.executiveSummary} />
      </div>

      <div data-section="certainty">
        <Card>
          <SectionLabel>Answer certainty</SectionLabel>
          <p className="text-xs text-slate-500 mb-2">How sure the panel is about the answer itself — not how well the models behaved (see Trust summary below).</p>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <ProbabilityBar probability={report.runCertainty} colorClass={agreementColorClass(report.runCertainty)} />
            </div>
            <span className="text-sm font-semibold text-slate-700">{Math.round(report.runCertainty * 100)}%</span>
          </div>
          <p className="mt-2 text-sm text-slate-600">{report.certaintyAssessment}</p>
        </Card>
      </div>

      {trustSummary && (
        <div data-section="trust-summary">
          <TrustSummaryTable trustSummary={trustSummary} />
        </div>
      )}

      <div data-section="agreement-disagreement-map">
        <AgreementDisagreementMap claims={rows} modelsUsed={modelsUsed} />
      </div>

      <div data-section="single-model-insights">
        <SingleModelInsightsList claims={rows} />
      </div>

      {report.whereModelsAgree.length > 0 && (
        <div data-section="where-models-agree">
          <Card>
            <SectionLabel>Where models agree</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
              {report.whereModelsAgree.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <div data-section="disagreements">
        <DisagreementsSection report={report} />
      </div>

      <div data-section="bias-blind-spots">
        <BiasBlindSpotsSection report={report} />
      </div>

      {report.narrativeSections.length > 0 && (
        <div data-section="narrative-sections" className="space-y-4">
          {report.narrativeSections.map((section, idx) => (
            <Card key={idx}>
              <SectionLabel>{section.title}</SectionLabel>
              <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-line">{section.body}</p>
            </Card>
          ))}
        </div>
      )}

      {gate.loadBearingClaims.length > 0 && (
        <div data-section="load-bearing-claims">
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
        </div>
      )}

      <div data-section="panel-verdict">
        <PanelVerdictCard report={report} gate={gate} />
      </div>

      <div data-section="export-actions">
        <VerificationActions
          type="research"
          onCopy={handleCopy}
          onExportMemo={handleExportMemo}
          onGenerateLinkedIn={handleGenerateLinkedIn}
          onGenerateX={handleGenerateX}
          copyLabel="Copy synthesis"
        />
      </div>

      {generatedPost && (
        <Card className="bg-slate-50">
          <div className="flex items-center justify-between mb-2">
            <SectionLabel>{generatedPost.type === "linkedin" ? "Generated LinkedIn post" : "Generated 𝕏 post"}</SectionLabel>
            <button
              type="button"
              onClick={() => setGeneratedPost(null)}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              Dismiss
            </button>
          </div>
          <p className="text-sm text-slate-800 whitespace-pre-line mb-3">{generatedPost.text}</p>
          <button
            type="button"
            onClick={() => copyToClipboardWithFallback(generatedPost.text)}
            className="px-3 py-1.5 border border-gray-300 rounded-lg text-xs hover:bg-gray-50"
          >
            Copy to clipboard
          </button>
        </Card>
      )}
    </div>
  );
}
