"use client";

/**
 * Project/Research Assignment (D1/D3/D7/D9) — the ONLY Project-assignee
 * editor in v1: a multi-select member picker on the shared accessible
 * `ProjectDialogFrame`, opened from the Team Project list row's "Manage
 * assignees" sibling action.
 *
 *   - Offers EVERY active member from `useWorkspaceMembers()` — a Project
 *     assignee needs no particular capability (D2, Project rule), so the
 *     list is never capability-filtered here.
 *   - A currently-stored assignee who is no longer an active member is
 *     shown separately as "no longer eligible" and is NOT submitted — the
 *     server validates every target on every write, so retaining them
 *     would be refused. Saving therefore removes them, and the dialog
 *     says so before the user confirms.
 *   - Client-side cap mirrors the server's 20-unique bound (the server is
 *     authoritative; the mirror only prevents an obviously-refused
 *     request).
 *   - Outcomes split three ways, exactly like `TeamArchiveProjectDialog`:
 *     committed → close + `onSaved()`; stale/gone/denied → close +
 *     `onStaleOrGone(message)` (the shell refetches; this dialog captured
 *     the OLD token and must never submit again); transient → stay open
 *     with the honest message. Nothing is retried automatically.
 */

import { useMemo, useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { teamProjectMutationErrorCopy, shouldRefreshAfterTeamProjectMutationError } from "@/components/workspace/projects/teamProjectMutationErrorCopy";
import { useWorkspaceMembers } from "@/hooks/useWorkspaceMembers";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";
import type { UseTeamProjectLifecycleResult } from "@/hooks/useTeamProjectLifecycle";

export const MAX_PROJECT_ASSIGNEES_CLIENT_MIRROR = 20;

export function ProjectAssigneesDialog({
  workspaceId,
  project,
  triggerRef,
  onClose,
  lifecycle,
  onSaved,
  onStaleOrGone,
}: {
  workspaceId: string;
  project: TeamProjectSummary;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  lifecycle: Pick<UseTeamProjectLifecycleResult, "isProjectBusy" | "setAssignees">;
  onSaved: (project: TeamProjectSummary) => void;
  onStaleOrGone: (message: string) => void;
}) {
  const members = useWorkspaceMembers({ workspaceId });
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(project.assignees.filter((a) => a.state === "active").map((a) => a.uid)));
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const submitting = lifecycle.isProjectBusy(project.id);

  const memberUids = useMemo(() => new Set(members.members.map((m) => m.uid)), [members.members]);
  // Stored assignees with no current active membership — shown, never submitted.
  const ineligible = useMemo(() => (members.status === "ready" ? project.assignees.filter((a) => !memberUids.has(a.uid)) : []), [members.status, memberUids, project.assignees]);

  function toggle(uid: string) {
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else if (next.size < MAX_PROJECT_ASSIGNEES_CLIENT_MIRROR) next.add(uid);
      return next;
    });
  }

  async function handleSave(requestClose: () => void) {
    if (submitting || members.status !== "ready") return;
    setError(null);
    // Only currently-listed active members are ever submitted.
    const assigneeUids = Array.from(selected).filter((uid) => memberUids.has(uid));
    const result = await lifecycle.setAssignees(project, assigneeUids);
    if (result.status === "ok") {
      requestClose();
      onSaved(result.project);
      return;
    }
    const message = teamProjectMutationErrorCopy(result.errorCode);
    if (shouldRefreshAfterTeamProjectMutationError(result.errorCode)) {
      requestClose();
      onStaleOrGone(message);
      return;
    }
    if (result.errorCode === "assignee_not_eligible") {
      // The member list is what's stale here, not the Project token — reload it and let the user retry.
      members.reload();
    }
    setError(message);
  }

  const atCap = selected.size >= MAX_PROJECT_ASSIGNEES_CLIENT_MIRROR;

  return (
    <ProjectDialogFrame title={`Assignees for "${project.name}"`} triggerRef={triggerRef} onClose={onClose} initialFocusRef={saveButtonRef}>
      {({ requestClose }) => (
        <div className="mt-4">
          <p className="text-sm text-cp-muted">Assignment is a label for who is working on this Project. It does not change what anyone can see or do.</p>

          {members.status === "loading" && (
            <p role="status" className="mt-3 text-sm text-cp-muted">
              Loading members…
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
          {members.status === "ready" && members.members.length === 0 && <p className="mt-3 text-sm text-cp-muted">No members to assign.</p>}
          {members.status === "ready" && members.members.length > 0 && (
            <fieldset className="mt-3">
              <legend className="text-xs font-medium text-cp-faint">Members</legend>
              <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto">
                {members.members.map((m) => {
                  const checked = selected.has(m.uid);
                  return (
                    <li key={m.uid}>
                      <label className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-cp-text ${!checked && atCap ? "opacity-50" : "hover:bg-cp-raised"}`}>
                        <input type="checkbox" checked={checked} disabled={submitting || (!checked && atCap)} onChange={() => toggle(m.uid)} className="h-4 w-4" />
                        <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {atCap && <p className="mt-1 text-xs text-cp-faint">A Project can have at most {MAX_PROJECT_ASSIGNEES_CLIENT_MIRROR} assignees.</p>}
            </fieldset>
          )}
          {ineligible.length > 0 && (
            <p className="mt-3 text-xs text-cp-muted" data-testid="ineligible-assignees-note">
              No longer eligible and will be removed on save: <span className="font-medium text-cp-text">{ineligible.map((a) => a.displayName).join(", ")}</span>
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
              disabled={submitting || members.status !== "ready"}
              onClick={() => handleSave(requestClose)}
              className="rounded-lg bg-cp-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save assignees"}
            </button>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}
