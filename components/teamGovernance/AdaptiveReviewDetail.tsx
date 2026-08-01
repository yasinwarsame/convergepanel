"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — adaptive review
 * detail view, now including the decision form
 * (docs/governance-decision-receipts-design.md §26). Fetches
 * `GET /api/teams/adaptive-runs/{runId}` as the canonical data source; the
 * form submits to `POST /api/teams/adaptive-runs/{runId}/decision` and
 * always sends the most recently fetched `data.review.updatedAt` as
 * `expectedUpdatedAt` — never a value sourced from `teamRuns`.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import type { AdaptiveReviewDetailResponseV1 } from "@/lib/governance/adaptiveReviewDetail";
import { answerShapeLabel, humanReviewStatusLabel, schemaLabel, isTerminalHumanReviewStatusLabel } from "@/lib/governance/teamReviewLabels";
import type { AdaptiveReviewSubmissionResult as SubmissionResult } from "@/lib/client/adaptiveReviewSubmission";
import GovernanceStatusBadge from "./GovernanceStatusBadge";
import HumanReviewStatusBadge from "./HumanReviewStatusBadge";
import ReviewErrorState from "./ReviewErrorState";
import AdaptiveReviewDecisionForm from "./AdaptiveReviewDecisionForm";
import AdaptiveReviewHistorySection from "./AdaptiveReviewHistorySection";
import AdaptiveReviewAssignmentSection from "./AdaptiveReviewAssignmentSection";
import AdaptiveMultiReviewerPanelSection from "./AdaptiveMultiReviewerPanelSection";

