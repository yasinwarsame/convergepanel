"use client";

/**
 * Approval Workflow, Phase 9C.1 — one Workspace review-queue row/card.
 * Pure/presentational: receives an already-fetched, already-normalized
 * row plus the page's `canManageReviews` UX hint; performs no fetch, no
 * mutation, no navigation side effect beyond a single `<Link>`.
 *
 * READ-ONLY BY DESIGN (Phase 9C.1 §69, mandatory): this component must
 * never render an Assign/Reassign/Review/Approve/Reject/Request changes/
 * Resubmit/Start panel/Configure panel/Vote/Finalize/Cancel panel/
 * Override control, regardless of `canManageReviews`. That flag is used
 * here ONLY to adjust informational copy on a stale assignment — never to
 * gate a button, since no button exists.
 *
 * Desktop and mobile presentations render from the SAME normalized data
 * (no independent status/assignment mapper) — only the layout differs,
 * via Tailwind responsive visibility, matching this row component's own
 * single source of truth: `lib/workspaces/reviewQueuePresentation.ts`.
 */

import Link from "next/link";
import type { WorkspaceReviewQueueRow } from "@/lib/client/workspaceReviewQueueClient";
import { getReviewStatusLabel, getReviewStatusBadgeClass, isApprovedWithConditions, getAssignmentPresentation, getProjectLabel, formatDueDate, formatAbsoluteDate } from "@/lib/workspaces/reviewQueuePresentation";

export default function ReviewQueueRow({ row, projectNameById, canManageReviews }: { row: WorkspaceReviewQueueRow; projectNameById: ReadonlyMap<string, string>; canManageReviews: boolean }) {
  const statusLabel = getReviewStatusLabel(row.reviewStatus);
  const statusClass = getReviewStatusBadgeClass(row.reviewStatus);
  const assignmentPresentation = getAssignmentPresentation(row.assignment);
  const projectLabel = getProjectLabel(row.projectId, projectNameById);
  const dueLabel = formatDueDate(row.assignment.dueAt);
  const updatedLabel = formatAbsoluteDate(row.reviewedAt) ?? formatAbsoluteDate(row.createdAt);
  // Phase 9C.1-R1C — corrected destination. `/reviews/{runId}` is the
  // Personal review surface and rejects every Workspace viewer role
  // (confirmed by independent review); `/team/reviews/{runId}` is the
  // separate legacy Team namespace. `/workspace/reviews/{runId}` is the
  // new, permanent, Workspace-native canonical detail route — it sources
  // its own Workspace authority from `runs/{runId}.workspaceId`, so no
  // `?workspace=` param is needed here even for a multi-Workspace uid.
  const detailHref = `/workspace/reviews/${encodeURIComponent(row.runId)}`;

  const assignmentToneClass = assignmentPresentation.tone === "warning" ? "text-cp-orange" : assignmentPresentation.tone === "positive" ? "text-cp-text" : "text-cp-muted";

  return (
    <li className="border-b border-cp-border-soft last:border-b-0">
      {/* Desktop row */}
      <div className="hidden items-center gap-4 px-4 py-3 md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_minmax(0,1fr)_auto_auto_auto]">
        <span className="truncate text-sm font-medium text-cp-text" title={row.runLabel}>
          {row.runLabel || "Untitled research"}
        </span>
        <span className="truncate text-sm text-cp-muted">{projectLabel}</span>
        <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass}`}>
          {statusLabel}
          {isApprovedWithConditions(row.reviewStatus) && <span aria-hidden="true">•</span>}
        </span>
        <span className={`truncate text-sm ${assignmentToneClass}`}>
          {assignmentPresentation.label}
          {assignmentPresentation.secondaryLabel && <span className="ml-1.5 text-xs text-cp-faint">({assignmentPresentation.secondaryLabel})</span>}
        </span>
        <span className="text-sm">
          {row.isOverdue ? <span className="font-medium text-red-600">Overdue</span> : null}
          {dueLabel && <span className={row.isOverdue ? "ml-1.5 text-cp-faint" : "text-cp-muted"}>{dueLabel}</span>}
          {!dueLabel && !row.isOverdue && <span className="text-cp-faint">No due date</span>}
        </span>
        <span className="text-sm text-cp-faint">{updatedLabel ?? "—"}</span>
        <Link href={detailHref} className="rounded-md border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
          View
        </Link>
      </div>

      {/* Mobile card */}
      <div className="flex flex-col gap-2 px-4 py-3 md:hidden">
        <p className="text-sm font-medium text-cp-text" title={row.runLabel}>
          {row.runLabel || "Untitled research"}
        </p>
        <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${statusClass}`}>
          {statusLabel}
          {isApprovedWithConditions(row.reviewStatus) && <span aria-hidden="true">•</span>}
        </span>
        <p className="text-xs text-cp-muted">{projectLabel}</p>
        <p className={`text-xs ${assignmentToneClass}`}>
          {assignmentPresentation.label}
          {assignmentPresentation.secondaryLabel && <span className="ml-1 text-cp-faint">({assignmentPresentation.secondaryLabel})</span>}
        </p>
        <p className="text-xs">
          {row.isOverdue ? <span className="font-medium text-red-600">Overdue</span> : null}
          {dueLabel && <span className={row.isOverdue ? "ml-1.5 text-cp-faint" : "text-cp-muted"}>{dueLabel}</span>}
          {!dueLabel && !row.isOverdue && <span className="text-cp-faint">No due date</span>}
        </p>
        {updatedLabel && <p className="text-xs text-cp-faint">Updated {updatedLabel}</p>}
        <Link href={detailHref} className="mt-1 inline-flex w-fit rounded-md border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text transition-colors hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
          View
        </Link>
      </div>
      {/* `canManageReviews` is read but deliberately never gates a control in this read-only phase — see module doc comment. */}
      {canManageReviews && assignmentPresentation.tone === "warning" ? <span className="sr-only">Needs reassignment by a Workspace manager.</span> : null}
    </li>
  );
}
