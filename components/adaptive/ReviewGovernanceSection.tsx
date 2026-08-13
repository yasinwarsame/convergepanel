"use client";

/**
 * Adaptive Synthesis Report — "Review & Governance" section: review
 * status, assignment, peer-review panel/quorum/vote progress, final
 * decision, owner override, cancellation, conditions, the Verification
 * Gate, Panel Verdict, and review history — collapsed by default, with a
 * compact one-line status summary visible in the `<summary>` itself so a
 * user never has to expand the section just to see whether anything
 * meaningful is inside it (e.g. "Approved · Jane Smith", "Assigned ·
 * Jane Smith", "Not configured").
 *
 * DELIBERATE, DISCLOSED CONTRACT CHANGE from the prior version of this
 * file: this component now renders resolved REVIEWER IDENTITY (names),
 * fetched from the new `GET /api/user/runs/[runId]/governance` endpoint
 * (`lib/adaptiveSchema/reviewGovernanceViewModel.ts`'s DTO). Comment and
 * override-justification TEXT remain permanently hidden — the data model
 * has no public/private split for them, so the whole concept is treated
 * as non-report-visible, exactly as before. Only identity changed.
 *
 * Split into a data-fetching shell (`ReviewGovernanceSection`, the
 * default export — a thin `"use client"` hook wrapper) and a pure,
 * presentational body (`ReviewGovernanceBody`, exported for direct
 * testing) that takes already-resolved `loading`/`unavailable`/`detail`
 * as plain props — this project's Jest config runs under
 * `testEnvironment: "node"` (no jsdom), so `useEffect` never fires under
 * `renderToStaticMarkup`; testing every status scenario (not just the
 * pre-fetch initial render) requires exercising the presentational body
 * directly with hand-built view-model fixtures, never a mocked fetch.
 *
 * Family-aware throughout (see reviewGovernanceViewModel.ts): a
 * Milestone-2 result is never rendered from a legacy-only field or vice
 * versa. The existing `StatusSummary` (Milestone-2-only, driven by the
 * compact `humanReview`/`reviewRouting`/`persistenceStatus` props every
 * report call site already threads down) is used ONLY for the milestone2
 * family; the legacy family gets its own `LegacyReviewCard`, since
 * `humanReview` is always null for legacy-active schemas and showing
 * `StatusSummary` for them would misleadingly read "Incomplete" for a
 * run that actually has a real legacy `governanceStatus`.
 *
 * Read-only throughout: no mutation surface, no decision form, no link
 * to a decision-mutation endpoint — matches AdaptiveReviewHistorySection's
 * own read-only guarantee.
 */

import { useEffect, useState } from "react";
import { ModelId } from "@/lib/types";
import { useAuth } from "@/components/AuthProvider";
import type { AdaptiveReviewHistoryResponseV1 } from "@/lib/governance/adaptiveHumanReviewHistory";
import { humanReviewStatusLabel } from "@/lib/governance/teamReviewLabels";
import { deriveReportStatus, REPORT_STATUS_LABELS, ReportStatusInput } from "@/lib/adaptiveSchema/reportStatus";
import { decidedViaLabel, ReviewGovernanceReviewerView, ReviewGovernanceViewModel } from "@/lib/adaptiveSchema/reviewGovernanceViewModel";
import { AdaptiveGateResult, AdaptiveSynthesisReport } from "@/lib/adaptiveSchema/types";
import { Card, SectionLabel } from "./shared";
import AdaptiveSynthesisReportView, { PanelVerdictCard } from "./AdaptiveSynthesisReportView";

const TERMINAL_STATUS_KINDS = new Set(["approved", "approved_with_conditions", "changes_requested", "rejected"]);

const GATE_STYLES: Record<AdaptiveGateResult["status"], { label: string; className: string }> = {
  pass: { label: "Verified — panel converges", className: "bg-green-50 text-green-800 border-green-200" },
  caution: { label: "Caution — partial convergence", className: "bg-amber-50 text-amber-800 border-amber-200" },
  fail: { label: "Could not verify — panel split", className: "bg-red-50 text-red-800 border-red-200" },
};

