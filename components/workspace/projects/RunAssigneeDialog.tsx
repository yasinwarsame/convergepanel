"use client";

/**
 * Project/Research Assignment (D2/D7/D8) — single-select primary-assignee
 * picker for one Team run, opened from the Project detail research row's
 * sibling "Assign" action (gated `research.organize` on the page).
 *
 *   - On open it loads two things: the member list (`useWorkspaceMembers`)
 *     and the run's CURRENT assignee + reviewer uids
 *     (`useTeamRunAssignee().loadRunAssignee`). The loaded assignee uid is
 *     the `expectedAssigneeUid` sent with the write — the run's own
 *     expected-state contract, never a Project OCC token.
 *   - Options are pre-filtered by the D2 run rule's CLIENT MIRROR
 *     (`RUN_ASSIGNEE_ELIGIBLE_ROLES`, labelled as a mirror in the UI). The
 *     server re-validates the target inside its transaction.
 *   - D8: choosing a member who is currently this run's assigned reviewer
 *     or a panel member shows a NON-BLOCKING warning. Nothing here reads
 *     or writes review documents, routes, eligibility, or state; the
 *     `reviewerUids` input is the read-only presentation the assignee
 *     route derives.
 *   - Outcomes: committed → close + `onSaved()`; conflict / gone / denied
 *     → close + `onStaleOrGone(message)`; `assignee_not_eligible` → stay
 *     open, reload members; transient → stay open. Never retried.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { useWorkspaceMembers } from "@/hooks/useWorkspaceMembers";
import type { TeamRunAssigneeErrorCode, TeamRunAssigneeView, UseTeamRunAssigneeResult } from "@/hooks/useTeamRunAssignee";
import { isRunAssigneeEligibleRoleMirror } from "@/lib/workspaces/assignmentTargetEligibilityClient";

export function teamRunAssigneeErrorCopy(code: TeamRunAssigneeErrorCode): string {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return "Please sign in again and try again.";
    case "insufficient_capability":
      return "You don't have permission to do that in this Workspace.";
    case "team_workspace_not_found":
    case "run_not_found":
      return "This research could not be found.";
    case "assignee_conflict":
      return "This research's assignment changed. Refresh and try again.";
    case "assignee_not_eligible":
      return "That member can no longer be assigned to research. Refresh the member list and try again.";
    case "rate_limited":
      return "Too many requests. Please try again shortly.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export function shouldRefreshAfterTeamRunAssigneeError(code: TeamRunAssigneeErrorCode): boolean {
  return code === "assignee_conflict" || code === "run_not_found" || code === "team_workspace_not_found" || code === "insufficient_capability";
}

export function RunAssigneeDialog({
  workspaceId,
  run,
  triggerRef,
  onClose,
  assignment,
  onSaved,
  onStaleOrGone,
}: {
  workspaceId: string;
  run: { id: string; question: string };
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  assignment: Pick<UseTeamRunAssigneeResult, "isRunBusy" | "loadRunAssignee" | "setRunAssignee">;
  onSaved: () => void;
  onStaleOrGone: (message: string) => void;
}) {
  const members = useWorkspaceMembers({ workspaceId });
  const [current, setCurrent] = useState<{ status: "loading" } | { status: "error"; errorCode: TeamRunAssigneeErrorCode } | { status: "ready"; assignee: TeamRunAssigneeView | null; reviewerUids: string[] }>({ status: "loading" });
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const submitting = assignment.isRunBusy(run.id);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setCurrent({ status: "loading" });
    (async () => {
      const result = await assignment.loadRunAssignee(run.id, controller.signal);
      if (cancelled) return;
      if (result.status === "ok") {
        setCurrent({ status: "ready", assignee: result.assignee, reviewerUids: result.reviewerUids });
        setSelectedUid(result.assignee?.uid ?? null);
      } else {
        setCurrent({ status: "error", errorCode: result.errorCode });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id]);

  const eligibleMembers = useMemo(() => members.members.filter((m) => isRunAssigneeEligibleRoleMirror(m.role)), [members.members]);
  const currentAssignee = current.status === "ready" ? current.assignee : null;
  const currentIsListed = currentAssignee !== null && eligibleMembers.some((m) => m.uid === currentAssignee.uid);
  const reviewerOverlap = current.status === "ready" && selectedUid !== null && current.reviewerUids.includes(selectedUid);
  const ready = members.status === "ready" && current.status === "ready";

  async function handleSave(requestClose: () => void) {
    if (submitting || current.status !== "ready") return;
    setError(null);
    const result = await assignment.setRunAssignee({ runId: run.id, assigneeUid: selectedUid, expectedAssigneeUid: current.assignee?.uid ?? null });
    if (result.status === "ok") {
      requestClose();
      onSaved();
      return;
    }
    const message = teamRunAssigneeErrorCopy(result.errorCode);
    if (shouldRefreshAfterTeamRunAssigneeError(result.errorCode)) {
      requestClose();
      onStaleOrGone(message);
      return;
    }
    if (result.errorCode === "assignee_not_eligible") members.reload();
    setError(message);
  }

  return (
    <ProjectDialogFrame title="Assign research" triggerRef={triggerRef} onClose={onClose} initialFocusRef={saveButtonRef}>
      {({ requestClose }) => (
        <div className="mt-4">
          <p className="break-words text-sm text-cp-muted">
            <span className="font-medium text-cp-text">{run.question}</span>
          </p>
          <p className="mt-2 text-xs text-cp-faint">Only members who can create research are listed (a mirror of the server rule; the server re-checks on save). Assignment does not change what anyone can see or do.</p>

          {(members.status === "loading" || current.status === "loading") && (
            <p role="status" className="mt-3 text-sm text-cp-muted">
              Loading…
            </p>
          )}
          {members.status === "error" && (
            <div role="alert" className="mt-3 text-sm text-red-700">
              Couldn&apos;t load this Workspace&apos;s members.{" "}
              <button type="button" onClick={members.reload} className="underline">
                Try again
              </button>
            </div>
          )}
          {current.status === "error" && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {teamRunAssigneeErrorCopy(current.errorCode)}
            </p>
          )}

          {ready && (
            <fieldset className="mt-3">
              <legend className="text-xs font-medium text-cp-faint">Assignee</legend>
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                <li>
                  <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-cp-text hover:bg-cp-raised">
                    <input type="radio" name="run-assignee" checked={selectedUid === null} disabled={submitting} onChange={() => setSelectedUid(null)} className="h-4 w-4" />
                    <span>Unassigned</span>
                  </label>
                </li>
                {currentAssignee !== null && !currentIsListed && (
                  <li>
                    <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-cp-faint" data-testid="stale-current-assignee">
                      <input type="radio" name="run-assignee" checked={selectedUid === currentAssignee.uid} disabled className="h-4 w-4" />
                      <span className="line-through">{currentAssignee.displayName}</span>
                      <span className="text-xs">(no longer eligible)</span>
                    </label>
                  </li>
                )}
                {eligibleMembers.map((m) => (
                  <li key={m.uid}>
                    <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-cp-text hover:bg-cp-raised">
                      <input type="radio" name="run-assignee" checked={selectedUid === m.uid} disabled={submitting} onChange={() => setSelectedUid(m.uid)} className="h-4 w-4" />
                      <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {eligibleMembers.length === 0 && <p className="mt-2 text-sm text-cp-muted">No eligible members to assign.</p>}
            </fieldset>
          )}

          {reviewerOverlap && (
            <p role="status" className="mt-3 rounded-lg border border-cp-orange-soft bg-cp-orange-soft px-3 py-2 text-xs text-cp-text" data-testid="reviewer-overlap-warning">
              This member is also reviewing this research. Assigning them is allowed, but you may want a different person to work on it.
            </p>
          )}

          {error && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={requestClose}
              disabled={submitting}
              className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              ref={saveButtonRef}
              type="button"
              disabled={submitting || !ready}
              onClick={() => handleSave(requestClose)}
              className="rounded-lg bg-cp-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}
