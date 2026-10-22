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

import { useCallback, useMemo, useState } from "react";
import { ModelId } from "@/lib/types";
import {
  AlignedClaim,
  AlignedClaimCell,
  AdaptiveGateResult,
  AdaptiveSynthesisReport,
  AdaptiveTrustSummary,
  ModelTrustSummary,
} from "@/lib/adaptiveSchema/types";
import { TRUST_SCORE_CAP_REASON, TEXT_DEDUP_THRESHOLDS, WHERE_MODELS_AGREE_MAX_ITEMS, CITATION_COVERAGE_DANGER_THRESHOLD, BIAS_EMPTY_REASON_LABELS } from "@/lib/adaptiveSchema/config";
import { dedupeTextList } from "@/lib/adaptiveSchema/textSimilarity";
import { consensusStatusLabel, consensusStatusRank, describeContested } from "@/lib/adaptiveSchema/consensusIntegrity";
import { CLAIM_LABEL, MODEL_CAVEAT_LABEL, PANEL_RESULT_LABEL, presentVerdictCaveat, presentVerdictClaim, quoteClaim } from "@/lib/adaptiveSchema/agreementNarrative";
import {
  AnswerClaimBlock,
  ClaimBlock,
  AnswerGateBlocks,
  TextBlock,
  UnresolvedClaimBlock,
  answerLeadBlocks,
  presentAgreeGroups,
  presentAgreeItems,
  presentCertainty,
  presentDisagreements,
  presentExecutiveSummary,
  presentAnswerGate,
  presentNarrativeSections,
  presentUnifiedAnswer,
} from "@/lib/adaptiveSchema/reportPresentation";
import { GATE_LABEL, GateTone, gateBadgeText, gateBannerText, gateTone, pageGateValue } from "@/lib/adaptiveSchema/gatePresentation";
import {
  POSITIONS_BY_SLOT_HEADING,
  PresentedSlotPosition,
  RowView,
  biasWithheldNotice,
  coverageWithheldNotice,
  markedSourceCountText,
  positionView,
  presentPositionSafeReport,
  presentedRowKind,
  rowKindLabel,
  rowKindsHeading,
  rowView,
  slotLabel,
  statementAfterHeading,
} from "@/lib/adaptiveSchema/positionPresentation";
import { PositionPresentationBoundary, usePositionPresentation } from "./PositionPresentationContext";

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
import { Card, SectionLabel, ProbabilityBar, StakesBadge, TintBadge, getModelLabel, SlotName, SlotChip } from "./shared";
import { classifyClaimSeverity } from "@/lib/verificationGate/claimSeverity";
import { VerificationActions } from "@/components/VerificationActions";
import { generateVerificationMemo, downloadTextFile } from "@/lib/verification/generateMemo";
import { copyToClipboardWithFallback } from "@/lib/ui/copyFormats";
import { useRunModelProvenance } from "./RunModelProvenanceContext";
import {
  buildAdaptiveSynthesisMarkdown,
  buildAdaptiveMemoInput,
  buildAdaptiveLinkedInPost,
  buildAdaptiveXPost,
} from "@/lib/adaptiveSchema/shareBuilders";

// Gate wording comes from gatePresentation.ts (D6); these maps only style it. "neutral": an unrecognized stored gate (D8).
export const GATE_BANNER_STYLES: Record<GateTone, string> = {
  pass: "bg-green-50 text-green-800 border-green-200",
  caution: "bg-amber-50 text-amber-800 border-amber-200",
  fail: "bg-red-50 text-red-800 border-red-200",
  neutral: "bg-slate-50 text-slate-700 border-slate-200",
};

const GATE_BADGE_STYLES: Record<GateTone, string> = {
  pass: "bg-green-50 text-green-700 border-green-200",
  caution: "bg-amber-50 text-amber-700 border-amber-200",
  fail: "bg-red-50 text-red-700 border-red-200",
  neutral: "bg-slate-50 text-slate-600 border-slate-200",
};

const GATE_ACCENT: Record<GateTone, string> = {
  pass: "bg-emerald-400",
  caution: "bg-amber-400",
  fail: "bg-red-400",
  neutral: "bg-slate-300",
};

/**
 * The gate banner: worded by gatePresentation.gateBannerText (historical reports keep their wording, D7). With a report
 * it shows the report's stored gate — the one the Unified Answer and exports show (F4, pageGateValue).
 */
