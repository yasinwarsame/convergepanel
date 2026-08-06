"use client";

/**
 * Adaptive Synthesis Report, Phase 2 (3-schema pilot) — "Review & Governance"
 * section: review status, decisions, conditions, the Verification Gate,
 * Panel Verdict, and review history — all collapsed by default (TopSummaryBar
 * already carries the compact, always-visible status dot/label; this is the
 * full detail behind it). Self-wraps in one <details>, reusable as-is once
 * the remaining 15 schemas roll out, since it consumes only props already
 * threaded to every AdaptivePanelResponse call site.
 *
 * Four parts:
 * - Status summary (no fetch, always renders once expanded): reuses
 *   deriveReportStatus() — the exact function TopSummaryBar's Status field
 *   already calls — expanded into the full label + owner-override flag +
 *   conditions (verbatim, never summarized) + raw humanReview status/decidedVia.
 * - Verification Gate + Panel Verdict (gate/synthesisReport-driven family
 *   only): relocated verbatim from AdaptiveSynthesisReportView — a
 *   governance artifact (the panel's own verdict on itself), not raw
 *   evidence, so it lives here rather than in Panel Evidence.
 * - Review history: a read-only fetch against
 *   GET /api/teams/adaptive-runs/{runId}/history, adapted from
 *   AdaptiveReviewHistorySection.tsx. Gated on `humanReview != null` —
 *   GovernanceRecordV1 only ever exists for the 9 Milestone-2 schemas, so
 *   this fetch is only ever meaningful for comparison_matrix this pilot.
 * - A collapsed "Full synthesis report" fallback (gate/synthesisReport
 *   family only) wrapping the complete, unmodified <AdaptiveSynthesisReportView>
 *   — the only place Executive Summary/Certainty/"Where models agree"/
 *   narrative sections/load-bearing claims/disclaimer/export actions
 *   remain reachable now that the tri-tab shell is gone for these 2
 *   schemas. Deliberately the LAST, most-collapsed element (nested inside
 *   an already-collapsed section) precisely because its content already
 *   overlaps what's shown above it — a disclosed, minimal exception to "no
 *   duplication," kept only because removing it would make export actions
 *   permanently unreachable for procedural/generic, which no part of this
 *   pilot was asked to do.
 *
 * Read-only throughout: no mutation surface, no decision form, no link to
 * the /team/reviews/{runId} detail page — matches
 * AdaptiveReviewHistorySection's own read-only guarantee.
 */

import { useEffect, useState } from "react";
import { ModelId } from "@/lib/types";
import { useAuth } from "@/components/AuthProvider";
import type { AdaptiveReviewHistoryResponseV1 } from "@/lib/governance/adaptiveHumanReviewHistory";
import { humanReviewStatusLabel } from "@/lib/governance/teamReviewLabels";
import { deriveReportStatus, REPORT_STATUS_LABELS, ReportStatusInput } from "@/lib/adaptiveSchema/reportStatus";
import { AdaptiveGateResult, AdaptiveSynthesisReport } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel } from "./shared";
import AdaptiveSynthesisReportView, { PanelVerdictCard } from "./AdaptiveSynthesisReportView";

const TERMINAL_STATUS_KINDS = new Set(["approved", "approved_with_conditions", "changes_requested", "rejected"]);

const GATE_STYLES: Record<AdaptiveGateResult["status"], { label: string; className: string }> = {
  pass: { label: "Verified — panel converges", className: "bg-green-50 text-green-800 border-green-200" },
  caution: { label: "Caution — partial convergence", className: "bg-amber-50 text-amber-800 border-amber-200" },
  fail: { label: "Could not verify — panel split", className: "bg-red-50 text-red-800 border-red-200" },
};

function formatDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StatusSummary({ humanReview, reviewRouting, persistenceStatus }: ReportStatusInput) {
  const status = deriveReportStatus({ humanReview, reviewRouting, persistenceStatus });
  const label = status.isOwnerOverride ? `Owner override — ${REPORT_STATUS_LABELS[status.kind]}` : REPORT_STATUS_LABELS[status.kind];

  return (
    <Card>
      <SectionLabel>Review status</SectionLabel>
      <p className="text-sm font-medium text-slate-900">{label}</p>
      {humanReview?.decidedVia && (
        <p className="mt-1 text-xs text-slate-500">Decided via: {humanReview.decidedVia.replace(/_/g, " ")}</p>
      )}
      {status.conditions && status.conditions.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Conditions</p>
          <ul className="list-disc list-outside pl-5 space-y-0.5 text-sm text-slate-700">
            {status.conditions.map((c, idx) => (
              <li key={idx}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function VerificationGate({ gate }: { gate: AdaptiveGateResult["status"] }) {
  const style = GATE_STYLES[gate];
  return (
    <div>
      <SectionLabel>Verification gate</SectionLabel>
      <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${style.className}`}>{style.label}</div>
    </div>
  );
}

function ReviewHistory({ runId, canonicalTerminal }: { runId: string; canonicalTerminal: boolean }) {
  const { user, authReady } = useAuth();
  const [items, setItems] = useState<AdaptiveReviewHistoryResponseV1["items"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!user || !authReady) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setUnavailable(false);
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}/history`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          setUnavailable(true);
          setItems(null);
          return;
        }
        const json = (await res.json()) as AdaptiveReviewHistoryResponseV1;
        if (json.ok && json.version === 1) {
          setItems(json.items);
        } else {
          setUnavailable(true);
        }
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          setItems(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, authReady, runId]);

  return (
    <div>
      <SectionLabel>Review history</SectionLabel>
      {loading ? (
        <p className="text-sm text-slate-500" aria-live="polite">
          Loading history…
        </p>
      ) : unavailable ? (
        <p className="text-sm text-slate-500" role="status">
          Review history is temporarily unavailable.
        </p>
      ) : items && items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li key={i} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-slate-900">{humanReviewStatusLabel(item.newStatus)}</span>
                <span className="text-xs text-slate-500">Immutable decision record</span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">Decided {formatDatetime(item.reviewedAt)}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{item.commentPresent ? "Comment provided" : "No comment provided"}</span>
                <span aria-hidden>&middot;</span>
                <span>
                  {item.conditionsCount} condition{item.conditionsCount === 1 ? "" : "s"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : canonicalTerminal ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500" role="status">
          The review decision is saved, but its history record is still being recorded.
        </p>
      ) : (
        <p className="text-sm text-slate-500" role="status">
          No history recorded yet.
        </p>
      )}
    </div>
  );
}

export interface ReviewGovernanceSectionProps extends ReportStatusInput {
  runId?: string | null;
  /** gate/synthesisReport-driven family only (procedural/generic this pilot) — Verification Gate + Panel Verdict + the "Full synthesis report" fallback all require these. comparison_matrix passes neither. */
  gate?: AdaptiveGateResult;
  synthesisReport?: AdaptiveSynthesisReport;
  trustSummary?: import("@/lib/adaptiveSchema/types").AdaptiveTrustSummary;
  alignedClaims?: import("@/lib/adaptiveSchema/types").AlignedClaim[];
  modelsUsed?: ModelId[];
  question?: string;
  onRunFollowUp?: (question: string) => void;
}

export default function ReviewGovernanceSection({
  humanReview,
  reviewRouting,
  persistenceStatus,
  runId,
  gate,
  synthesisReport,
  trustSummary,
  alignedClaims,
  modelsUsed,
  question,
  onRunFollowUp,
}: ReviewGovernanceSectionProps) {
  const status = deriveReportStatus({ humanReview, reviewRouting, persistenceStatus });
  const canonicalTerminal = TERMINAL_STATUS_KINDS.has(status.kind);

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Review &amp; Governance</summary>
      <div className="mt-3 space-y-3">
        <StatusSummary humanReview={humanReview} reviewRouting={reviewRouting} persistenceStatus={persistenceStatus} />

        {gate && <VerificationGate gate={gate.status} />}
        {gate && synthesisReport && <PanelVerdictCard report={synthesisReport} gate={gate} />}

        {/* GovernanceRecordV1 only exists for Milestone-2 schemas — skip the
            history fetch entirely (not just degrade it) when there's no
            governance record for this run to have a history for. */}
        {humanReview && runId && <ReviewHistory runId={runId} canonicalTerminal={canonicalTerminal} />}

        {gate && synthesisReport && modelsUsed && question && (
          <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">
              Full synthesis report
            </summary>
            <div className="mt-3">
              <AdaptiveSynthesisReportView
                report={synthesisReport}
                gate={gate}
                alignedClaims={alignedClaims}
                trustSummary={trustSummary}
                question={question}
                modelsUsed={modelsUsed}
                runId={runId}
                onRunFollowUp={onRunFollowUp}
              />
            </div>
          </details>
        )}
      </div>
    </details>
  );
}
