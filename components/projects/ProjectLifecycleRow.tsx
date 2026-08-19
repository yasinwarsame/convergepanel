"use client";

/**
 * Phase 7D — one Project row with its lifecycle controls: Rename on every
 * row; Archive only on Active rows; Restore only on Archived rows (spec
 * items 10/12/14). Shared by `ActiveProjectsSection`/`ArchivedProjectsSection`
 * so the two surfaces can never drift into two different row
 * implementations.
 */

import { useRef, useState } from "react";
import Link from "next/link";
import { RenameProjectDialog } from "@/components/projects/RenameProjectDialog";
import { ArchiveProjectDialog } from "@/components/projects/ArchiveProjectDialog";
import { projectMutationErrorCopy, isStaleProjectMutationError } from "@/components/projects/projectMutationErrorCopy";
import type { ProjectSummary } from "@/hooks/useProjects";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";

const buttonClass =
  "rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text transition-colors hover:bg-cp-surface disabled:cursor-not-allowed disabled:opacity-50";

export function ProjectLifecycleRow({
  project,
  variant,
  lifecycle,
  onRenamed,
  refreshSections,
}: {
  project: ProjectSummary;
  variant: "active" | "archived";
  lifecycle: UseProjectLifecycleResult;
  onRenamed: (updated: ProjectSummary) => void;
  refreshSections: () => void;
}) {
  const [openDialog, setOpenDialog] = useState<"none" | "rename" | "archive">("none");
  const [rowError, setRowError] = useState<string | null>(null);
  const busy = lifecycle.isProjectBusy(project.id);
  // Phase 7D.3B — `busy` alone doesn't say WHICH operation is running (it's
  // shared across Rename/Archive/Restore for this Project), so it must
  // never drive progress-text choice on its own — only which operation
  // actually holds the lock may claim to be "in progress." Restore is the
  // only control here with its own busy-conditional label (Rename/Archive
  // dispatch through their own dialogs, whose "Saving…"/"Archiving…" text
  // is already scoped to their own submit action).
  const restoreInFlight = lifecycle.getBusyOperation(project.id) === "restore";
  const renameTriggerRef = useRef<HTMLButtonElement>(null);
  const archiveTriggerRef = useRef<HTMLButtonElement>(null);

  async function handleRestore() {
    if (busy) return;
    setRowError(null);
    const result = await lifecycle.restoreProject(project);
    if (result.status === "ok") {
      refreshSections();
    } else {
      setRowError(projectMutationErrorCopy(result.errorCode));
      if (isStaleProjectMutationError(result.errorCode)) {
        refreshSections();
      }
    }
  }

  return (
    <li className="rounded-xl border-2 border-cp-border bg-cp-raised px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Phase 7E-B — name is the only clickable part of the row; lifecycle
            actions remain separate sibling buttons, never nested inside this
            link (avoids nested/ambiguous interactive elements). */}
        <Link
          href={`/workspace/projects/${encodeURIComponent(project.id)}`}
          className="min-w-0 flex-1 break-words text-sm font-medium text-cp-text hover:underline"
        >
          {project.name}
        </Link>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button ref={renameTriggerRef} type="button" disabled={busy} onClick={() => setOpenDialog("rename")} className={buttonClass}>
            Rename
          </button>
          {variant === "active" && (
            <button ref={archiveTriggerRef} type="button" disabled={busy} onClick={() => setOpenDialog("archive")} className={buttonClass}>
              Archive
            </button>
          )}
          {variant === "archived" && (
            <button type="button" disabled={busy} onClick={handleRestore} className={buttonClass}>
              {restoreInFlight ? "Restoring…" : "Restore"}
            </button>
          )}
        </div>
      </div>

      {rowError && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {rowError}
        </p>
      )}

      {openDialog === "rename" && (
        <RenameProjectDialog
          project={project}
          triggerRef={renameTriggerRef}
          onClose={() => setOpenDialog("none")}
          lifecycle={lifecycle}
          onRenamed={(updated) => {
            setOpenDialog("none");
            onRenamed(updated);
          }}
          onStaleConflict={refreshSections}
        />
      )}

      {openDialog === "archive" && (
        <ArchiveProjectDialog
          project={project}
          triggerRef={archiveTriggerRef}
          onClose={() => setOpenDialog("none")}
          lifecycle={lifecycle}
          onArchived={() => {
            setOpenDialog("none");
            refreshSections();
          }}
          onStaleConflict={refreshSections}
        />
      )}
    </li>
  );
}
