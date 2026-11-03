"use client";

/**
 * Order B, Stage B3 — one Report Review row in the Workspace Audit Log. Renders only the server's allow-list DTO (question
 * snapshot, cycle, purpose, status, display names). Every row about an approval carries the fixed disclaimer, so the log
 * never reads as a record of fact-checking.
 */
import type { WorkspaceAuditEventItem, WorkspaceAuditReportReviewEventItem } from "@/lib/client/workspaceTeamClient";
import { REPORT_REVIEW_DISCLAIMER, reportReviewPurposeLabel, reportReviewStatusLabel } from "@/lib/governance/reportReviewCopy";

function formatOccurredAt(iso: string): string {
  // Same presentation as every other Audit Log row (WorkspaceAuditLogShell).
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "Unknown time";
  return parsed.toLocaleString();
}

const UNTITLED = "Untitled research";

const REPORT_REVIEW_EVENT_TYPES: ReadonlySet<string> = new Set([
  "workspace_report_review_submitted",
  "workspace_report_review_resubmitted",
  "workspace_report_review_reviewer_changed",
  "workspace_report_review_decided",
]);

/** Narrows an Audit Log item to a Report Review row (the client parser has already validated its shape). */
export function isReportReviewAuditEvent(e: WorkspaceAuditEventItem): e is WorkspaceAuditReportReviewEventItem {
  return REPORT_REVIEW_EVENT_TYPES.has(e.eventType);
}

export default function ReportReviewAuditEntry({ event }: { event: WorkspaceAuditReportReviewEventItem }) {
  const question = event.research.question ?? UNTITLED;
  let title: string;
  let body: React.ReactNode;
  const details: React.ReactNode[] = [];

  switch (event.eventType) {
    case "workspace_report_review_submitted":
      title = "Report submitted for approval";
      body = (
        <>
          <span className="font-medium text-cp-text">{question}</span> was submitted for approval (review cycle {event.cycle}).
        </>
      );
      details.push(<span key="p">Purpose: <span className="font-medium text-cp-muted">{reportReviewPurposeLabel(event.purpose)}</span></span>);
      break;
    case "workspace_report_review_resubmitted":
      title = event.closedReason === "content_changed" ? "Report resubmitted after its content changed" : "Report resubmitted for approval";
      body = (
        <>
          <span className="font-medium text-cp-text">{question}</span>:{" "}
          {event.closedReason === "content_changed"
            ? `the research changed after review cycle ${event.fromCycle} was submitted, so that cycle was closed without a decision and cycle ${event.cycle} started.`
            : `review cycle ${event.fromCycle} was archived and cycle ${event.cycle} started.`}
        </>
      );
      details.push(<span key="p">Purpose: <span className="font-medium text-cp-muted">{reportReviewPurposeLabel(event.purpose)}</span></span>);
      if (event.clearedReviewer) details.push(<span key="c">Reviewer cleared: <span className="font-medium text-cp-muted">{event.clearedReviewer.displayName}</span></span>);
      break;
    case "workspace_report_review_reviewer_changed":
      // The kind of change is decided by the server from uids (never from display names, which can coincide).
      title = { assigned: "Report reviewer assigned", reassigned: "Report reviewer reassigned", removed: "Report reviewer removed", updated: "Report review assignment updated" }[event.change];
      body = (
        <>
          <span className="font-medium text-cp-text">{question}</span>
          {event.change === "updated" ? (
            <>
              {" "}(cycle {event.cycle}): the assignment details (such as the due date) changed; the reviewer is unchanged.
            </>
          ) : event.reviewer ? (
            <>
              {" "}(cycle {event.cycle}): reviewer is now <span className="font-medium text-cp-text">{event.reviewer.displayName}</span>.
            </>
          ) : (
            <> (cycle {event.cycle}): no reviewer is assigned.</>
          )}
        </>
      );
      if (event.previousReviewer && event.change !== "updated") details.push(<span key="pr">Previously: <span className="font-medium text-cp-muted">{event.previousReviewer.displayName}</span></span>);
      break;
    case "workspace_report_review_decided":
      title = `Report review decision: ${reportReviewStatusLabel(event.status)}`;
      body = (
        <>
          <span className="font-medium text-cp-text">{question}</span>: {reportReviewStatusLabel(event.status)}. Review cycle {event.cycle} is closed.
        </>
      );
      details.push(<span key="p">Purpose: <span className="font-medium text-cp-muted">{reportReviewPurposeLabel(event.purpose)}</span></span>);
      break;
  }

  return (
    <div data-testid="report-review-audit-entry">
      <p className="text-sm font-medium text-cp-text">{title}</p>
      <p className="mt-1 break-words text-sm text-cp-muted">{body}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-cp-faint">
        {details}
        <span>
          By: <span className="font-medium text-cp-muted">{event.actor.displayName}</span>
        </span>
        <span>{formatOccurredAt(event.occurredAt)}</span>
      </div>
      {/* Review m-2: wherever approval is requested (submission, resubmission) or recorded (decision). */}
      {event.eventType !== "workspace_report_review_reviewer_changed" && (
        <p className="mt-2 text-xs text-cp-muted" data-testid="report-review-disclaimer">
          {REPORT_REVIEW_DISCLAIMER}
        </p>
      )}
    </div>
  );
}
