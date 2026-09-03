"use client";

/**
 * Team Project lifecycle UI, Phase PROJECT-UI-AR-I1 — "Archive" confirmation
 * for a Team Project, on the shared accessible `ProjectDialogFrame`
 * (role="dialog", aria-modal, labelled title, initial focus, focus trap,
 * Escape + backdrop close, focus return to the trigger). Team-specific
 * sibling of `components/projects/ArchiveProjectDialog.tsx` — not a reuse,
 * because that dialog's props are typed to the Personal hook/DTO.
 *
 * Outcome handling is deliberately split three ways:
 *   - success: close the dialog, then `onArchived()` (the shell refetches
 *     BOTH sections — never an optimistic row move).
 *   - stale / gone / denied (`shouldRefreshAfterTeamProjectMutationError`):
 *     close the dialog and hand the message to the row via
 *     `onStaleOrGone(message)`, so the refreshed row takes over and this
 *     dialog — which captured the OLD Project + token — can never submit
 *     again. Never retried automatically.
 *   - transient failure (network / internal): keep the dialog open with
 *     the error; nothing committed, the token is still valid, the user may
 *     retry manually.
 */

import { useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { teamProjectMutationErrorCopy, shouldRefreshAfterTeamProjectMutationError } from "@/components/workspace/projects/teamProjectMutationErrorCopy";
import type { TeamProjectSummary } from "@/hooks/useTeamProjects";
import type { UseTeamProjectLifecycleResult } from "@/hooks/useTeamProjectLifecycle";

export function TeamArchiveProjectDialog({
  project,
  triggerRef,
  onClose,
  lifecycle,
  onArchived,
  onStaleOrGone,
}: {
  project: TeamProjectSummary;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  lifecycle: Pick<UseTeamProjectLifecycleResult, "isProjectBusy" | "archiveProject">;
  onArchived: () => void;
  onStaleOrGone: (message: string) => void;
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
      return;
    }
    const message = teamProjectMutationErrorCopy(result.errorCode);
    if (shouldRefreshAfterTeamProjectMutationError(result.errorCode)) {
      requestClose();
      onStaleOrGone(message);
      return;
    }
    setError(message);
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
              disabled={submitting}
              className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised disabled:cursor-not-allowed disabled:opacity-50"
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
