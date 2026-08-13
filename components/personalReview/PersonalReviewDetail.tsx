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
import { useAuth } from "@/components/AuthProvider";
import { answerShapeLabel, schemaLabel } from "@/lib/governance/teamReviewLabels";
import type { AdaptiveReviewSubmissionResult as SubmissionResult } from "@/lib/client/adaptiveReviewSubmission";
import GovernanceStatusBadge from "@/components/teamGovernance/GovernanceStatusBadge";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";
import AdaptiveReviewDecisionForm from "@/components/teamGovernance/AdaptiveReviewDecisionForm";
import { ReviewHistory } from "@/components/adaptive/ReviewGovernanceSection";
import PersonalReviewStatusBadge from "./PersonalReviewStatusBadge";
import ReviewerNavigation from "./ReviewerNavigation";
import type { PersonalReviewInboxStatus } from "@/lib/governance/personalReviewInbox";
import { personalReviewInboxStatus } from "@/lib/governance/personalReviewInbox";
import type { ReviewGovernanceViewModel } from "@/lib/adaptiveSchema/reviewGovernanceViewModel";

function formatDatetime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface ReviewerIdentity {
  displayName: string | null;
  /** "reviewed" once a decision exists, "assigned" while only the assignment (no decision yet) exists. */
  relationship: "assigned" | "reviewed" | null;
}

/**
 * Pure — derives this run's reviewer identity from the SAME governance
 * detail response (`GET /api/user/runs/[runId]/governance`'s `governance`
 * field) that `ReviewGovernanceSection`/`ReviewHistory` already consume, so
 * this page's header, the Review & Governance section, and Review History
 * can never disagree on who reviewed/is assigned to a run — one canonical
 * resolution (`buildReviewGovernanceViewModel` + `reviewerIdentity.ts`'s
 * safe fallback chain), never a second lookup implementation.
 *
 * Schema-agnostic by construction: reads only `family`/`singleReviewer`/
 * `assignment`, never `schemaId` — the identical derivation applies to
 * Decision Support, Deep Research, Ranked List, or any other Milestone-2
 * schema, since they all share this one component and this one response
 * shape. Legacy-family schemas never reach this page at all (gated
 * upstream by the `decisionReceipt` check in `load()` below, which only
 * Milestone-2's `governanceRecord` ever populates).
 *
 * Precedence mirrors `SingleReviewerIdentityCard` exactly: a completed
 * decision (`singleReviewer`) takes priority over the still-open
 * `assignment`, since a decided run's assignment record still exists but
 * its identity is more precisely shown via the decision itself.
 */
export function deriveReviewerIdentity(governance: ReviewGovernanceViewModel | null | undefined): ReviewerIdentity {
  if (governance?.family !== "milestone2") return { displayName: null, relationship: null };
  if (governance.singleReviewer?.displayName) {
    return { displayName: governance.singleReviewer.displayName, relationship: "reviewed" };
  }
  if (governance.assignment?.reviewerDisplayName) {
    return { displayName: governance.assignment.reviewerDisplayName, relationship: "assigned" };
  }
  return { displayName: null, relationship: null };
}

/**
 * Pure presentational — status-aware "Assigned to <name>" / "Reviewed by
 * <name>" text. Renders nothing when no canonical identity is available
 * (never fabricates a placeholder here; `reviewerDisplayName` itself is
 * already guaranteed non-blank by the shared resolver's own fallback chain
 * whenever a canonical assignment/decision exists — name, else masked
 * email, else "Reviewer unavailable", never "Unknown"). Actual text, not
 * color-only, so it reads correctly to a screen reader on its own.
 */
export function ReviewerIdentityLine({ displayName, relationship }: ReviewerIdentity) {
  if (!displayName) return null;
  return (
    <p className="mt-2 text-sm font-medium text-cp-text">
      {relationship === "reviewed" ? "Reviewed by " : "Assigned to "}
      {displayName}
    </p>
  );
}

export type AutomatedGovernanceStatusValue = "passed" | "flagged" | "blocked" | "not_evaluated" | "error";

/**
 * Pure — renders the automated-governance badge only when the run has a
 * real, persisted automated-governance record (`governanceRecord.
 * automatedGovernance`). This is the fix for the reported "Unknown" badge:
 * that badge was never reviewer identity — it's `GovernanceStatusBadge`
 * rendering its own generic fallback because the field it was fed
 * (`GET /api/user/runs/[runId]`'s `adaptive.automatedGovernanceStatus`)
 * is never actually populated on a read (only in the ephemeral run-panel
 * generation response). The real field is `governanceRecord.
 * automatedGovernance.status`, mirroring exactly what
 * `AdaptiveReviewDetailResponseV1` (the team detail route) already
 * exposes. "No automated-governance record at all" and "a genuine
 * `not_evaluated` status" are two different, non-interchangeable states —
 * the former renders no badge, the latter renders a truthful "Not
 * Evaluated" badge via the unchanged, shared `GovernanceStatusBadge`.
 */
export function AutomatedGovernanceStatusIndicator({ automatedGovernance }: { automatedGovernance: { status: AutomatedGovernanceStatusValue } | null }) {
  if (!automatedGovernance) return null;
  return <GovernanceStatusBadge status={automatedGovernance.status} />;
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
  /**
   * The run's persisted, canonical automated-governance record
   * (`governanceRecord.automatedGovernance`), sourced from the governance
   * route — the SAME field `AdaptiveReviewDetailResponseV1` (the team
   * detail route) already exposes. `null` when the run genuinely has no
   * automated-governance record at all (never evaluated for this run) —
   * the header renders no badge in that case, never a fabricated
   * "Unknown". Previously this field was read from
   * `GET /api/user/runs/[runId]`'s `adaptive.automatedGovernanceStatus`,
   * which that route never actually populates on a read (it's only ever
   * set in the ephemeral POST /api/run-panel response at generation time)
   * — that was the real cause of the "Unknown" badge always appearing on
   * this page, not a reviewer-identity problem at all.
   */
  automatedGovernance: { status: "passed" | "flagged" | "blocked" | "not_evaluated" | "error" } | null;
  reviewer: ReviewerIdentity;
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
          automatedGovernance: govJson.automatedGovernance ?? null,
          reviewer: deriveReviewerIdentity(govJson.governance),
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
      <ReviewerNavigation showBackToReviews={true} />

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
              <AutomatedGovernanceStatusIndicator automatedGovernance={data.automatedGovernance} />
              <PersonalReviewStatusBadge status={data.humanReviewStatus} />
            </div>
            <ReviewerIdentityLine displayName={data.reviewer.displayName} relationship={data.reviewer.relationship} />
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
