"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — renders the outcome
 * of a decision submission. Never displays a raw API body, Firestore
 * message, parser reason, or stack trace — only a fixed, safe message per
 * outcome kind (docs/governance-decision-receipts-design.md §26).
 */

import type { AdaptiveReviewSubmissionResult as SubmissionResult } from "@/lib/client/adaptiveReviewSubmission";

export default function AdaptiveReviewSubmissionResult({
  result,
  onReload,
}: {
  result: SubmissionResult;
  onReload: () => void;
}) {
  switch (result.kind) {
    case "success":
      return (
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-900/20 p-4" role="status" aria-live="polite">
          <p className="text-sm font-semibold text-emerald-400">Decision recorded.</p>
          {result.projectionSyncStatus === "failed" ? (
            <p className="mt-2 text-xs text-cp-muted">The review was saved, but the team queue may take time to update.</p>
          ) : null}
        </div>
      );

    case "stale":
      return (
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/20 p-4" role="alert" aria-live="assertive">
          <p className="text-sm font-semibold text-amber-400">
            This review changed after you opened it. Reload the latest version before deciding.
          </p>
          <button
            type="button"
            onClick={onReload}
            className="mt-3 rounded-lg border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Reload Review
          </button>
        </div>
      );

    case "terminal":
      return (
        <div className="rounded-lg border border-cp-border bg-cp-raised p-4" role="status" aria-live="polite">
          <p className="text-sm font-semibold text-cp-text">This review has already reached a final decision.</p>
          <button
            type="button"
            onClick={onReload}
            className="mt-3 rounded-lg border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Reload Review
          </button>
        </div>
      );

    case "unauthenticated":
    case "forbidden":
      return (
        <div className="rounded-lg border border-red-700/40 bg-red-900/20 p-4" role="alert" aria-live="assertive">
          <p className="text-sm font-semibold text-red-400">You don&apos;t have access to submit this review.</p>
        </div>
      );

    case "not_found":
      return (
        <div className="rounded-lg border border-red-700/40 bg-red-900/20 p-4" role="alert" aria-live="assertive">
          <p className="text-sm font-semibold text-red-400">This review could not be found.</p>
        </div>
      );

    case "validation_error":
      return (
        <div className="rounded-lg border border-red-700/40 bg-red-900/20 p-4" role="alert" aria-live="assertive">
          <p className="text-sm font-semibold text-red-400">This decision could not be submitted. Please check the form and try again.</p>
        </div>
      );

    case "unavailable":
    case "server_error":
      return (
        <div className="rounded-lg border border-red-700/40 bg-red-900/20 p-4" role="alert" aria-live="assertive">
          <p className="text-sm font-semibold text-red-400">This review is temporarily unavailable. Please try again.</p>
        </div>
      );

    case "network_error":
      return (
        <div className="rounded-lg border border-amber-700/40 bg-amber-900/20 p-4" role="alert" aria-live="assertive">
          <p className="text-sm font-semibold text-amber-400">
            We couldn&apos;t confirm whether your decision was saved. Reload the review before trying again.
          </p>
          <button
            type="button"
            onClick={onReload}
            className="mt-3 rounded-lg border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Reload Review
          </button>
        </div>
      );

    default:
      return null;
  }
}
