/**
 * Approval Workflow, Phase 9C.1-R1C — `GET /workspace/reviews/[runId]`,
 * the new PERMANENT, Workspace-native, read-only run-detail route. This
 * is the corrected queue-row navigation target (see
 * `components/workspace/ReviewQueueRow.tsx`) — the previous target,
 * `/reviews/{runId}`, is the Personal reviewer surface and rejects every
 * Workspace viewer role; `/team/reviews/{runId}` is the separate legacy
 * Team namespace. Neither is reused here, for auth OR presentation.
 *
 * `WORKSPACE_REVIEW_DETAIL_ROUTE = /workspace/reviews/[runId]` is frozen
 * as the canonical Phase 9 Approval Workflow run-detail surface — 9C.2+
 * will add the real single-review/panel/override controls onto this SAME
 * route rather than migrating users to a new URL later.
 *
 * Server-gated exactly like `/workspace/reviews` itself: identity ->
 * Approval Workflow admission (pure) -> `getWorkspaceRunDetail()`, which
 * independently resolves the run's OWN canonical `workspaceId` (never a
 * route/query param) and revalidates Team Workspace access +
 * `research.read` from scratch. Every denial path returns the identical
 * `notFound()` — no message ever reveals whether a run exists.
 */

import { notFound } from "next/navigation";
import { resolveServerComponentIdentity } from "@/lib/auth/resolveServerComponentIdentity";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { getWorkspaceRunDetail } from "@/lib/workspaces/workspaceRunDetail";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { getReviewStatusLabel, getReviewStatusBadgeClass, isApprovedWithConditions, formatAbsoluteDate, UNFILED_PROJECT_LABEL } from "@/lib/workspaces/reviewQueuePresentation";

export const dynamic = "force-dynamic";

export default async function WorkspaceRunDetailPage({ params }: { params: { runId: string } }) {
  const identity = await resolveServerComponentIdentity();
  if (!identity) {
    notFound();
  }

  const admission = resolveApprovalWorkflowAdmission({ uid: identity.uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) {
    notFound();
  }

  const result = await getWorkspaceRunDetail({ runId: params.runId, uid: identity.uid, approvalAdmitted: true });
  if (result.status !== "ok") {
    notFound();
  }
  const { detail } = result;

  const statusLabel = detail.reviewStatus ? getReviewStatusLabel(detail.reviewStatus) : null;
  const statusClass = detail.reviewStatus ? getReviewStatusBadgeClass(detail.reviewStatus) : "";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <p className="text-sm text-cp-muted">{detail.workspaceName}</p>
      <h1 className="mt-1 text-2xl font-semibold text-cp-text">{detail.runLabel || "Untitled research"}</h1>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        {statusLabel && (
          <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass}`}>
            {statusLabel}
            {detail.reviewStatus && isApprovedWithConditions(detail.reviewStatus) && <span aria-hidden="true">•</span>}
          </span>
        )}
        <span className="text-cp-muted">{detail.projectName ?? UNFILED_PROJECT_LABEL}</span>
      </div>

      <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-3 rounded-xl border border-cp-border bg-cp-surface p-6 shadow-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-cp-faint">Created</dt>
          <dd className="mt-1 text-sm text-cp-text">{formatAbsoluteDate(detail.createdAt) ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium uppercase tracking-wide text-cp-faint">Last reviewed</dt>
          <dd className="mt-1 text-sm text-cp-text">{formatAbsoluteDate(detail.reviewedAt) ?? "—"}</dd>
        </div>
      </dl>
    </main>
  );
}