export function GateBanner({ report, gate }: { report: AdaptiveSynthesisReport | null; gate: unknown }) {
  const shown = pageGateValue(report, gate);
  return <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${GATE_BANNER_STYLES[gateTone(shown)]}`}>{gateBannerText(report, shown)}</div>;
}

function agreementColorClass(score: number): string {
  if (score >= 0.7) return "bg-green-500";
  if (score >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

/** Exported for reuse by PanelEvidenceSection.tsx (Adaptive Synthesis Report, Phase 2 pilot) — same unmodified rendering, relocated as curated "supporting synthesis context" rather than the primary landing view for procedural/generic. */
export function UnifiedAnswerCard({ answer, report }: { answer: string; report?: AdaptiveSynthesisReport }) {
  return (
    <Card className="bg-sky-50/60 border-sky-200">
      <SectionLabel>Unified answer</SectionLabel>
      {report?.presentation?.answer ? (
        <UnifiedAnswerClaims report={report} />
      ) : (
        <>
          {/* D8: an unrecognized stored gate is stated first; a known gate renders exactly as before. */}
          {report && <AnswerLead report={report} />}
          <p className="text-sm leading-relaxed text-slate-900 whitespace-pre-line">{answer}</p>
        </>
      )}
    </Card>
  );
}

/**
 * The Unified Answer of a report that carries presentation.answer (R6-1): the computed note, then each claim
 * with its own computed result and supporting models. Reports persisted before it render their stored string.
 */
export function UnifiedAnswerClaims({ report }: { report: AdaptiveSynthesisReport }) {
  const answer = presentUnifiedAnswer(report);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-slate-900">
      <AnswerLeadBlocks blocks={answerLeadBlocks(answer)} />
      {answer.note && <p data-source={answer.note.source}>{answer.note.text}</p>}
      {answer.claimsHeading && (
        <p data-source="computed" className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {answer.claimsHeading}
        </p>
      )}
      {answer.claims.length > 0 && (
        <ul className="list-disc list-outside pl-5 space-y-1">
          {answer.claims.map((item, idx) => (
            <li key={idx}>
              <AnswerClaim item={item} />
            </li>
          ))}
        </ul>
      )}
      <UnresolvedLoadBearing answer={answer} />
    </div>
  );
}

/** D3: a caution answer's stored load-bearing split claims, under their heading; nothing when the answer has none. */
function UnresolvedLoadBearing({ answer }: { answer: AnswerGateBlocks }) {
  if (!(answer.unresolvedHeading && answer.unresolved && (answer.unresolved.length > 0 || answer.unresolvedUnreadable))) return null;
  return (
    <div data-answer-part="unresolved-load-bearing">
      <p data-source="computed" className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">
        {answer.unresolvedHeading}
      </p>
      {answer.unresolved.length > 0 && (
        <ul className="list-disc list-outside pl-5 space-y-1 mt-1">
          {answer.unresolved.map((item, idx) => (
            <li key={idx}>
              <UnresolvedClaim item={item} />
            </li>
          ))}
        </ul>
      )}
      {/* F3: stored entries that could not be read are counted, never silently dropped. */}
      {answer.unresolvedUnreadable && (
        <p data-source="computed" className="mt-1 text-xs text-slate-600">
          {answer.unresolvedUnreadable.text}
        </p>
      )}
    </div>
  );
}

/**
 * O-1: the gate part of the Unified Answer for a page that shows its own answer instead of the Unified Answer (the
 * factual_lookup card) — the stored gate, its notice, and on caution the load-bearing split claims (presentAnswerGate,
 * the same blocks UnifiedAnswerClaims leads with). Nothing for a historical report with a known gate (D7).
 */
export function AnswerGateLead({ report }: { report: AdaptiveSynthesisReport }) {
  const answer = presentAnswerGate(report);
  const blocks = answerLeadBlocks(answer);
  // The load-bearing disclosure exists only where the gate is shown, so no gate means nothing to show.
  if (blocks.length === 0) return null;
  return (
    <div data-answer-part="answer-gate-lead" className="mb-2 space-y-2 text-sm leading-relaxed text-slate-900">
      <AnswerLeadBlocks blocks={blocks} />
      <UnresolvedLoadBearing answer={answer} />
    </div>
  );
}

/** The Unified Answer's computed lead (Order 4): the stored gate in its neutral wording, then the caution / unrecognized notice. */
function AnswerLeadBlocks({ blocks }: { blocks: TextBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div data-answer-part="gate" className="rounded-lg border border-slate-200 bg-white/70 px-3 py-2 space-y-1">
      {blocks.map((b, idx) =>
        b.label ? (
          <p key={idx} data-source={b.source} className="text-xs font-semibold text-slate-700">
            {b.label}: {b.text}
          </p>
        ) : (
          <p key={idx} data-source={b.source} className="text-sm text-slate-800">
            {b.text}
          </p>
        )
      )}
    </div>
  );
}

/** Exported for PrimarySynthesisStrip: the D8 lead of a report persisted before presentation.answer (F2). */
export function AnswerLead({ report }: { report: AdaptiveSynthesisReport }) {
  return <AnswerLeadBlocks blocks={answerLeadBlocks(presentUnifiedAnswer(report))} />;
}

function UnresolvedClaim({ item }: { item: UnresolvedClaimBlock }) {
  return (
    <>
      <ClaimWithResult item={item} />
      {[item.supporters, item.disputers].map(
        (b, idx) =>
          b && (
            <span key={idx} data-source="computed" className="block text-xs text-slate-500 mt-0.5">
              {b.label}: {b.text}
            </span>
          )
      )}
    </>
  );
}

function AnswerClaim({ item }: { item: AnswerClaimBlock }) {
  return (
    <>
      <ClaimWithResult item={item} />
      {item.supporters && (
        <span data-source="computed" className="block text-xs text-slate-500 mt-0.5">
          {item.supporters.label}: {item.supporters.text}
        </span>
      )}
    </>
  );
}

const PARSE_HEALTH_STYLES: Record<ModelTrustSummary["parseHealth"], string> = {
  ok: "bg-green-50 text-green-700 border-green-200",
  degraded: "bg-amber-50 text-amber-700 border-amber-200",
  failed: "bg-red-50 text-red-700 border-red-200",
};

/**
 * Marked trust table (F-2, N-1, N-7, H-3): what each stored input counts, stated exactly. The values are the stored
 * ones (trustSummary.ts) — changing them, including the slot-order tie-break, is Contract C.
 */
export const TRUST_INPUTS_NOTE =
  "Computed from the stored rows and responses, value comparisons included; these are not claim positions. Stance match: the share of the rows where the slot has a position whose stance is the row's most common one (a tie is decided by slot order; 100% when the slot has no position). Contradictions: split rows where the slot disputes. Items contributed: items in the slot's own response. Sources named: the share of the slot's metric values and factual answer that name a source, which is not checked; 100% when the schema asks for no source.";

/** Exported — see UnifiedAnswerCard's export doc above. */
export function TrustSummaryTable({ trustSummary }: { trustSummary: AdaptiveTrustSummary }) {
  // Order 5 (Contract P, F-2): on a marked report the computed trust inputs are labelled for what they count — every
  // scored row, value comparisons included — never as claim positions. The values are the stored ones, unchanged.
  const marked = !!usePositionPresentation();
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
      {marked && <p data-source="computed" className="text-xs text-slate-500 mb-2">{TRUST_INPUTS_NOTE}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-4 font-medium">Model</th>
              <th className="py-2 pr-4 font-medium">Trust</th>
              <th className="py-2 pr-4 font-medium">{marked ? "Items contributed" : "Claims"}</th>
              <th className="py-2 pr-4 font-medium">{marked ? "Stance match" : "Majority align"}</th>
              <th className="py-2 pr-4 font-medium">{marked ? "Sources named" : "Citations"}</th>
              <th className="py-2 pr-4 font-medium">Contradictions</th>
              <th className="py-2 pr-4 font-medium">Health</th>
            </tr>
          </thead>
          <tbody>
            {trustSummary.perModel.map((m) => (
              <tr key={m.modelId} className="border-b border-slate-100 last:border-0">
                <td className="py-2 pr-4">
                  <SlotChip modelId={m.modelId} size="xs" />
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

/** Paragraphs of one block's text, split on blank lines (whitespace-pre-line keeps single breaks). */
function blockParagraphs(text: string): string[] {
  const paragraphs = text.split(/\r?\n[ \t]*\r?\n/).filter((p) => p.trim().length > 0);
  return paragraphs.length > 0 ? paragraphs : [text];
}

/**
 * One attributed block (reportPresentation.ts): its label, then its text. A computed "Panel result" and a
 * model-written explanation are always separate elements with their own label — never one paragraph.
 */
function AttributedBlock({ block, className = "" }: { block: TextBlock; className?: string }) {
  // Order 4: the computed gate is one line, "Verification gate: Caution", wherever it appears.
  if (block.source === "computed" && block.label === GATE_LABEL) {
    return (
      <p data-source="computed" className={`text-xs font-semibold text-slate-700 ${className}`}>
        {block.label}: {block.text}
      </p>
    );
  }
  const model = block.source === "model_explanation" || block.source === "model_bias";
  return (
    <div data-source={block.source} className={className}>
      {block.label && (
        <p className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${model ? "text-amber-700" : "text-slate-500"}`}>{block.label}</p>
      )}
      <div className="space-y-3">
        {blockParagraphs(block.text).map((p, idx) => (
          <p key={idx} className="whitespace-pre-line">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}

/** A claim with its computed result and contested note, each on its own line. */
function ClaimWithResult({ item }: { item: ClaimBlock }) {
  return (
    <>
      <span data-source={item.claim.source}>{item.claim.label ? `${item.claim.label}: ${item.claim.text}` : item.claim.text}</span>
      {item.result && (
        <span data-source="computed" className="block text-xs text-slate-600 mt-0.5">
          {item.result.label}: {item.result.text}
        </span>
      )}
      {item.contested && (
        <span data-source="computed" className="block text-xs text-amber-700 mt-0.5">
          {item.contested.label}: {item.contested.text}
        </span>
      )}
    </>
  );
}

function ExecutiveSummaryCard({ report }: { report: AdaptiveSynthesisReport }) {
  if (!report.presentation) {
    // A report persisted before the presentation contract: exactly the markup it always rendered with.
    const summary = report.executiveSummary;
    const paragraphs = summary.split(/\n{2,}/).filter((p) => p.trim().length > 0);
    return (
      <Card>
        <SectionLabel>Executive summary</SectionLabel>
        {/* D8: an unrecognized stored gate is stated first; a known gate renders exactly as before. */}
        <AnswerLeadBlocks blocks={presentExecutiveSummary(report).filter((b) => b.source === "computed")} />
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
  return (
    <Card>
      <SectionLabel>Executive summary</SectionLabel>
      <div className="space-y-4 text-sm leading-relaxed text-slate-800">
        {presentExecutiveSummary(report).map((block, idx) => (
          <AttributedBlock key={idx} block={block} />
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

/**
 * Order 5 (Contract P): one stored row's recorded positions, by panel slot — claim rows by their validated stances,
 * field rows by each slot's stated value. Never a vote count or an agree / dispute chip for a value comparison.
 */
export function SlotPositionsList({ slots, className = "" }: { slots: PresentedSlotPosition[]; className?: string }) {
  if (slots.length === 0) return null;
  return (
    <div data-source="computed" className={className}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{POSITIONS_BY_SLOT_HEADING}</p>
      <ul className="mt-0.5 space-y-0.5 text-xs text-slate-700">
        {slots.map((s) => (
          <li key={s.slot}>
            <span className="font-medium">{s.label}:</span> {s.position}
            {s.excerpt && (
              <span className="text-slate-500">
                {" "}
                — {s.excerpt.text} ({s.excerpt.note})
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Order 5 (Contract P): a stored row's computed statement, under its heading. */
function RowStatement({ view }: { view: RowView }) {
  return (
    <p data-source="computed" className="text-xs text-slate-600">
      <span className="font-medium">{view.heading}:</span> {statementAfterHeading(view.heading, view.text)}
    </p>
  );
}

/** Order 5 (Contract P): the agreement map of a marked report — each row's own statement and its positions by slot. */
function MarkedPositionMap({ claims, roster, provenance }: { claims: AlignedClaim[]; roster: readonly string[]; provenance: Parameters<typeof rowView>[2] }) {
  // F-1: only a single-source CLAIM row is listed apart (MarkedSingleSourceClaims); a field row stored as single source
  // is a value comparison like any other, shown here.
  const mapRows = claims.map((claim) => ({ claim, view: rowView(claim, roster, provenance) })).filter(({ claim, view }) => !(view.rowType === "claim" && claim.status === "single_source"));
  if (mapRows.length === 0) return null;
  return (
    <Card>
      <SectionLabel>Recorded positions and value comparisons</SectionLabel>
      <div className="space-y-3">
        {mapRows.map(({ claim, view }, idx) => {
          return (
            <div key={`${claim.id}-${idx}`} className="space-y-1.5" data-row-type={view.rowType}>
              <p data-source="model_claim" className="text-sm text-slate-800">
                {rowKindLabel(presentedRowKind(view), CLAIM_LABEL)}: {quoteClaim(claim.claimText)}
              </p>
              <RowStatement view={view} />
              {view.contested && (
                <p className="text-xs text-amber-700" data-testid="contested-note">
                  Contested: {view.contested}
                </p>
              )}
              <SlotPositionsList slots={view.slots} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Exported — see UnifiedAnswerCard's export doc above. */
export function AgreementDisagreementMap({ claims, modelsUsed }: { claims: AlignedClaim[]; modelsUsed: ModelId[] }) {
  const position = usePositionPresentation();
  if (position) return <MarkedPositionMap claims={claims} roster={position.roster} provenance={position.provenance} />;
  // Coverage-1 claims (a single model's own claim, never corroborated or
  // disputed by anyone else) aren't agreement data — they're rendered
  // separately by SingleModelInsightsList below this section.
  const mapClaims = claims.filter((c) => c.status !== "single_source");
  if (mapClaims.length === 0) return null;

  const sorted = [...mapClaims].sort((a, b) => {
    const statusDelta = consensusStatusRank(a.status) - consensusStatusRank(b.status);
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
          const isLimitedCoverage = claim.status === "limited_coverage";
          const contestedNote = describeContested(claim);
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
                  {isLimitedCoverage ? " · limited coverage" : ""}
                </span>
              </div>
              {contestedNote && (
                <p className="text-xs text-amber-700" data-testid="contested-note">
                  Contested: {contestedNote}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {agreeModels.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-600">Agree</span>
                    {agreeModels.map((m) => (
                      <SlotChip key={`agree-${m}`} modelId={m} size="xs" className="ring-1 ring-emerald-300" />
                    ))}
                  </div>
                )}
                {disputeModels.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-rose-600">Dispute</span>
                    {disputeModels.map((m) => (
                      <SlotChip key={`dispute-${m}`} modelId={m} size="xs" className="ring-1 ring-rose-300" />
                    ))}
                  </div>
                )}
                {silentModels.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-slate-400">Silent</span>
                    {silentModels.map((m) => (
                      <SlotChip key={`silent-${m}`} modelId={m} size="xs" className="opacity-50" />
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
/** Exported — see UnifiedAnswerCard's export doc above. */
export function SingleModelInsightsList({ claims, labelled = false }: { claims: AlignedClaim[]; labelled?: boolean }) {
  const position = usePositionPresentation();
  if (position) return <MarkedSingleSourceClaims claims={claims} roster={position.roster} provenance={position.provenance} />;
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
              {soleCell && <SlotChip modelId={soleCell.modelId} size="xs" className="mt-0.5 shrink-0" />}
              {labelled ? (
                // New reports (presentation present): the claim is model-written — quoted and labelled; the card's heading is its result.
                <span data-source="model_claim" className="text-slate-700">
                  {CLAIM_LABEL}: {quoteClaim(claim.claimText)}
                </span>
              ) : (
                <span className="text-slate-700">{claim.claimText}</span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * Order 5 (Contract P, F-1): a marked report's single-source CLAIM rows — each with its own computed statement and its
 * recorded positions by panel slot (slot labels, never a model chip). Field rows are value comparisons, shown in the
 * position map, never here.
 */
function MarkedSingleSourceClaims({ claims, roster, provenance }: { claims: AlignedClaim[]; roster: readonly string[]; provenance: Parameters<typeof rowView>[2] }) {
  const rows = claims.filter((c) => c.status === "single_source").map((claim) => ({ claim, view: rowView(claim, roster, provenance) })).filter(({ view }) => view.rowType === "claim");
  if (rows.length === 0) return null;
  return (
    <Card className="bg-slate-50">
      <SectionLabel>{SINGLE_SOURCE_CLAIMS_HEADING}</SectionLabel>
      <p data-source="computed" className="text-xs text-slate-500 mb-2">
        {SINGLE_SOURCE_CLAIMS_NOTE}
      </p>
      <ul className="space-y-2">
        {rows.map(({ claim, view }, idx) => (
          <li key={`${claim.id}-${idx}`} className="space-y-1 text-sm" data-row-type={view.rowType}>
            <p data-source="model_claim" className="text-slate-700">
              {CLAIM_LABEL}: {quoteClaim(claim.claimText)}
            </p>
            <RowStatement view={view} />
            <SlotPositionsList slots={view.slots.filter((sl) => sl.position !== "No position recorded")} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export const SINGLE_SOURCE_CLAIMS_HEADING = "Single-source claims";
export const SINGLE_SOURCE_CLAIMS_NOTE = "Claim rows with the computed status single source: listed in the recorded rows by one panel slot only.";

/** Exported — see UnifiedAnswerCard's export doc above. */
export function DisagreementsSection({ report }: { report: AdaptiveSynthesisReport }) {
  if (report.disagreements.length === 0) return null;
  const presentedDisagreements = presentDisagreements(report);
  const view = positionView(report);
  if (view) {
    // Order 5 (Contract P): each split row's own computed statement and its positions by slot, from the joined stored
    // row; no model explanation and no model-assigned stakes.
    return (
      <Card>
        <SectionLabel>Unresolved claims and value differences</SectionLabel>
        <div className="space-y-3">
          {presentedDisagreements.map((presented, idx) => {
            const rv = view.disagreements[idx];
            return (
              <div key={idx} className="rounded-lg bg-slate-50 border border-slate-200 p-4">
                <h3 className="text-slate-900 font-semibold mb-2">
                  <ClaimWithResult item={presented} />
                </h3>
                {rv ? <SlotPositionsList slots={rv.slots} className="mt-2" /> : <p data-source="computed" className="text-xs text-slate-500">Position details are unavailable in this view.</p>}
              </div>
            );
          })}
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SectionLabel>Disagreements</SectionLabel>
      <div className="space-y-3">
        {report.disagreements.map((d, idx) => {
          const severity = classifyClaimSeverity(`${d.topic} ${d.whyTheyDiffer}`, undefined, undefined, true);
          const presented = presentedDisagreements[idx];
          return (
            <div key={idx} className="relative rounded-lg bg-orange-50 border border-orange-200 p-4">
              <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-orange-400" />
              <div className="pl-4">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <StakesBadge stakes={d.stakes ?? severity.severity} />
                </div>
                {report.presentation ? (
                  <>
                    <h3 className="text-orange-900 font-semibold mb-2">
                      <ClaimWithResult item={presented} />
                    </h3>
                    {presented.why && <AttributedBlock block={presented.why} className="text-orange-800 mb-3 text-sm" />}
                  </>
                ) : (
                  <>
                    <h3 className="text-orange-900 font-semibold mb-2">{d.topic}</h3>
                    <p className="text-orange-800 mb-3 text-sm">{d.whyTheyDiffer}</p>
                  </>
                )}
                <div className="space-y-2 mt-3">
                  {d.positions.map((p, posIdx) => (
                    <div key={posIdx} className="pl-3 border-l-2 border-orange-300">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-orange-900"><SlotName modelId={p.modelId} />:</span>
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

/** T1: unchanged per-model attributed-bias cards. */
/** Exported for reuse by BiasBlindspotAuditView.tsx (Milestone 2) — the standalone bias_blindspot_audit schema's Tier 1 uses the exact same `AdaptiveBiasFinding[]` shape (reusing `detectAdaptiveBiases` verbatim), so this renders identically in both places rather than being duplicated. */
export function BiasFindingCards({ findings }: { findings: AdaptiveSynthesisReport["biasAndBlindSpots"] }) {
  return (
    <div className="space-y-3">
      {findings.map((b, idx) => (
        <div key={idx} className="relative rounded-lg bg-slate-50 border border-slate-300 p-4">
          <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-amber-400" />
          <div className="pl-4">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {b.modelsImplicated.map((m) => (
                <SlotChip key={m} modelId={m} size="xs" />
              ))}
            </div>
            <h3 className="text-slate-900 font-semibold mb-1">{b.biasType}</h3>
            <p className="text-sm text-slate-700 mb-3">{b.description}</p>

            {b.evidence.length > 0 && (
              <div className="space-y-2 mb-3">
                {b.evidence.map((e, evIdx) => (
                  <div key={evIdx} className="pl-3 border-l-2 border-slate-300">
                    <p className="text-sm text-slate-700">
                      <span className="font-medium"><SlotName modelId={e.modelId} />:</span> &ldquo;{e.excerpt}&rdquo;
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
  );
}

/** T2: one "what the panel didn't cover" card per coverage gap, with an optional Run follow-up action that pre-fills the question box. */
function CoverageGapCard({
  gap,
  onRunFollowUp,
}: {
  gap: AdaptiveSynthesisReport["panelCoverageGaps"][number];
  onRunFollowUp?: (question: string) => void;
}) {
  return (
    <div className="rounded-lg bg-sky-50 border border-sky-200 p-4">
      <h3 className="text-sky-900 font-semibold mb-1">{gap.dimension}</h3>
      <p className="text-sm text-sky-800 mb-3">{gap.whyItMatters}</p>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-xs text-sky-700 italic flex-1 min-w-[12rem]">&ldquo;{gap.followUpQuestion}&rdquo;</p>
        {onRunFollowUp && (
          <button
            type="button"
            onClick={() => onRunFollowUp(gap.followUpQuestion)}
            className="shrink-0 rounded-lg border border-sky-300 bg-white px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-100"
          >
            Run follow-up
          </button>
        )}
      </div>
    </div>
  );
}

/** T3: a single compact strip of inline stats — never cards, per spec. */
function DiagnosticsStrip({ diagnostics }: { diagnostics: AdaptiveSynthesisReport["diagnostics"] }) {
  const marked = !!usePositionPresentation();
  const citationPct = diagnostics.totalClaimCount > 0 ? diagnostics.citedClaimCount / diagnostics.totalClaimCount : null;
  const citationDanger = citationPct !== null && citationPct < CITATION_COVERAGE_DANGER_THRESHOLD;

  const evidenceParts = (
    [
      ["empirical", diagnostics.evidenceMix.empirical],
      ["theoretical", diagnostics.evidenceMix.theoretical],
      ["anecdotal", diagnostics.evidenceMix.anecdotal],
      ["authoritative", diagnostics.evidenceMix.authoritative],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {citationPct !== null && (
        <TintBadge tone={citationDanger ? "danger" : "accent"}>
          {marked ? markedSourceCountText(diagnostics.citedClaimCount, diagnostics.totalClaimCount) : <>Citations: {diagnostics.citedClaimCount} of {diagnostics.totalClaimCount} claims cite a source</>}
        </TintBadge>
      )}
      {evidenceParts.length > 0 && <TintBadge tone="accent">Evidence mix: {evidenceParts.join(", ")}</TintBadge>}
      {diagnostics.homogeneityFlag && (
        <TintBadge
          tone="accent"
          title="Models share training data — strong consensus is not independent verification."
        >
          Unusually uniform agreement
        </TintBadge>
      )}
    </div>
  );
}

/** Composed only when T1+T2+T3 are ALL empty — states the actual reason(s), never generic advice. */
function biasSectionEmptyMessage(report: AdaptiveSynthesisReport): string {
  const biasPart = report.biasEmptyReason
    ? BIAS_EMPTY_REASON_LABELS[report.biasEmptyReason]
    : "no model-specific bias signals were confidently attributable";
  const claimsPart =
    report.diagnostics.totalClaimCount === 0
      ? "no claims were extracted this run, so there was nothing for the coverage audit or diagnostics to analyze"
      : "the panel's coverage looked complete and its diagnostics showed nothing notable";
  return `No bias, coverage, or diagnostic signals to show this run: ${biasPart}, and ${claimsPart}.`;
}

/** Exported — see UnifiedAnswerCard's export doc above. Exported instead of the already-exported bare BiasFindingCards, since that alone would drop the Tier-2 (coverage gaps)/Tier-3 (diagnostics)/empty-state handling this wraps uniformly. */
export function BiasBlindSpotsSection({
  report,
  onRunFollowUp,
}: {
  report: AdaptiveSynthesisReport;
  onRunFollowUp?: (question: string) => void;
}) {
  const view = positionView(report);
  const hasT1 = report.biasAndBlindSpots.length > 0;
  const hasT2 = report.panelCoverageGaps.length > 0;
  const hasT3 = report.diagnostics.totalClaimCount > 0;
  // Order 5 (Contract P): a marked report withholds the model-written Tier 1 and Tier 2 text and says how much.
  const withheld = view ? [view.biasFindingsWithheld > 0 ? biasWithheldNotice(view.biasFindingsWithheld) : "", view.coverageGapsWithheld > 0 ? coverageWithheldNotice(view.coverageGapsWithheld) : ""].filter(Boolean) : [];
  const allEmpty = !hasT1 && !hasT2 && !hasT3 && withheld.length === 0;

  return (
    <Card>
      <SectionLabel>Bias &amp; blind spots</SectionLabel>
      {allEmpty ? (
        <p className="text-sm text-slate-500 italic">{biasSectionEmptyMessage(report)}</p>
      ) : (
        <div className="space-y-4">
          {withheld.map((notice, idx) => (
            <p key={idx} data-source="computed" className="text-sm text-slate-600">
              {notice}
            </p>
          ))}
          {hasT1 &&
            (report.presentation ? (
              // New reports: the bias check is a model's observation — labelled as on the verdict card (R6-5).
              <div data-source="model_bias">
                <p className="text-[11px] font-semibold uppercase tracking-wide mb-2 text-amber-700">{MODEL_CAVEAT_LABEL}</p>
                <BiasFindingCards findings={report.biasAndBlindSpots} />
              </div>
            ) : (
              <BiasFindingCards findings={report.biasAndBlindSpots} />
            ))}
          {hasT2 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-sky-700 mb-2">What the panel didn&apos;t cover</p>
              <div className="space-y-2">
                {report.panelCoverageGaps.map((gap, idx) => (
                  <CoverageGapCard key={idx} gap={gap} onRunFollowUp={onRunFollowUp} />
                ))}
              </div>
            </div>
          )}
          {hasT3 && (
            <div className={hasT1 || hasT2 ? "pt-3 border-t border-slate-100" : ""}>
              <DiagnosticsStrip diagnostics={report.diagnostics} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Exported — see UnifiedAnswerCard's export doc above. */
export function PanelVerdictCard({ report, gate }: { report: AdaptiveSynthesisReport; gate: AdaptiveGateResult }) {
  const v = report.verdictCard;
  // Order 5 (Contract P): a marked report's headings come from its rows (a value comparison is never "top consensus").
  const positions = positionView(report)?.verdict ?? null;
  // R4-1: claim text is model-written; cards that carry the computed status show it beside the quoted claim.
  const top = presentVerdictClaim(v.topConsensus, v.topConsensusAgreement, positions?.topLabel);
  const split = v.keyDisagreement ? presentVerdictClaim(v.keyDisagreement, v.keyDisagreementAgreement, positions?.keyLabel) : null;
  const caveat = presentVerdictCaveat(v);
  // F4: the card shows the report's stored gate, as the Unified Answer does.
  const shownGate = pageGateValue(report, gate.status);
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-6 overflow-hidden">
      <div className={`absolute left-0 top-0 h-1.5 w-full ${GATE_ACCENT[gateTone(shownGate)]}`} />

      <div className="rounded-lg bg-sky-50 border border-sky-200 px-4 py-3 text-xs text-sky-800 mb-4">
        ConvergePanel is an AI-assisted research tool, not a forensic or fact-checking authority. Synthesis informs
        judgment — it doesn&apos;t replace it.
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <h3 className="text-lg font-semibold text-slate-900">Panel Verdict</h3>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${GATE_BADGE_STYLES[gateTone(shownGate)]}`}>
          {gateBadgeText(report, shownGate)}
        </span>
      </div>

      <p className="text-sm font-medium text-slate-900 mb-4">{v.question}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">{positions ? positions.topHeading : "Top consensus"}</span>
          <p className="text-sm text-slate-800 mt-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1.5" />
            {top.result ? <span data-source="model_claim">{top.claim}</span> : top.claim}
            {v.consensusModelCount > 0 &&
              (positions ? (
                <span className="text-slate-500"> — supported or partially supported by {v.consensusModelCount} panel slot{v.consensusModelCount === 1 ? "" : "s"}</span>
              ) : (
                <span className="text-slate-500"> — agreed by {v.consensusModelCount} model{v.consensusModelCount === 1 ? "" : "s"}</span>
              ))}
            {top.result && <span data-source="computed" className="block text-xs text-slate-600 mt-0.5">{top.result}</span>}
            {v.topConsensusContested && <span className="block text-xs text-amber-700 mt-0.5">Contested: {v.topConsensusContested}</span>}
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">{positions ? positions.keyHeading : "Key disagreement"}</span>
          {v.keyDisagreement ? (
            <p className="text-sm text-slate-800 mt-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-500 mr-1.5" />
              {split!.result ? <span data-source="model_claim">{split!.claim}</span> : split!.claim}
              {split!.result && <span data-source="computed" className="block text-xs text-slate-600 mt-0.5">{split!.result}</span>}
              {v.disagreementDetail && <span className="block text-slate-500 mt-0.5">{v.disagreementDetail}</span>}
            </p>
          ) : (
            <p className="text-sm text-slate-500 italic mt-1">{positions ? positions.noKeyText : "No major disagreements detected."}</p>
          )}
        </div>
      </div>

      {caveat && (
        <div className="mb-4">
          <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">Caveat</span>
          <p {...(v.caveatSource ? { "data-source": "model_bias" } : {})} className="text-sm text-slate-700 mt-1">{caveat}</p>
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

/**
 * A load-bearing claim on a new report (R6-4): the model-written claim quoted and labelled, then its computed
 * status with the models that support and dispute it — not every listed model beside the status.
 */
function LoadBearingClaim({ claim }: { claim: AlignedClaim }) {
  const position = usePositionPresentation();
  if (position) {
    // Order 5 (Contract P): the row's own computed statement; supporting / disputing slots for a claim row only.
    const view = rowView(claim, position.roster, position.provenance);
    const who = view.rowType === "claim" ? [view.supporters.length > 0 ? `supported by ${view.supporters.join(", ")}` : "", view.disputers.length > 0 ? `disputed by ${view.disputers.join(", ")}` : ""].filter(Boolean) : [];
    return (
      <>
        <span data-source="model_claim">
          {rowKindLabel(presentedRowKind(view), CLAIM_LABEL)}: {quoteClaim(claim.claimText)}
        </span>
        <span data-source="computed" className="block text-xs text-slate-500 mt-0.5">
          {PANEL_RESULT_LABEL}: <span className="font-medium">{view.heading}</span> — {statementAfterHeading(view.heading, view.text)}
          {who.length > 0 ? ` (${who.join("; ")})` : ""}
        </span>
      </>
    );
  }
  const named = (stances: string[]) =>
    claim.cells.filter((c): c is AlignedClaimCell => !!c && stances.includes(c.stance)).map((c) => getModelLabel(c.modelId));
  const supports = named(["agrees", "partial"]);
  const disputes = named(["disputes"]);
  const who = [supports.length > 0 ? `supported by ${supports.join(", ")}` : "", disputes.length > 0 ? `disputed by ${disputes.join(", ")}` : ""].filter(Boolean);
  return (
    <>
      <span data-source="model_claim">
        {CLAIM_LABEL}: {quoteClaim(claim.claimText)}
      </span>
      <span data-source="computed" className="block text-xs text-slate-500 mt-0.5">
        {PANEL_RESULT_LABEL}: <span className="font-medium">{consensusStatusLabel(claim.status)}</span>
        {who.length > 0 ? ` (${who.join("; ")})` : ""}
      </span>
    </>
  );
}

/** Order 5 (Contract P, marked reports): the load-bearing section's heading by what its rows are (m-6). */
function loadBearingHeading(claims: AlignedClaim[], roster: readonly string[]): string {
  return rowKindsHeading(
    claims.map((c) => presentedRowKind(rowView(c, roster))),
    { claim: "Load-bearing claims (top by salience)", field: "Load-bearing value comparisons (top by salience)", mixed: "Load-bearing claims and value comparisons (top by salience)", other: "Load-bearing rows (top by salience)" }
  );
}

export default function AdaptiveSynthesisReportView({
  report: storedReport,
  gate,
  alignedClaims,
  trustSummary,
  question,
  modelsUsed,
  runId,
  onRunFollowUp,
}: {
  report: AdaptiveSynthesisReport;
  gate: AdaptiveGateResult;
  alignedClaims?: AlignedClaim[];
  trustSummary?: AdaptiveTrustSummary;
  question: string;
  modelsUsed: ModelId[];
  runId?: string | null;
  /** Bias & Blind Spots Tier 2 cards' "Run follow-up" action — pre-fills the question box, never auto-runs. */
  onRunFollowUp?: (question: string) => void;
}) {
  const rows = alignedClaims || [];
  const modelProvenance = useRunModelProvenance();
  const position = usePositionPresentation();
  // Order 5 (Contract P): normally already the position-safe view (AdaptivePanelResponse); a marked stored report
  // reaching this view directly is presented the same way. Unmarked reports are unchanged.
  const report = useMemo(
    () => presentPositionSafeReport(storedReport, { rows: alignedClaims, roster: position?.roster ?? modelsUsed, provenance: position?.provenance ?? modelProvenance }),
    [storedReport, alignedClaims, position, modelsUsed, modelProvenance]
  );
  const [generatedPost, setGeneratedPost] = useState<{ type: "linkedin" | "x"; text: string } | null>(null);
  const agreeItems = presentAgreeItems(report);
  // Order 5 (Contract P, F-1): a marked report's entries in groups — claims, value comparisons, rows not joined.
  const agreeGroups = presentAgreeGroups(report);

  const handleCopy = useCallback(async () => {
    const markdown = buildAdaptiveSynthesisMarkdown(question, report);
    const ok = await copyToClipboardWithFallback(markdown);
    if (!ok) throw new Error("copy failed");
  }, [question, report]);

  const handleExportMemo = useCallback(() => {
    const memoInput = buildAdaptiveMemoInput(question, report, modelsUsed, runId || "", modelProvenance);
    const memo = generateVerificationMemo(memoInput);
    downloadTextFile(memo, `research-memo-${runId || "adaptive"}.txt`);
  }, [question, report, modelsUsed, runId, modelProvenance]);

  const handleGenerateLinkedIn = useCallback(() => {
    setGeneratedPost({ type: "linkedin", text: buildAdaptiveLinkedInPost(question, report) });
  }, [question, report]);

  const handleGenerateX = useCallback(() => {
    setGeneratedPost({ type: "x", text: buildAdaptiveXPost(question, report) });
  }, [question, report]);

  return (
    <PositionPresentationBoundary report={report} roster={position?.roster ?? modelsUsed} provenance={position?.provenance ?? modelProvenance}>
    <div className="space-y-4">
      <div data-section="gate-banner">
        <GateBanner report={report} gate={gate.status} />
      </div>

      <div data-section="unified-answer">
        <UnifiedAnswerCard answer={report.unifiedAnswer} report={report} />
      </div>

      <div data-section="executive-summary">
        <ExecutiveSummaryCard report={report} />
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
          {report.presentation ? (
            <div className="mt-2 space-y-2 text-sm text-slate-600">
              {presentCertainty(report).map((block, idx) => (
                <AttributedBlock key={idx} block={block} />
              ))}
            </div>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-600">{report.certaintyAssessment}</p>
              {/* D8: an unrecognized stored gate is stated after the stored line; a known gate renders exactly as before. */}
              <AnswerLeadBlocks blocks={presentCertainty(report).filter((b) => b.source === "computed")} />
            </>
          )}
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
        <SingleModelInsightsList claims={rows} labelled={!!report.presentation} />
      </div>

      {agreeGroups && agreeGroups.length > 0 && (
        <div data-section="where-models-agree">
          <Card>
            <div className="space-y-3">
              {agreeGroups.map((g) => (
                <div key={g.kind} data-agree-group={g.kind}>
                  <SectionLabel>{g.heading}</SectionLabel>
                  <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
                    {g.items.map((item, idx) => (
                      <li key={idx}>
                        <ClaimWithResult item={item} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {!agreeGroups && agreeItems.length > 0 && (
        <div data-section="where-models-agree">
          <Card>
            <SectionLabel>Where models agree</SectionLabel>
            <ul className="list-disc list-outside pl-5 space-y-1 text-sm leading-relaxed text-slate-800">
              {agreeItems.map((item, idx) =>
                report.presentation ? (
                  <li key={idx}>
                    <ClaimWithResult item={item} />
                  </li>
                ) : (
                  <li key={idx}>{item.claim.text}</li>
                )
              )}
            </ul>
          </Card>
        </div>
      )}

      <div data-section="disagreements">
        <DisagreementsSection report={report} />
      </div>

      <div data-section="bias-blind-spots">
        <BiasBlindSpotsSection report={report} onRunFollowUp={onRunFollowUp} />
      </div>

      {report.narrativeSections.length > 0 && (
        <div data-section="narrative-sections" className="space-y-4">
          {presentNarrativeSections(report).map((section, idx) => (
            <Card key={idx}>
              {section.titleSource === "model_explanation" ? (
                // D4: the title is model-written — shown inside the attributed block, never as an application heading.
                <div data-source="model_explanation" className="text-sm leading-relaxed text-slate-800">
                  <p className="text-[11px] font-semibold uppercase tracking-wide mb-1 text-amber-700">{section.body.label}</p>
                  <p className="font-semibold">{section.title}</p>
                  <div className="space-y-3 mt-1">
                    {blockParagraphs(section.body.text).map((p, pIdx) => (
                      <p key={pIdx} className="whitespace-pre-line">
                        {p}
                      </p>
                    ))}
                  </div>
                </div>
              ) : (
              <>
              <SectionLabel>{section.title}</SectionLabel>
              {section.body.source === "legacy" ? (
                <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-line">{section.body.text}</p>
              ) : (
                <AttributedBlock block={section.body} className="text-sm leading-relaxed text-slate-800" />
              )}
              </>
              )}
            </Card>
          ))}
        </div>
      )}

      {Array.isArray(gate.loadBearingClaims) && gate.loadBearingClaims.length > 0 && (
        <div data-section="load-bearing-claims">
          <Card className="bg-slate-50">
            <SectionLabel>{positionView(report) ? loadBearingHeading(gate.loadBearingClaims, positionView(report)!.roster) : "Load-bearing claims (top by salience)"}</SectionLabel>
            <ul className="space-y-1 text-sm text-slate-700">
              {gate.loadBearingClaims.map((claim) =>
                report.presentation ? (
                  <li key={claim.id}>
                    <LoadBearingClaim claim={claim} />
                  </li>
                ) : (
                <li key={claim.id}>
                  {claim.claimText} — <span className="font-medium">{consensusStatusLabel(claim.status)}</span>
                  {claim.cells.some(Boolean) && (
                    <span className="text-slate-500">
                      {" "}
                      ({claim.cells.filter(Boolean).map((c) => getModelLabel(c!.modelId)).join(", ")})
                    </span>
                  )}
                </li>
                )
              )}
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
    </PositionPresentationBoundary>
  );
}
