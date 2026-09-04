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
 *   - After a committed transition, `refreshSections()` refetches BOTH
 *     lists from the server (never an optimistic move). After a stale /
 *     gone / denied outcome the message is shown inline (role="alert"),
 *     `refreshSections()` runs, and nothing is retried.
 */

import { useRef, useState } from "react";
import Link from "next/link";
import { TeamArchiveProjectDialog } from "@/components/workspace/projects/TeamArchiveProjectDialog";
import { teamProjectMutationErrorCopy, shouldRefreshAfterTeamProjectMutationError } from "@/components/workspace/projects/teamProjectMutationErrorCopy";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";
import type { UseTeamProjectLifecycleResult } from "@/hooks/useTeamProjectLifecycle";

const buttonClass =
  "rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text transition-colors hover:bg-cp-surface disabled:cursor-not-allowed disabled:opacity-50";

export function TeamProjectLifecycleRow({
  workspaceId,
  project,
  canManageProjects,
  lifecycle,
  refreshSections,
}: {
  workspaceId: string;
  project: TeamProjectSummary;
  canManageProjects: boolean;
  lifecycle: Pick<UseTeamProjectLifecycleResult, "isProjectBusy" | "getBusyOperation" | "archiveProject" | "restoreProject">;
  refreshSections: () => void;
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
    const result = await lifecycle.restoreProject(project);
    if (result.status === "ok") {
      refreshSections();
      return;
    }
    setRowError(teamProjectMutationErrorCopy(result.errorCode));
    if (shouldRefreshAfterTeamProjectMutationError(result.errorCode)) {
      refreshSections();
    }
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
            refreshSections();
          }}
          onStaleOrGone={(message) => {
            setArchiveDialogOpen(false);
            setRowError(message);
            refreshSections();
          }}
        />
      )}
    </li>
  );
}