const LEGACY_STATUS_LABELS: Record<"approved" | "needs_review" | "blocked", string> = {
  approved: "Approved",
  needs_review: "Needs review",
  blocked: "Blocked by policy",
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
      {humanReview?.decidedVia && <p className="mt-1 text-xs text-slate-500">Decided via: {decidedViaLabel(humanReview.decidedVia)}</p>}
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

function NotConfiguredCard() {
  return (
    <Card>
      <SectionLabel>Review status</SectionLabel>
      <p className="text-sm font-medium text-slate-900">Not configured</p>
    </Card>
  );
}

function LoadingStatusCard() {
  return (
    <Card>
      <SectionLabel>Review status</SectionLabel>
      <p className="text-sm text-slate-500" aria-live="polite">
        Loading review status…
      </p>
    </Card>
  );
}

function UnavailableStatusCard() {
  return (
    <Card>
      <SectionLabel>Review status</SectionLabel>
      <p className="text-sm text-slate-500" role="status">
        Review information unavailable.
      </p>
    </Card>
  );
}

function LegacyReviewCard({ legacy }: { legacy: Extract<ReviewGovernanceViewModel, { family: "legacy" }> }) {
  return (
    <Card>
      <SectionLabel>Review status</SectionLabel>
      <p className="text-sm font-medium text-slate-900">{LEGACY_STATUS_LABELS[legacy.status]}</p>
      {legacy.reviewer && <p className="mt-1 text-xs text-slate-500">Reviewer: {legacy.reviewer.displayName}</p>}
      {legacy.reviewedAt && <p className="mt-0.5 text-xs text-slate-500">Reviewed {formatDatetime(legacy.reviewedAt)}</p>}
      {legacy.reasons.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">Reasons</p>
          <ul className="list-disc list-outside pl-5 space-y-0.5 text-sm text-slate-700">
            {legacy.reasons.map((r, idx) => (
              <li key={idx}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

type Milestone2Assignment = Extract<ReviewGovernanceViewModel, { family: "milestone2" }>["assignment"];
type Milestone2SingleReviewer = Extract<ReviewGovernanceViewModel, { family: "milestone2" }>["singleReviewer"];
type Milestone2Panel = Extract<ReviewGovernanceViewModel, { family: "milestone2" }>["panel"];

/** Assignment (pre-decision) and single-reviewer identity (post-decision) share one card — never both at once, since a decided run's assignment record still exists but its identity is more precisely shown via `singleReviewer`. */
function SingleReviewerIdentityCard({ assignment, singleReviewer }: { assignment: Milestone2Assignment; singleReviewer: Milestone2SingleReviewer }) {
  if (singleReviewer) {
    return (
      <Card>
        <SectionLabel>Reviewer</SectionLabel>
        <p className="text-sm font-medium text-slate-900">{singleReviewer.displayName}</p>
        {singleReviewer.reviewedAt && <p className="mt-1 text-xs text-slate-500">Completed {formatDatetime(singleReviewer.reviewedAt)}</p>}
      </Card>
    );
  }
  if (assignment) {
    return (
      <Card>
        <SectionLabel>Assigned reviewer</SectionLabel>
        <p className="text-sm font-medium text-slate-900">{assignment.reviewerDisplayName}</p>
        {assignment.assignedAt && (
          <p className="mt-1 text-xs text-slate-500">
            Assigned {formatDatetime(assignment.assignedAt)}
            {assignment.assignedByDisplayName ? ` by ${assignment.assignedByDisplayName}` : ""}
          </p>
        )}
      </Card>
    );
  }
  return null;
}

function AwaitingAssignmentNote() {
  return <p className="text-xs text-slate-500 italic">Awaiting assignment to a reviewer.</p>;
}

function ReviewerRow({ reviewer }: { reviewer: ReviewGovernanceReviewerView }) {
  return (
    <li className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-slate-900">{reviewer.displayName}</span>
        <span className="text-xs text-slate-600">{reviewer.hasVoted ? humanReviewStatusLabel(reviewer.voteStatus) : "Awaiting vote"}</span>
      </div>
      {reviewer.submittedAt && <p className="mt-0.5 text-xs text-slate-500">Completed {formatDatetime(reviewer.submittedAt)}</p>}
    </li>
  );
}

function PeerReviewProgress({ panel }: { panel: NonNullable<Milestone2Panel> }) {
  const pct = panel.quorum > 0 ? Math.min(100, (panel.submittedCount / panel.quorum) * 100) : 0;
  const pending = Math.max(0, panel.requiredReviewerCount - panel.submittedCount);
  return (
    <Card>
      <SectionLabel>Peer review</SectionLabel>
      <p className="text-sm text-slate-700">
        {panel.submittedCount} of {panel.quorum} needed ({panel.requiredReviewerCount} total reviewer{panel.requiredReviewerCount === 1 ? "" : "s"})
      </p>
      <div className="mt-2 h-2 w-full rounded-full bg-slate-100 overflow-hidden" role="progressbar" aria-valuenow={panel.submittedCount} aria-valuemin={0} aria-valuemax={panel.quorum}>
        <div className="h-full bg-sky-500" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Approved: {panel.approvalCount} · Changes requested/Rejected: {panel.blockingCount} · Pending: {pending}
      </p>
    </Card>
  );
}

function ReviewerList({ reviewers }: { reviewers: ReviewGovernanceReviewerView[] }) {
  if (reviewers.length === 0) return null;
  return (
    <div>
      <SectionLabel>Reviewers</SectionLabel>
      <ul className="space-y-2" aria-label="Reviewers">
        {reviewers.map((r) => (
          <ReviewerRow key={r.reviewerKey} reviewer={r} />
        ))}
      </ul>
    </div>
  );
}

function FinalDecisionCard({ panel }: { panel: NonNullable<Milestone2Panel> }) {
  if (!panel.finalStatus) return null;
  return (
    <Card className="border-green-200 bg-green-50">
      <SectionLabel>Final review result</SectionLabel>
      <p className="text-sm font-semibold text-slate-900">{humanReviewStatusLabel(panel.finalStatus)}</p>
      {panel.finalizedAt && <p className="mt-1 text-xs text-slate-600">Finalized {formatDatetime(panel.finalizedAt)}</p>}
      {panel.finalizedVia && (
        <p className="mt-0.5 text-xs text-slate-500">Decided via: {panel.finalizedVia === "aggregation" ? "Reviewer panel (majority)" : "Owner override"}</p>
      )}
    </Card>
  );
}

function OwnerOverrideBanner({ panel }: { panel: NonNullable<Milestone2Panel> }) {
  if (!panel.finalStatus) return null;
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Owner override</p>
      <p className="mt-1 text-sm font-semibold text-slate-900">{humanReviewStatusLabel(panel.finalStatus)}</p>
      {panel.overrideBy && (
        <p className="mt-1 text-xs text-amber-800">
          Decided by {panel.overrideBy.displayName}
          {panel.finalizedAt ? ` on ${formatDatetime(panel.finalizedAt)}` : ""}
        </p>
      )}
    </div>
  );
}

function CancellationBanner() {
  return (
    <div className="rounded-xl border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700" role="status">
      Peer review was cancelled. This run reverted to the single-reviewer review path.
    </div>
  );
}

export type ReviewHistoryScope = "team" | "personal";

/** Items from either history endpoint; `reviewerDisplayName` is only ever present on the personal-scope response (`/api/user/runs/[runId]/review-history`) — the team endpoint's contract deliberately excludes reviewer identity, so this stays optional and simply doesn't render for team items. */
type ReviewHistoryItem = AdaptiveReviewHistoryResponseV1["items"][number] & { reviewerDisplayName?: string };

/** Governance Follow-Up Hardening — the single place either history URL is constructed, mirroring the established `decisionRouteUrl()` pattern (lib/client/adaptiveReviewSubmission.ts) for the same team/personal split. */
function historyRouteUrl(scope: ReviewHistoryScope, runId: string): string {
  return scope === "personal"
    ? `/api/user/runs/${encodeURIComponent(runId)}/review-history`
    : `/api/teams/adaptive-runs/${encodeURIComponent(runId)}/history`;
}

export function ReviewHistory({ runId, canonicalTerminal, scope = "team" }: { runId: string; canonicalTerminal: boolean; scope?: ReviewHistoryScope }) {
  const { user, authReady } = useAuth();
  const [items, setItems] = useState<ReviewHistoryItem[] | null>(null);
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
        const res = await authedFetch(historyRouteUrl(scope, runId), {
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
          setItems(json.items as ReviewHistoryItem[]);
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
  }, [user, authReady, runId, scope]);

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
              <p className="mt-0.5 text-xs text-slate-500">
                Decided {formatDatetime(item.reviewedAt)}
                {item.reviewerDisplayName ? ` by ${item.reviewerDisplayName}` : ""}
              </p>
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

function collapsedSummaryLabel(args: {
  loading: boolean;
  unavailable: boolean;
  detail: ReviewGovernanceViewModel | null;
  humanReview: ReportStatusInput["humanReview"];
  reviewRouting: ReportStatusInput["reviewRouting"];
  persistenceStatus: ReportStatusInput["persistenceStatus"];
}): string {
  const { loading, unavailable, detail, humanReview, reviewRouting, persistenceStatus } = args;
  const prefix = "Review & Governance";

  if (persistenceStatus === "failed" || persistenceStatus === "omitted_size_limit") return `${prefix} — Incomplete`;
  if (loading) return `${prefix} — loading…`;
  if (unavailable) return `${prefix} — status unavailable`;
  if (!detail || detail.family === "not_configured") return `${prefix} — Not configured`;

  if (detail.family === "legacy") {
    const label = LEGACY_STATUS_LABELS[detail.status];
    return detail.reviewer ? `${prefix} — ${label} · ${detail.reviewer.displayName}` : `${prefix} — ${label}`;
  }

  // milestone2 — reuse the exact same status derivation StatusSummary
  // itself calls, so the collapsed line and the expanded body can never
  // disagree on the status label.
  const topStatus = deriveReportStatus({ humanReview, reviewRouting, persistenceStatus });
  let label = topStatus.isOwnerOverride ? `Owner override — ${REPORT_STATUS_LABELS[topStatus.kind]}` : REPORT_STATUS_LABELS[topStatus.kind];

  let who: string | undefined;
  if (topStatus.kind === "unreviewed_in_queue" && detail.assignment) {
    // "Assigned" is more useful than the more precise "Unreviewed — in
    // queue" for this one compact line specifically — the expanded
    // StatusSummary below still shows the precise wording; REPORT_STATUS_LABELS
    // itself is never changed.
    label = "Assigned";
    who = detail.assignment.reviewerDisplayName;
  } else if (detail.panel?.overrideBy) {
    who = detail.panel.overrideBy.displayName;
  } else if (detail.singleReviewer) {
    who = detail.singleReviewer.displayName;
  } else if (detail.panel && detail.panel.status === "open" && detail.assignment) {
    who = detail.assignment.reviewerDisplayName;
  }

  return who ? `${prefix} — ${label} · ${who}` : `${prefix} — ${label}`;
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

interface ReviewGovernanceBodyProps extends ReviewGovernanceSectionProps {
  loading: boolean;
  unavailable: boolean;
  detail: ReviewGovernanceViewModel | null;
  /** From the same governance fetch's `historyScope` field — routes ReviewHistory to the correct endpoint. Absent/"unknown" defaults to "team" (existing behavior, zero regression for every current call site). */
  historyScope?: "team" | "personal" | "unknown";
}

/** Pure presentational body — no fetch, no hooks. Exported so every status scenario can be tested directly with a hand-built `detail` fixture (see the test suite's own doc comment on why this split exists). */
export function ReviewGovernanceBody({
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
  loading,
  unavailable,
  detail,
  historyScope,
}: ReviewGovernanceBodyProps) {
  const status = deriveReportStatus({ humanReview, reviewRouting, persistenceStatus });
  const canonicalTerminal = TERMINAL_STATUS_KINDS.has(status.kind);
  const isIncomplete = persistenceStatus === "failed" || persistenceStatus === "omitted_size_limit";

  const summaryLabel = collapsedSummaryLabel({ loading, unavailable, detail, humanReview, reviewRouting, persistenceStatus });

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">{summaryLabel}</summary>
      <div className="mt-3 space-y-3">
        {isIncomplete ? (
          <StatusSummary humanReview={humanReview} reviewRouting={reviewRouting} persistenceStatus={persistenceStatus} />
        ) : loading ? (
          <LoadingStatusCard />
        ) : unavailable ? (
          <UnavailableStatusCard />
        ) : !detail || detail.family === "not_configured" ? (
          <NotConfiguredCard />
        ) : detail.family === "legacy" ? (
          <LegacyReviewCard legacy={detail} />
        ) : (
          <>
            <StatusSummary humanReview={humanReview} reviewRouting={reviewRouting} persistenceStatus={persistenceStatus} />

            {!detail.panel && (detail.assignment || detail.singleReviewer) && (
              <SingleReviewerIdentityCard assignment={detail.assignment} singleReviewer={detail.singleReviewer} />
            )}
            {!detail.panel && !detail.assignment && !detail.singleReviewer && status.kind === "unreviewed_in_queue" && <AwaitingAssignmentNote />}

            {detail.panel && (
              <>
                <PeerReviewProgress panel={detail.panel} />
                <ReviewerList reviewers={detail.panel.reviewers} />
                {detail.panel.status === "finalized" && detail.panel.finalizedVia === "owner_override" && <OwnerOverrideBanner panel={detail.panel} />}
                {detail.panel.status === "finalized" && detail.panel.finalizedVia !== "owner_override" && <FinalDecisionCard panel={detail.panel} />}
                {detail.panel.status === "cancelled" && <CancellationBanner />}
              </>
            )}
          </>
        )}

        {gate && <VerificationGate gate={gate.status} />}
        {gate && synthesisReport && <PanelVerdictCard report={synthesisReport} gate={gate} />}

        {/* GovernanceRecordV1 only exists for Milestone-2 schemas — skip the
            history fetch entirely (not just degrade it) when there's no
            governance record for this run to have a history for. */}
        {humanReview && runId && (
          <ReviewHistory runId={runId} canonicalTerminal={canonicalTerminal} scope={historyScope === "personal" ? "personal" : "team"} />
        )}

        {gate && synthesisReport && modelsUsed && question && (
          <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500">Full synthesis report</summary>
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

function VerificationGate({ gate }: { gate: AdaptiveGateResult["status"] }) {
  const style = GATE_STYLES[gate];
  return (
    <div>
      <SectionLabel>Verification gate</SectionLabel>
      <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${style.className}`}>{style.label}</div>
    </div>
  );
}

/** Fetches the presentation-safe governance DTO once per `runId`, at this level — so both the collapsed summary line and the expanded body read the SAME fetched state without a double-fetch. `<details>` children already mount and run effects regardless of open/closed state (the existing `ReviewHistory` fetch above already relies on this), so hoisting the fetch here (rather than nesting it inside a child, as `ReviewHistory` does) is what lets the collapsed `<summary>` show a reviewer name before the section is ever expanded. */
function useGovernanceDetail(runId: string | undefined | null) {
  const { user, authReady } = useAuth();
  const [detail, setDetail] = useState<ReviewGovernanceViewModel | null>(null);
  // Initialized from `runId`'s presence (not unconditionally `true`) so the
  // very first synchronous render is already accurate when no runId exists
  // — there is nothing to fetch, so it must never claim "loading".
  const [loading, setLoading] = useState<boolean>(!!runId);
  const [unavailable, setUnavailable] = useState(false);
  // Governance Follow-Up Hardening — captured from the SAME governance
  // fetch below (zero extra request), so ReviewHistory can route to the
  // correct endpoint without a fetch of its own to determine scope.
  const [historyScope, setHistoryScope] = useState<"team" | "personal" | "unknown">("unknown");

  useEffect(() => {
    if (!runId) {
      setLoading(false);
      return;
    }
    if (!user || !authReady) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setUnavailable(false);
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(`/api/user/runs/${encodeURIComponent(runId)}/governance`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          setUnavailable(true);
          setDetail(null);
          return;
        }
        const json = await res.json();
        if (json.ok) {
          setDetail(json.governance as ReviewGovernanceViewModel);
          setHistoryScope(json.historyScope === "personal" || json.historyScope === "team" ? json.historyScope : "unknown");
        } else {
          setUnavailable(true);
          setDetail(null);
        }
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          setDetail(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId, user, authReady]);

  return { detail, loading, unavailable, historyScope };
}

export default function ReviewGovernanceSection(props: ReviewGovernanceSectionProps) {
  const { detail, loading, unavailable, historyScope } = useGovernanceDetail(props.runId);
  return <ReviewGovernanceBody {...props} loading={loading} unavailable={unavailable} detail={detail} historyScope={historyScope} />;
}
