"use client";

/**
 * Team Project lifecycle UI, Phase PROJECT-UI-AR-I1 — one Team Project row
 * with status-driven lifecycle controls, shared by the Active and Archived
 * sections of `TeamProjectsShell`. Team-specific sibling of
 * `components/projects/ProjectLifecycleRow.tsx` (not a reuse — that row is
 * typed to the Personal hook/DTO and links to Personal routes).
 *
 *   - The name is the ONLY link (to the existing Team Project detail
 *     route); lifecycle actions are sibling buttons, never nested in it.
 *   - Archive renders ONLY for `status === "active"`; Restore ONLY for
 *     `status === "archived"`; never both. Both are hidden when the caller
 *     lacks `projects.manage` (`canManageProjects`, server-derived on the
 *     page) — UX only, the API transaction re-authorizes every call — and
 *     when `updateTime === null` (no valid OCC token until a refetch; the
 *     hook would refuse the request anyway).
 *   - Archive confirms (`TeamArchiveProjectDialog`); Restore is immediate
 *     with a "Restoring…" pending label. Controls are disabled while this
 *     Project is busy; the hook's per-Project lock is the real duplicate
 *     guard.
 *   - Phase PROJECT-UI-AR-P3A-I1 — outcomes that trigger a canonical refetch
 *     (committed archive/restore, or a stale / gone / denied denial) are
 *     REPORTED UPWARD via `onLifecycleOutcome()` instead of being shown
 *     here: the shell's refetch empties both lists and unmounts this row in
 *     the same commit, so a row-local message would never paint and a
 *     focused trigger would be removed from the DOM. The shell owns the
 *     status region, the refetch, and post-refresh focus. Only
 *     NON-refreshing failures (network / internal) stay row-local, because
 *     this row remains mounted and the token is still valid for a manual
 *     retry. `onLifecycleAttemptStart()` lets the shell clear a previous
 *     notice the moment a new attempt begins. Nothing is ever retried.
 */

import { useRef, useState } from "react";
import Link from "next/link";
import { TeamArchiveProjectDialog } from "@/components/workspace/projects/TeamArchiveProjectDialog";
import { teamProjectMutationErrorCopy, shouldRefreshAfterTeamProjectMutationError } from "@/components/workspace/projects/teamProjectMutationErrorCopy";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";
import type { UseTeamProjectLifecycleResult } from "@/hooks/useTeamProjectLifecycle";

/** Reported to the shell for every outcome that requires a canonical refetch. Never carries ids — only the name the user already sees and the already-sanitized message. */
export type TeamProjectLifecycleOutcome =
  | { kind: "committed"; operation: "archive" | "restore"; projectName: string }
  | { kind: "stale"; operation: "archive" | "restore"; message: string };

const buttonClass =
  "rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text transition-colors hover:bg-cp-surface disabled:cursor-not-allowed disabled:opacity-50";

export function TeamProjectLifecycleRow({
  workspaceId,
  project,
  canManageProjects,
  lifecycle,
  onLifecycleAttemptStart,
  onLifecycleOutcome,
}: {
  workspaceId: string;
  project: TeamProjectSummary;
  canManageProjects: boolean;
  lifecycle: Pick<UseTeamProjectLifecycleResult, "isProjectBusy" | "getBusyOperation" | "archiveProject" | "restoreProject">;
  /** Called synchronously when the user starts a new attempt (opens the Archive dialog or clicks Restore) so the shell can clear a stale notice. */
  onLifecycleAttemptStart: () => void;
  /** Called exactly once per refetch-triggering outcome; the shell refetches both sections, shows the message, and manages focus. */
  onLifecycleOutcome: (outcome: TeamProjectLifecycleOutcome) => void;
}) {
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const busy = lifecycle.isProjectBusy(project.id);
  const restoreInFlight = lifecycle.getBusyOperation(project.id) === "restore";
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);

  const canAct = canManageProjects && project.updateTime !== null;
  const showArchive = canAct && project.status === "active";
  const showRestore = canAct && project.status === "archived";

  async function handleRestore() {
    if (busy) return;
    setRowError(null);
    onLifecycleAttemptStart();
    const result = await lifecycle.restoreProject(project);
    if (result.status === "ok") {
      onLifecycleOutcome({ kind: "committed", operation: "restore", projectName: project.name });
      return;
    }
    const message = teamProjectMutationErrorCopy(result.errorCode);
    if (shouldRefreshAfterTeamProjectMutationError(result.errorCode)) {
      onLifecycleOutcome({ kind: "stale", operation: "restore", message });
      return;
    }
    setRowError(message);
  }

  return (
    <li className="rounded-xl border-2 border-cp-border bg-cp-raised px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href={`/workspace/team/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(project.id)}`}
          className="min-w-0 flex-1 break-words text-sm font-medium text-cp-text hover:underline"
        >
          {project.name}
        </Link>
        {(showArchive || showRestore) && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {showArchive && (
              <button
                ref={archiveTriggerRef}
                type="button"
                disabled={busy}
                onClick={() => {
                  setRowError(null);
                  onLifecycleAttemptStart();
                  setArchiveDialogOpen(true);
                }}
                className={buttonClass}
              >
                Archive
              </button>
            )}
            {showRestore && (
              <button type="button" disabled={busy} onClick={handleRestore} className={buttonClass}>
                {restoreInFlight ? "Restoring…" : "Restore"}
              </button>
            )}
          </div>
        )}
      </div>
      {rowError && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {rowError}
        </p>
      )}
      {archiveDialogOpen && showArchive && (
        <TeamArchiveProjectDialog
          project={project}
          triggerRef={archiveTriggerRef}
          onClose={() => setArchiveDialogOpen(false)}
          lifecycle={lifecycle}
          onArchived={() => {
            setArchiveDialogOpen(false);
            onLifecycleOutcome({ kind: "committed", operation: "archive", projectName: project.name });
          }}
          onStaleOrGone={(message) => {
            setArchiveDialogOpen(false);
            onLifecycleOutcome({ kind: "stale", operation: "archive", message });
          }}
        />
      )}
    </li>
  );
}
