"use client";

/**
 * Phase 7E-B — "Remove from project" confirmation dialog for an already-
 * assigned run. Structural mirror of `ArchiveProjectDialog.tsx`'s
 * confirm-step pattern (this is relocation, immediately visible on the
 * page the user is looking at, not deletion — a lightweight confirmation
 * is warranted, per explicit product direction). The saved report/run
 * itself is never touched; only its Project association changes.
 */

import { useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { runProjectAssociationErrorCopy, isStaleUnfiledAssociationError } from "@/components/projects/runProjectAssociationErrorCopy";
import type { ProjectRunSummary } from "@/hooks/useProjectRuns";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

export function RemoveFromProjectDialog({
  run,
  sourceProjectId,
  triggerRef,
  onClose,
  association,
  onRemoved,
  onStaleSource,
}: {
  run: ProjectRunSummary;
  sourceProjectId: string;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  association: UseRunProjectAssociationResult;
  onRemoved: () => void;
  onStaleSource: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const submitting = association.isRunBusy(run.id);
  const removeInFlight = association.getBusyOperation(run.id) === "remove";

  async function handleConfirm(requestClose: () => void) {
    if (submitting) return;
    setError(null);
    const result = await association.remove(run.id, sourceProjectId);
    if (result.status === "ok") {
      requestClose();
      onRemoved();
      return;
    }
    setError(runProjectAssociationErrorCopy(result.errorCode));
    if (isStaleUnfiledAssociationError(result.errorCode)) {
      onStaleSource();
    }
  }

  return (
    <ProjectDialogFrame title="Remove from project?" triggerRef={triggerRef} onClose={onClose} initialFocusRef={confirmButtonRef}>
      {({ requestClose }) => (
        <div className="mt-4">
          <p className="text-sm text-cp-muted">This research will return to Unfiled. The saved report will not be deleted.</p>
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
              {removeInFlight ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}
