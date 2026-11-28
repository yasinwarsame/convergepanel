"use client";

/**
 * ZCA L-3 — the client half of `/workspace/reviews/[runId]` (D-4 page #6, the highest-confidentiality
 * page). The server render is a neutral shell; everything identity-specific below is loaded from
 * `GET /api/user/workspace-review-runs/[runId]` with the Firebase bearer (useAuthorizedResource) and
 * rendered only for that `ready` answer. The markup is unchanged from the former server render.
 */
import Link from "next/link";
import { useAuthorizedResource } from "@/hooks/useAuthorizedResource";
import { AuthorizedPageGate } from "@/components/workspace/AuthorizedPageGate";
import { getReviewStatusLabel, getReviewStatusBadgeClass, isApprovedWithConditions, formatAbsoluteDate, UNFILED_PROJECT_LABEL } from "@/lib/workspaces/reviewQueuePresentation";
import WorkspaceRunReviewSection from "@/components/workspace/WorkspaceRunReviewSection";
import { parseWorkspaceRunDetailResponse, type WorkspaceRunDetailInfo } from "@/lib/workspaces/workspaceRunDetailTypes";

export default function WorkspaceRunDetailClient({ runId }: { runId: string }) {
  const resource = useAuthorizedResource<WorkspaceRunDetailInfo>(
    runId ? `/api/user/workspace-review-runs/${encodeURIComponent(runId)}` : null,
    parseWorkspaceRunDetailResponse,
  );
  return <AuthorizedPageGate resource={resource}>{(detail) => <RunDetail detail={detail} runId={runId} />}</AuthorizedPageGate>;
}

function RunDetail({ detail, runId }: { detail: WorkspaceRunDetailInfo; runId: string }) {
  const statusLabel = detail.reviewStatus ? getReviewStatusLabel(detail.reviewStatus) : null;
  const statusClass = detail.reviewStatus ? getReviewStatusBadgeClass(detail.reviewStatus) : "";

  return (
        <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
          {/*
            Roadmap 4.4a — the explicit return path to the SAME Workspace's queue.
            `detail.workspaceId` is the run's own canonical Workspace (resolved by
            getWorkspaceRunDetail(), never a route/query param), and the queue
            page already selects a Workspace via `?workspace=`. Presentation only:
            the queue re-checks admission and capabilities on its own.
          */}
          <Link
            href={`/workspace/reviews?workspace=${encodeURIComponent(detail.workspaceId)}`}
            className="text-sm font-medium text-cp-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            ← Back to reviews
          </Link>
          <p className="mt-4 text-sm text-cp-muted">{detail.workspaceName}</p>
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

          <WorkspaceRunReviewSection workspaceId={detail.workspaceId} runId={runId} />
        </main>
  );
}
