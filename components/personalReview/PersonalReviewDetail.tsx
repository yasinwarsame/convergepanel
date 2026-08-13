"use client";

/**
 * Personal Reviewer Inbox + Action Flow — the reviewer-facing detail/
 * decision page for a personal assignment. Mirrors
 * components/teamGovernance/AdaptiveReviewDetail.tsx's structure closely,
 * but fetches from the owner-or-personal-reviewer routes
 * (GET /api/user/runs/[runId] + .../governance) instead of the team-only
 * detail route, and has no assignment/multi-reviewer-panel sections at
 * all — neither concept exists for a personal (teamId: null) review.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { answerShapeLabel, schemaLabel } from "@/lib/governance/teamReviewLabels";
import type { AdaptiveReviewSubmissionResult as SubmissionResult } from "@/lib/client/adaptiveReviewSubmission";
import GovernanceStatusBadge from "@/components/teamGovernance/GovernanceStatusBadge";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";
import AdaptiveReviewDecisionForm from "@/components/teamGovernance/AdaptiveReviewDecisionForm";
import { ReviewHistory } from "@/components/adaptive/ReviewGovernanceSection";
import PersonalReviewStatusBadge from "./PersonalReviewStatusBadge";
import type { PersonalReviewInboxStatus } from "@/lib/governance/personalReviewInbox";
import { personalReviewInboxStatus } from "@/lib/governance/personalReviewInbox";

function formatDatetime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function CollapsibleList({ title, items }: { title: string; items: string[] }) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;
  const sectionId = `personal-review-section-${title.toLowerCase().replace(/\s+/g, "-")}`;
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

type LoadedData = {
  humanReviewStatus: PersonalReviewInboxStatus;
  reviewable: boolean;
  governanceUpdatedAt: string;
  schemaId: string;
  answerShape: string;
  decisionReceipt: {
    conclusion: string;
    basis: string[];
    assumptions: string[];
    uncertainties: string[];
    limitations: string[];
    sourceBacked: boolean;
    humanReviewNeeded: boolean;
  };
  automatedGovernanceStatus?: string;
};

export default function PersonalReviewDetail({ runId }: { runId: string }) {
  const { user, loading: authLoading, authReady } = useAuth();
  const [data, setData] = useState<LoadedData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [justSubmitted, setJustSubmitted] = useState(false);

  const load = useCallback(
    async (opts?: { background?: boolean }) => {
      if (!user || !authReady) return;
      if (!opts?.background) {
        setLoading(true);
        setError(null);
      }
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const [reportRes, govRes] = await Promise.all([
          authedFetch(`/api/user/runs/${encodeURIComponent(runId)}`, { user, authReady, method: "GET", cache: "no-store" }),
          authedFetch(`/api/user/runs/${encodeURIComponent(runId)}/governance`, { user, authReady, method: "GET", cache: "no-store" }),
        ]);

        if (!reportRes.ok || !govRes.ok) {
          const status = !reportRes.ok ? reportRes.status : govRes.status;
          if (opts?.background) {
            setRefreshNotice("Could not refresh the latest details, but your decision was recorded.");
            return;
          }
          if (status === 401 || status === 403) {
            setError("You don't have access to this review.");
          } else if (status === 404) {
            setError("This review could not be found.");
          } else {
            setError("This review is temporarily unavailable. Please try again.");
          }
          setData(null);
          return;
        }

        const reportJson = await reportRes.json();
        const govJson = await govRes.json();

        if (!reportJson.ok || !govJson.ok || reportJson.viewerRole !== "personal_reviewer" || !govJson.decisionReceipt) {
          if (!opts?.background) {
            setError(reportJson.viewerRole !== "personal_reviewer" ? "You don't have access to this review." : "This review is temporarily unavailable. Please try again.");
            setData(null);
          }
          return;
        }

        // Sourced entirely from the governance route's own parsed
        // governanceRecord — never /api/user/runs/[runId]'s separate,
        // stricter parsePersistedAdaptiveOutput gate on the full
        // adaptiveOutput envelope, which is a different concern and must
        // not silently gate whether a decision can be submitted.
        const VALID_STATUSES = new Set(["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"]);
        const rawStatus: string | undefined = typeof govJson.humanReviewStatus === "string" && VALID_STATUSES.has(govJson.humanReviewStatus) ? govJson.humanReviewStatus : undefined;
        const humanReviewStatus = personalReviewInboxStatus((rawStatus ?? "unreviewed") as Parameters<typeof personalReviewInboxStatus>[0]);

        setData({
          humanReviewStatus,
          reviewable: rawStatus === "unreviewed" || rawStatus === "pending",
          governanceUpdatedAt: govJson.governanceUpdatedAt,
          schemaId: govJson.schemaId,
          answerShape: govJson.answerShape,
          decisionReceipt: govJson.decisionReceipt,
          automatedGovernanceStatus: reportJson.adaptive?.automatedGovernanceStatus,
        });
        setError(null);
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

  const handleDecisionSuccess = (result: Extract<SubmissionResult, { kind: "success" }>) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            humanReviewStatus: personalReviewInboxStatus(result.status),
            reviewable: false,
            governanceUpdatedAt: result.reviewedAt,
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
        href="/reviews"
        className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-cp-text transition-colors hover:text-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 rounded"
      >
        <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
        Back to my reviews
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
              <h1 className="text-xl font-bold text-cp-text">{schemaLabel(data.schemaId)}</h1>
              <span className="text-sm text-cp-muted">{answerShapeLabel(data.answerShape)}</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <GovernanceStatusBadge status={data.automatedGovernanceStatus} />
              <PersonalReviewStatusBadge status={data.humanReviewStatus} />
            </div>
            {refreshNotice ? <p className="mt-2 text-xs text-amber-400">{refreshNotice}</p> : null}
          </header>

          <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
            <h2 className="text-base font-bold text-cp-text">Decision Receipt</h2>
            <p className="mt-3 text-sm leading-relaxed text-cp-text">{data.decisionReceipt.conclusion}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-cp-muted">
              <span>{data.decisionReceipt.sourceBacked ? "Source-backed" : "Not source-backed"}</span>
              <span aria-hidden>&middot;</span>
              <span>{data.decisionReceipt.humanReviewNeeded ? "Human review needed" : "Human review not flagged as needed"}</span>
            </div>
            <div className="mt-4 space-y-3">
              <CollapsibleList title="Basis" items={data.decisionReceipt.basis} />
              <CollapsibleList title="Assumptions" items={data.decisionReceipt.assumptions} />
              <CollapsibleList title="Uncertainties" items={data.decisionReceipt.uncertainties} />
              <CollapsibleList title="Limitations" items={data.decisionReceipt.limitations} />
            </div>
          </section>

          {!data.reviewable ? (
            <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
              <p className="rounded-lg bg-cp-raised px-3 py-2 text-sm text-cp-muted">This review has reached a final decision and can no longer be changed.</p>
            </section>
          ) : null}

          {justSubmitted ? (
            <p className="rounded-lg bg-emerald-900/20 px-3 py-2 text-xs text-emerald-400">Your decision was recorded during this session.</p>
          ) : null}

          {data.reviewable ? (
            <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
              <AdaptiveReviewDecisionForm
                runId={runId}
                expectedUpdatedAt={data.governanceUpdatedAt}
                onSuccess={handleDecisionSuccess}
                onRequestReload={handleRequestReload}
                scope="personal"
              />
            </section>
          ) : null}

          {/* Governance Follow-Up Hardening — the assigned reviewer sees the
              same safe history the owner sees for this exact run, reusing
              the shared ReviewHistory component (scope="personal") rather
              than a second history UI. Central access resolver (via
              GET /api/user/runs/[runId]/review-history) already confirmed
              this reviewer is allowed on this specific run — nothing
              owner-only is exposed. */}
          <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
            <ReviewHistory runId={runId} canonicalTerminal={!data.reviewable} scope="personal" />
          </section>
        </div>
      ) : null}
    </div>
  );
}
