"use client";

/**
 * Phase 7D — "Archive" confirmation dialog: `POST /api/user/projects/{id}/archive`
 * with the row's exact `expectedUpdateTime`. Deliberate confirmation step
 * (spec item 12) — copy reflects the already-proven no-fanout behavior:
 * existing research stays associated, nothing is deleted or unassigned.
 * No optimistic removal from the Active list before canonical success.
 */

import { useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { projectMutationErrorCopy, isStaleProjectMutationError } from "@/components/projects/projectMutationErrorCopy";
import type { ProjectSummary } from "@/hooks/useProjects";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";

export function ArchiveProjectDialog({
  project,
  triggerRef,
  onClose,
  lifecycle,
  onArchived,
  onStaleConflict,
}: {
  project: ProjectSummary;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  lifecycle: UseProjectLifecycleResult;
  onArchived: () => void;
  onStaleConflict: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const submitting = lifecycle.isProjectBusy(project.id);

  async function handleConfirm(requestClose: () => void) {
    if (submitting) return;
    setError(null);
    const result = await lifecycle.archiveProject(project);
    if (result.status === "ok") {
      requestClose();
      onArchived();
    } else {
      setError(projectMutationErrorCopy(result.errorCode));
      if (isStaleProjectMutationError(result.errorCode)) {
        onStaleConflict();
      }
    }
  }

  return (
    <ProjectDialogFrame title={`Archive "${project.name}"?`} triggerRef={triggerRef} onClose={onClose} initialFocusRef={confirmButtonRef}>
      {({ requestClose }) => (
        <div className="mt-4">
          <p className="text-sm text-cp-muted">Existing research stays in this project. You can restore the project later.</p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={requestClose}
              className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised"
            >
              Cancel
            </button>
            <button
              ref={confirmButtonRef}
              type="button"
              disabled={submitting}
              onClick={() => handleConfirm(requestClose)}
              className="rounded-lg bg-cp-orange px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Archiving…" : "Archive"}
            </button>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}