function formatDatetime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CollapsibleList({ title, items }: { title: string; items: string[] }) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;
  const sectionId = `review-detail-section-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="border-t border-cp-border pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={sectionId}
        className="flex w-full items-center justify-between text-left text-sm font-semibold text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
      >
        <span>
          {title} ({items.length})
        </span>
        <span aria-hidden>{expanded ? "−" : "+"}</span>
      </button>
      {expanded ? (
        <ul id={sectionId} className="mt-2 list-disc space-y-1 pl-5 text-sm text-cp-text">
          {items.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function AdaptiveReviewDetail({ runId }: { runId: string }) {
  const { user, loading: authLoading, authReady } = useAuth();
  const [data, setData] = useState<AdaptiveReviewDetailResponseV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);
  // Multi-Reviewer Owner Override, Part F (§F11) — `undefined` until the
  // panel section's own first load reports in; `null` means no panel
  // exists. Single-reviewer assignment/decision UI is hidden while a panel
  // is "open" or "finalized" (an active or already-decided panel replaces
  // direct single-review) and restored for "cancelled" or no panel at all.
  const [panelStatus, setPanelStatus] = useState<"open" | "cancelled" | "finalized" | null | undefined>(undefined);
  const singleReviewerUiHidden = panelStatus === "open" || panelStatus === "finalized";

  const load = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!user || !authReady) return;
      if (!opts?.background) {
        setLoading(true);
        setError(null);
      }
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(`/api/teams/adaptive-runs/${encodeURIComponent(runId)}`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });

        if (!res.ok) {
          if (opts?.background) {
            // A background reconciliation refetch failing after a
            // successful mutation is non-fatal — the just-submitted
            // success state is kept, never reverted.
            setRefreshNotice("Could not refresh the latest details, but your decision was recorded.");
            return;
          }
          if (res.status === 401 || res.status === 403) {
            setError("You don't have access to this review.");
          } else if (res.status === 404) {
            setError("This review could not be found.");
          } else {
            setError("This review is temporarily unavailable. Please try again.");
          }
          setData(null);
          return;
        }
        const json = (await res.json()) as AdaptiveReviewDetailResponseV1;
        if (json.ok && json.version === 1) {
          setData(json);
          setError(null);
        } else if (!opts?.background) {
          setError("This review is temporarily unavailable. Please try again.");
        }
      } catch {
        if (opts?.background) {
          setRefreshNotice("Could not refresh the latest details, but your decision was recorded.");
        } else {
          setError("This review is temporarily unavailable. Please try again.");
          setData(null);
        }
      } finally {
        if (!opts?.background) setLoading(false);
      }
    },
    [user, authReady, runId]
  );

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authReady, runId]);

  /**
   * Canonical-success semantics (§26.11, "Preferred" option): update the
   * local view directly from the server's own success response — which IS
   * canonical, the server just told us definitively what committed — then
   * trigger ONE background canonical refetch to reconcile fully. A
   * background-refetch failure never reverts the just-recorded success.
   */
  const handleDecisionSuccess = (result: Extract<SubmissionResult, { kind: "success" }>) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            review: {
              ...prev.review,
              humanReview: { status: result.status, reviewedAt: result.reviewedAt },
              reviewable: false,
              updatedAt: result.reviewedAt,
            },
          }
        : prev
    );
    setJustSubmitted(true);
    setRefreshNotice(null);
    void load({ background: true });
  };

  const handleRequestReload = () => {
    setJustSubmitted(false);
    setRefreshNotice(null);
    void load();
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 pb-20">
      <Link
        href="/team/reviews"
        className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-cp-text transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
        Back to review queue
      </Link>

      {authLoading || !authReady || loading ? (
        <div className="py-12 text-center text-cp-muted" aria-live="polite">
          <span className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-cp-accent border-t-transparent" aria-hidden />
          <p className="mt-4 text-sm">Loading…</p>
        </div>
      ) : error ? (
        <ReviewErrorState message={error} />
      ) : data ? (
        <div className="space-y-6">
          <header className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-cp-text">{schemaLabel(data.review.schemaId)}</h1>
              <span className="text-sm text-cp-muted">{answerShapeLabel(data.review.answerShape)}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <GovernanceStatusBadge status={data.review.automatedGovernance?.status} />
              <HumanReviewStatusBadge status={data.review.humanReview.status} />
              <span className="text-xs font-semibold text-cp-muted">
                {data.review.reviewable ? "Reviewable" : "Terminal — no further decision can be submitted"}
              </span>
            </div>
            <p className="mt-3 text-xs text-cp-muted">Updated {formatDatetime(data.review.updatedAt)}</p>
            {refreshNotice ? <p className="mt-2 text-xs text-amber-400">{refreshNotice}</p> : null}
          </header>

          <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
            <h2 className="text-base font-bold text-cp-text">Decision Receipt</h2>
            <p className="mt-3 text-sm leading-relaxed text-cp-text">{data.review.decisionReceipt.conclusion}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-cp-muted">
              <span>{data.review.decisionReceipt.sourceBacked ? "Source-backed" : "Not source-backed"}</span>
              <span aria-hidden>&middot;</span>
              <span>
                {data.review.decisionReceipt.humanReviewNeeded ? "Human review needed" : "Human review not flagged as needed"}
              </span>
            </div>
            <div className="mt-4 space-y-3">
              <CollapsibleList title="Basis" items={data.review.decisionReceipt.basis} />
              <CollapsibleList title="Assumptions" items={data.review.decisionReceipt.assumptions} />
              <CollapsibleList title="Uncertainties" items={data.review.decisionReceipt.uncertainties} />
              <CollapsibleList title="Limitations" items={data.review.decisionReceipt.limitations} />
            </div>
          </section>

          <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
            <h2 className="text-base font-bold text-cp-text">Automated Governance</h2>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-cp-muted">Status</dt>
                <dd className="text-cp-text">
                  {data.review.automatedGovernance ? <GovernanceStatusBadge status={data.review.automatedGovernance.status} /> : "Not evaluated"}
                </dd>
              </div>
              {data.review.automatedGovernance?.evaluatedAt ? (
                <div className="flex justify-between">
                  <dt className="text-cp-muted">Evaluated</dt>
                  <dd className="text-cp-text">{formatDatetime(data.review.automatedGovernance.evaluatedAt)}</dd>
                </div>
              ) : null}
              {typeof data.review.automatedGovernance?.policyVersion === "number" ? (
                <div className="flex justify-between">
                  <dt className="text-cp-muted">Policy version</dt>
                  <dd className="text-cp-text">v{data.review.automatedGovernance.policyVersion}</dd>
                </div>
              ) : null}
            </dl>
          </section>

          <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
            <h2 className="text-base font-bold text-cp-text">Human Review</h2>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-cp-muted">Status</dt>
                <dd className="text-cp-text">{humanReviewStatusLabel(data.review.humanReview.status)}</dd>
              </div>
              {data.review.humanReview.reviewedAt ? (
                <div className="flex justify-between">
                  <dt className="text-cp-muted">Reviewed</dt>
                  <dd className="text-cp-text">{formatDatetime(data.review.humanReview.reviewedAt)}</dd>
                </div>
              ) : null}
            </dl>
            {isTerminalHumanReviewStatusLabel(data.review.humanReview.status) ? (
              <p className="mt-3 rounded-lg bg-cp-raised px-3 py-2 text-xs text-cp-muted">
                This review has reached a final decision and can no longer be changed.
              </p>
            ) : null}
            {justSubmitted ? (
              <p className="mt-3 rounded-lg bg-emerald-900/20 px-3 py-2 text-xs text-emerald-400">
                Your decision was recorded during this session.
              </p>
            ) : null}
          </section>

          <AdaptiveMultiReviewerPanelSection runId={runId} expectedGovernanceUpdatedAt={data.review.updatedAt} onPanelStatusChange={setPanelStatus} />

          {/*
            Multi-Reviewer Owner Override, Part F (§F11) — the
            single-reviewer assignment section and decision form remain
            completely UNCHANGED, but are hidden while a multi-reviewer
            panel is open or already finalized (an active/decided panel
            replaces direct single-review for this run). Restored exactly
            as before once the panel is cancelled or absent.
          */}
          {!singleReviewerUiHidden ? (
            <>
              <AdaptiveReviewAssignmentSection runId={runId} reviewPending={data.review.reviewable} />

              <AdaptiveReviewHistorySection runId={runId} canonicalTerminal={!data.review.reviewable} />

              {/*
                Query-Routing Redesign, Phase 2A, Step 7, Part E2 — the form
                renders ONLY when the canonical record is currently reviewable
                (server-computed `reviewable`, itself
                `isHumanReviewStatusReviewable(humanReview.status)` — i.e.
                "unreviewed" or "pending"). Any terminal status, an unsupported
                record, or an access-denied/error state all fall through to no
                form at all, per §26.4's own requirement.
              */}
              {data.review.reviewable ? (
                <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
                  <AdaptiveReviewDecisionForm
                    runId={runId}
                    expectedUpdatedAt={data.review.updatedAt}
                    onSuccess={handleDecisionSuccess}
                    onRequestReload={handleRequestReload}
                  />
                </section>
              ) : null}
            </>
          ) : (
            <AdaptiveReviewHistorySection runId={runId} canonicalTerminal={!data.review.reviewable} />
          )}
        </div>
      ) : null}
    </div>
  );
}
