"use client";

/**
 * Approval Workflow, Phase 9C.2/9C.3 — the review workflow section hosted
 * on the permanent `/workspace/reviews/[runId]` detail route. Fetches
 * `review-context` (the sole presentation authority for review status,
 * assignment, `assignmentRevision`, panel state, and `viewer.can*` UX
 * hints — Phase 9C.2 §9/§10) and renders:
 *   - a read-only current-review summary
 *   - the assignment card (manager controls gated on `canManageAssignment`)
 *   - the ordinary decision form (gated on `canSubmitDecision`)
 *   - the resubmit action (gated on `canResubmit`)
 *   - the panel review section (Phase 9C.3/9C.4 — create/reconfigure/vote/
 *     finalize/cancel/override, each independently gated on its own
 *     `viewer.can*` field; see `WorkspacePanelReviewSection.tsx`)
 *
 * SCOPE (frozen, mandatory): still no history/audit UI, no panel round 2.
 * Owner Override UI shipped in Phase 9C.4 (`viewer.canOverride`, rendered
 * inside `WorkspacePanelReviewSection`, never here) — this section itself
 * still never reads or branches on `canOverride` directly.
 *
 * PANEL BOUNDARY (Phase 9C.0 Correction A / 9C.2 §52-§56, frozen): only
 * `panel.status === "open"` suppresses single-review controls — checked
 * here ONLY as a defensive, narrowing safety net alongside the
 * authoritative `viewer.can*` flags (which the backend already computes
 * with the identical `!panelOpen` condition) — never `if (panel) ...`,
 * which would incorrectly re-block the finalized-panel single-review
 * fallback Phase 9B.5.1/9B.5.2/9C.0 established. The panel section itself
 * is rendered unconditionally (it governs its own internal presentation
 * for every status, including `null`).
 *
 * DRAIN COMPOSITION (Phase 9C.4, replaces the old 9C.2/9C.3 fail-safe early
 * return): drain mode is no longer a dead end. `viewer.mode === "drain"` is
 * explicit, additional, DEFENSIVE narrowing on top of the already-correct
 * backend `viewer.can*` flags (`reviewContext.ts` already forces
 * `canManageAssignment`/`canSubmitDecision`/`canResubmit`/`canCreatePanel`/
 * `canReconfigurePanel` to `false` in drain) — `ReviewAssignmentCard`/
 * `ReviewDecisionForm`/`ReviewResubmitAction` are never even MOUNTED in
 * drain, not merely passed a `false` capability, so a stale/malformed
 * client fixture can never accidentally surface new-work controls.
 * `WorkspacePanelReviewSection` is rendered unconditionally in both modes;
 * `canVote`/`canFinalize`/`canCancelPanel`/`canOverride` are already
 * correctly drain-eligible (or not) straight from the backend, needing no
 * local mode branching there. Panel CREATE/RECONFIGURE are the exception
 * (Phase 9C.4-R1C): drain never admits new-work panel creation or
 * reconfiguration, so the canonical `viewer.mode` is threaded down as an
 * explicit `mode` prop and defensively narrows those two affordances
 * independent of `canCreatePanel`/`canReconfigurePanel` — see
 * `WorkspacePanelReviewSection.tsx`'s own module doc comment.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { getReviewContext, hasUsableDecisionReceipt, GENERIC_CONTEXT_ERROR_MESSAGE, REVIEW_UNAVAILABLE_MESSAGE, COMPLETION_MODE_BANNER_MESSAGE, type WorkspaceReviewContext } from "@/lib/client/workspaceReviewClient";
import { getReviewStatusLabel, getReviewStatusBadgeClass, isApprovedWithConditions, formatAbsoluteDate } from "@/lib/workspaces/reviewQueuePresentation";
import DecisionReceiptSection from "./DecisionReceiptSection";
import ReviewAssignmentCard from "./ReviewAssignmentCard";
import ReviewDecisionForm from "./ReviewDecisionForm";
import ReviewResubmitAction from "./ReviewResubmitAction";
import WorkspacePanelReviewSection from "./WorkspacePanelReviewSection";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";

function decidedViaCaption(decidedVia: WorkspaceReviewContext["review"]["decidedVia"]): string | null {
  if (decidedVia === "multi_reviewer_panel") return "Decided via panel review";
  if (decidedVia === "multi_reviewer_owner_override") return "Decided via owner override";
  return null;
}

export default function WorkspaceRunReviewSection({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const { user, authReady } = useAuth();
  const [context, setContext] = useState<WorkspaceReviewContext | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "not_found">("loading");

  // Latest-request-wins — a stale context response must never overwrite
  // newer state produced by a mutation's own refetch (§61/§83).
  const requestIdRef = useRef(0);

  /**
   * Phase 9C.3-R2C — genuinely awaitable. The returned Promise settles only
   * once the review-context request has completed AND (when this request
   * is still the latest — a superseded request resolves immediately
   * without touching state, which is the correct completion signal for
   * ITS caller too) the resulting canonical state has been committed via
   * `setContext`/`setStatus`. Callers (panel/assignment/decision/resubmit
   * mutation handlers) `await` this before releasing their own mutation
   * lock, so a caller can never proceed against pre-refresh stale
   * `panel.revision`/`governanceUpdatedAt`/`can*` state. Deliberately NOT
   * `Promise.resolve()`-wrapped around a fire-and-forget IIFE — that would
   * satisfy the type signature while preserving the exact defect this
   * correction exists to fix.
   */
  const refreshContext = useCallback((): Promise<void> => {
    if (!authReady) return Promise.resolve();
    const requestId = ++requestIdRef.current;
    setStatus((prev) => (prev === "ready" ? prev : "loading"));
    return (async () => {
      const result = await getReviewContext({ workspaceId, runId, user, authReady });
      if (requestIdRef.current !== requestId) return;
      if (result.status === "ok") {
        setContext(result.context);
        setStatus("ready");
      } else if (result.status === "not_found") {
        setStatus("not_found");
      } else {
        setStatus("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, runId, authReady, user?.uid]);

  useEffect(() => {
    refreshContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, runId, authReady, user?.uid]);

  if (status === "loading" && !context) {
    return (
      <section className="mt-8" role="status" aria-label="Loading review details">
        <div className="rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">Loading review details…</div>
      </section>
    );
  }

  if (status === "not_found") {
    return (
      <section className="mt-8">
        <ReviewErrorState message={REVIEW_UNAVAILABLE_MESSAGE} />
      </section>
    );
  }

  if (status === "error" && !context) {
    return (
      <section className="mt-8">
        <ReviewErrorState message={GENERIC_CONTEXT_ERROR_MESSAGE} onRetry={refreshContext} />
      </section>
    );
  }

  if (!context) return null;

  const { review, decisionReceipt, assignment, assignmentRevision, panel, viewer } = context;
  const statusLabel = getReviewStatusLabel(review.status);
  const statusClass = getReviewStatusBadgeClass(review.status);
  const caption = decidedViaCaption(review.decidedVia);

  // Defensive narrowing only — never widens what viewer.can* already
  // grants; see module doc comment.
  const panelOpen = panel?.status === "open";
  const isDrain = viewer.mode === "drain";

  // REVIEW_DECISION_UI_REQUIRES_DECISION_RECEIPT (10C.4A-U2) — a reviewer
  // must never be presented with actionable terminal-decision controls
  // (ordinary decision, panel vote, Owner Override) for an artifact that
  // didn't actually arrive. See hasUsableDecisionReceipt()'s own doc
  // comment for why this is a defensive backstop, not a state expected
  // against current data. Additive UI safety only — never a substitute
  // for the independent backend authorization each mutation route already
  // enforces.
  const receiptUsable = hasUsableDecisionReceipt(decisionReceipt);

  return (
    <section className="mt-8 space-y-4">
      <h2 className="text-lg font-semibold text-cp-text">Review</h2>

      <DecisionReceiptSection receipt={decisionReceipt} />

      <div className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass}`}>
            {statusLabel}
            {isApprovedWithConditions(review.status) && <span aria-hidden="true">•</span>}
          </span>
          {review.reviewedAt && <span className="text-xs text-cp-muted">Reviewed {formatAbsoluteDate(review.reviewedAt)}</span>}
        </div>
        {caption && <p className="mt-2 text-xs text-cp-muted">{caption}</p>}
        {review.comment && <p className="mt-3 whitespace-pre-wrap text-sm text-cp-text">{review.comment}</p>}
        {review.conditions && review.conditions.length > 0 && (
          <div className="mt-3">
            <h4 className="text-xs font-medium uppercase tracking-wide text-cp-faint">Conditions</h4>
            <ul className="mt-1 list-inside list-disc text-sm text-cp-text">
              {review.conditions.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {isDrain && (
        <div role="status" className="rounded-xl border border-cp-border bg-cp-raised px-5 py-4 text-sm">
          <p className="font-medium text-cp-text">Completion mode</p>
          <p className="mt-1 text-cp-muted">{COMPLETION_MODE_BANNER_MESSAGE}</p>
        </div>
      )}

      <WorkspacePanelReviewSection
        workspaceId={workspaceId}
        runId={runId}
        mode={viewer.mode}
        panel={panel}
        review={review}
        viewer={viewer}
        onMutated={refreshContext}
        decisionReceiptUsable={receiptUsable}
      />

      {!isDrain && !panelOpen && (
        <ReviewAssignmentCard workspaceId={workspaceId} runId={runId} assignment={assignment} assignmentRevision={assignmentRevision} canManageAssignment={viewer.canManageAssignment} onMutated={refreshContext} />
      )}

      {!isDrain && !panelOpen && viewer.canSubmitDecision && receiptUsable && (
        <ReviewDecisionForm workspaceId={workspaceId} runId={runId} review={review} canSubmitDecision={viewer.canSubmitDecision} onMutated={refreshContext} />
      )}

      {!isDrain && !panelOpen && viewer.canResubmit && <ReviewResubmitAction workspaceId={workspaceId} runId={runId} review={review} canResubmit={viewer.canResubmit} onMutated={refreshContext} />}
    </section>
  );
}
