"use client";

/**
 * Phase 7D — "Rename" dialog: `PATCH /api/user/projects/{id}` with the
 * row's exact `expectedUpdateTime`. No optimistic rename before canonical
 * success. On success, adopts the returned fresh Project DTO (fresh
 * `updateTime` becomes canonical) via `onRenamed`. On a stale/invalid-
 * transition conflict, never auto-retries — surfaces the message and
 * triggers `onStaleConflict` (a read refresh), leaving the user to decide
 * whether to reopen and try again.
 */

import { useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { projectMutationErrorCopy, isStaleProjectMutationError } from "@/components/projects/projectMutationErrorCopy";
import { isValidProjectNameClientSide, PROJECT_NAME_MAX_LENGTH } from "@/lib/projects/projectNameClient";
import type { ProjectSummary } from "@/hooks/useProjects";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";

export function RenameProjectDialog({
  project,
  triggerRef,
  onClose,
  lifecycle,
  onRenamed,
  onStaleConflict,
}: {
  project: ProjectSummary;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  lifecycle: UseProjectLifecycleResult;
  onRenamed: (updated: ProjectSummary) => void;
  onStaleConflict: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitting = lifecycle.isProjectBusy(project.id);

  async function handleSubmit(e: React.FormEvent, requestClose: () => void) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    const result = await lifecycle.renameProject(project, name);
    if (result.status === "ok") {
      requestClose();
      onRenamed(result.project);
    } else {
      setError(projectMutationErrorCopy(result.errorCode));
      if (isStaleProjectMutationError(result.errorCode)) {
        onStaleConflict();
      }
    }
  }

  return (
    <ProjectDialogFrame title="Rename project" triggerRef={triggerRef} onClose={onClose} initialFocusRef={inputRef}>
      {({ titleId, requestClose }) => (
        <form onSubmit={(e) => handleSubmit(e, requestClose)} className="mt-4">
          <label htmlFor={`${titleId}-name`} className="block text-xs font-medium text-cp-muted">
            Project name
          </label>
          <input
            id={`${titleId}-name`}
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            disabled={submitting}
            className="mt-1 w-full rounded-lg border border-cp-border px-3 py-2 text-sm text-cp-text disabled:opacity-50"
          />
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
              type="submit"
              disabled={submitting || !isValidProjectNameClientSide(name)}
              className="rounded-lg bg-cp-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cp-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </ProjectDialogFrame>
  );
}
