"use client";

/**
 * Approval Workflow, Phase 9C.2 — assignment presentation + manager
 * assignment/reassignment/clear form for `WorkspaceRunReviewSection`.
 *
 * PHASE 9B.7 OCC INVARIANT: every mutation this component issues sources
 * `expectedRevision` from the parent-supplied `assignmentRevision` prop
 * via `buildAssignmentPutRequest`/`buildAssignmentDeleteRequest` — NEVER
 * from whether `assignment` is null. This is enforced structurally: this
 * component never constructs a request body by hand, only through those
 * two pure functions (see `lib/client/workspaceReviewClient.ts`).
 *
 * Reviewer candidates are lazy-loaded ONLY when `canManageAssignment` is
 * true (Phase 9C.2 §22) — never fetched for a read-only viewer.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  getReviewerCandidates,
  putAssignment,
  deleteAssignment,
  buildAssignmentPutRequest,
  buildAssignmentDeleteRequest,
  CONFLICT_MESSAGE,
  GENERIC_CANDIDATES_ERROR_MESSAGE,
  GENERIC_MUTATION_ERROR_MESSAGE,
  NO_ELIGIBLE_REVIEWERS_MESSAGE,
  type ReviewContextAssignmentInfo,
  type ReviewerCandidate,
} from "@/lib/client/workspaceReviewClient";
import { getAssignmentPresentation, formatDueDate } from "@/lib/workspaces/reviewQueuePresentation";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";

function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ReviewAssignmentCard({
  workspaceId,
  runId,
  assignment,
  assignmentRevision,
  canManageAssignment,
  onMutated,
}: {
  workspaceId: string;
  runId: string;
  assignment: ReviewContextAssignmentInfo | null;
  assignmentRevision: number;
  canManageAssignment: boolean;
  onMutated: () => void;
}) {
  const { user, authReady } = useAuth();

  const [candidates, setCandidates] = useState<ReviewerCandidate[] | null>(null);
  const [candidatesStatus, setCandidatesStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [selectedUid, setSelectedUid] = useState<string>(assignment ? assignment.assignedReviewerUserId : "");
  const [dueAtLocal, setDueAtLocal] = useState<string>(assignment ? toDatetimeLocalValue(assignment.dueAt) : "");
  const [pending, setPending] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [selectionInvalidated, setSelectionInvalidated] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearPending, setClearPending] = useState(false);
  const clearTriggerRef = useRef<HTMLButtonElement>(null);

  const loadCandidates = async () => {
    setCandidatesStatus("loading");
    const result = await getReviewerCandidates({ workspaceId, runId, user, authReady });
    if (result.status === "ok") {
      setCandidates(result.candidates);
      setCandidatesStatus("ready");
    } else {
      setCandidatesStatus("error");
    }
  };

  useEffect(() => {
    if (canManageAssignment && candidatesStatus === "idle") {
      loadCandidates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageAssignment]);

  const presentation = assignment
    ? getAssignmentPresentation({ state: assignment.state, assignedReviewerDisplayName: assignment.assignedReviewerDisplayName })
    : getAssignmentPresentation({ state: "unassigned", assignedReviewerDisplayName: null });

  async function handleSave() {
    if (!selectedUid || pending) return;
    setPending(true);
    setConflictMessage(null);
    setSelectionInvalidated(false);
    const dueAtIso = dueAtLocal ? new Date(dueAtLocal).toISOString() : null;
    const body = buildAssignmentPutRequest({ assignmentRevision }, { assignedReviewerUserId: selectedUid, dueAt: dueAtIso });
    const result = await putAssignment({ workspaceId, runId, user, authReady, body });
    setPending(false);
    if (result.status === "ok") {
      onMutated();
      return;
    }
    if (result.status === "conflict") {
      setConflictMessage(CONFLICT_MESSAGE);
      onMutated();
      // Re-check eligibility against a FRESH candidate list — never permit
      // a silent retry with a now-possibly-ineligible reviewer (§34/§47).
      const refreshed = await getReviewerCandidates({ workspaceId, runId, user, authReady });
      if (refreshed.status === "ok") {
        setCandidates(refreshed.candidates);
        if (!refreshed.candidates.some((c) => c.uid === selectedUid)) {
          setSelectedUid("");
          setSelectionInvalidated(true);
        }
      }
      return;
    }
    setConflictMessage(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  async function handleClear() {
    if (clearPending) return;
    setClearPending(true);
    const body = buildAssignmentDeleteRequest({ assignmentRevision });
    const result = await deleteAssignment({ workspaceId, runId, user, authReady, body });
    setClearPending(false);
    setClearConfirmOpen(false);
    if (result.status === "ok") {
      onMutated();
      return;
    }
    if (result.status === "conflict") {
      setConflictMessage(CONFLICT_MESSAGE);
      onMutated();
      return;
    }
    setConflictMessage(GENERIC_MUTATION_ERROR_MESSAGE);
  }

  return (
    <div className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h3 className="text-sm font-semibold text-cp-text">Assignment</h3>

      <div className="mt-2 flex items-baseline gap-2">
        <span className={presentation.tone === "warning" ? "text-sm font-medium text-cp-orange" : "text-sm font-medium text-cp-text"}>{presentation.label}</span>
        {presentation.secondaryLabel && <span className="text-xs text-cp-muted">{presentation.secondaryLabel}</span>}
      </div>
      {assignment && formatDueDate(assignment.dueAt) && <p className="mt-1 text-xs text-cp-muted">{formatDueDate(assignment.dueAt)}</p>}

      {conflictMessage && (
        <p role="status" aria-live="polite" className="mt-3 rounded-lg border border-cp-orange bg-cp-orange-soft px-3 py-2 text-xs text-cp-text">
          {conflictMessage}
          {selectionInvalidated && " The previously selected reviewer is no longer eligible — choose someone else."}
        </p>
      )}

      {canManageAssignment && (
        <div className="mt-4 space-y-3 border-t border-cp-border-soft pt-4">
          {candidatesStatus === "loading" && (
            <p role="status" className="text-xs text-cp-muted">
              Loading eligible reviewers…
            </p>
          )}
          {candidatesStatus === "error" && (
            <div className="text-xs">
              <p className="text-cp-muted">{GENERIC_CANDIDATES_ERROR_MESSAGE}</p>
              <button type="button" onClick={loadCandidates} className="mt-1 font-medium text-cp-accent underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
                Retry
              </button>
            </div>
          )}
          {candidatesStatus === "ready" && candidates && candidates.length === 0 && <p className="text-xs text-cp-muted">{NO_ELIGIBLE_REVIEWERS_MESSAGE}</p>}

          {candidatesStatus === "ready" && candidates && candidates.length > 0 && (
            <div className="space-y-2">
              <label htmlFor="review-assignment-reviewer" className="block text-xs font-medium text-cp-text">
                Reviewer
              </label>
              <select
                id="review-assignment-reviewer"
                value={selectedUid}
                onChange={(e) => setSelectedUid(e.target.value)}
                className="w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
              >
                <option value="">Select a reviewer…</option>
                {candidates.map((c) => (
                  <option key={c.uid} value={c.uid}>
                    {c.displayName}
                  </option>
                ))}
              </select>

              <label htmlFor="review-assignment-due-date" className="block text-xs font-medium text-cp-text">
                Due date
              </label>
              <input
                id="review-assignment-due-date"
                type="datetime-local"
                value={dueAtLocal}
                onChange={(e) => setDueAtLocal(e.target.value)}
                className="w-full rounded-lg border border-cp-border bg-cp-surface px-3 py-2 text-sm text-cp-text focus:border-cp-accent focus:outline-none focus:ring-1 focus:ring-cp-accent"
              />

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!selectedUid || pending}
                  className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                >
                  {pending ? "Saving…" : assignment ? "Save assignment" : "Assign reviewer"}
                </button>
                {assignment && (
                  <button
                    ref={clearTriggerRef}
                    type="button"
                    onClick={() => setClearConfirmOpen(true)}
                    disabled={clearPending}
                    className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50"
                  >
                    Clear assignment
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {clearConfirmOpen && (
        <ProjectDialogFrame title="Clear assignment?" triggerRef={clearTriggerRef} onClose={() => setClearConfirmOpen(false)}>
          {() => (
            <div className="mt-4">
              <p className="text-sm text-cp-muted">This removes the current reviewer assignment. The review itself is unaffected.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setClearConfirmOpen(false)} className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
                  Cancel
                </button>
                <button type="button" onClick={handleClear} disabled={clearPending} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent disabled:opacity-50">
                  {clearPending ? "Clearing…" : "Clear assignment"}
                </button>
              </div>
            </div>
          )}
        </ProjectDialogFrame>
      )}
    </div>
  );
}
