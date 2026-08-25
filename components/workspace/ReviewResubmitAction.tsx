"use client";

/**
 * Approval Workflow, Phase 9C.2 — "Resubmit for review" action for a
 * `changes_requested` item. Rendered ONLY when `viewer.canResubmit ===
 * true` (parent-checked, Phase 9C.2 §46) — never inferred from creator or
 * manager role.
 *
 * OCC: sources `expectedUpdatedAt` from `review.governanceUpdatedAt` via
 * `buildResubmitRequest` — the same governance OCC domain as decisions,
 * never `assignmentRevision`.
 */

import { useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { resubmitReview, buildResubmitRequest, CONFLICT_MESSAGE, GENERIC_MUTATION_ERROR_MESSAGE, type ReviewContextReviewInfo } from "@/lib/client/workspaceReviewClient";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";

export default function ReviewResubmitAction({
  workspaceId,
  runId,
  review,
  canResubmit,
  onMutated,
}: {
  workspaceId: string;
  runId: string;
  review: ReviewContextReviewInfo;
  canResubmit: boolean;
  onMutated: () => void;
}) {
  const { user, authReady } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (!canResubmit) return null;

  async function handleResubmit() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    const body = buildResubmitRequest({ review });
    const result = await resubmitReview({ workspaceId, runId, user, authReady, body });
    setPending(false);
    setConfirmOpen(false);
    if (result.status === "ok") {
      onMutated();
      return;
    }
    if (result.status === "conflict") {
      setNotice(CONFLICT_MESSAGE);
      onMutated();
      return;
    }
    setNotice(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  return (
    <div className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-cp-text">Resubmission</h3>
      <p className="mt-1 text-sm text-cp-muted">Resubmitting reopens this item for review. Existing assignment information is preserved.</p>

      {notice && (
        <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-cp-orange bg-cp-orange-soft px-3 py-2 text-xs text-cp-text">
          {notice}
        </p>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={pending}
        className="mt-3 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
      >
        Resubmit for review
      </button>

      {confirmOpen && (
        <ProjectDialogFrame title="Resubmit for review?" triggerRef={triggerRef} onClose={() => setConfirmOpen(false)}>
          {() => (
            <div className="mt-4">
              <p className="text-sm text-cp-muted">This reopens the review. Existing assignment information is preserved.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmOpen(false)} className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
                  Cancel
                </button>
                <button type="button" onClick={handleResubmit} disabled={pending} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50">
                  {pending ? "Resubmitting…" : "Resubmit"}
                </button>
              </div>
            </div>
          )}
        </ProjectDialogFrame>
      )}
    </div>
  );
}
