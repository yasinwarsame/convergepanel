"use client";

/**
 * Phase 7E-B — per-card Move + Remove trigger for one assigned run.
 * Mirrors `UnfiledRunAssignAction.tsx`'s shape: owns only its own dialog-
 * open state, dispatches through the shared `useRunProjectAssociation()`
 * instance threaded down from the Project detail shell.
 *
 * Trigger labels are deliberately STATIC ("Move" / "Remove from project")
 * — only `disabled` reacts to the shared per-run busy flag. This is the
 * same structural fix Phase 7D.3B applied to the lifecycle Restore
 * button: a shared busy flag must never let a non-executing control claim
 * (via its own label) to be the one running. Since both operations here
 * go through their own confirmation dialogs (never a no-dialog direct-
 * click control the way lifecycle Restore was), the only place a busy
 * verb belongs is each dialog's own confirm button, gated on
 * `getBusyOperation(runId) === "move"/"remove"` specifically — see
 * `MoveToProjectDialog`/`RemoveFromProjectDialog`.
 */

import { useRef, useState } from "react";
import { MoveToProjectDialog } from "@/components/projects/MoveToProjectDialog";
import { RemoveFromProjectDialog } from "@/components/projects/RemoveFromProjectDialog";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";
import type { ProjectRunSummary } from "@/hooks/useProjectRuns";

const buttonClass =
  "rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text transition-colors hover:bg-cp-surface disabled:cursor-not-allowed disabled:opacity-50";

export function AssignedRunActions({
  run,
  sourceProjectId,
  association,
  onMoved,
  onRemoved,
  onStaleAssociation,
}: {
  run: ProjectRunSummary;
  sourceProjectId: string;
  association: UseRunProjectAssociationResult;
  onMoved: (targetProjectName: string) => void;
  onRemoved: () => void;
  onStaleAssociation: () => void;
}) {
  const [openDialog, setOpenDialog] = useState<"none" | "move" | "remove">("none");
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const removeTriggerRef = useRef<HTMLButtonElement>(null);
  const busy = association.isRunBusy(run.id);

  return (
    <>
      <button ref={moveTriggerRef} type="button" disabled={busy} onClick={() => setOpenDialog("move")} className={buttonClass}>
        Move
      </button>
      <button ref={removeTriggerRef} type="button" disabled={busy} onClick={() => setOpenDialog("remove")} className={buttonClass}>
        Remove from project
      </button>
      {openDialog === "move" && (
        <MoveToProjectDialog
          run={run}
          sourceProjectId={sourceProjectId}
          triggerRef={moveTriggerRef}
          onClose={() => setOpenDialog("none")}
          association={association}
          onMoved={(projectName) => {
            setOpenDialog("none");
            onMoved(projectName);
          }}
          onStaleSource={onStaleAssociation}
        />
      )}
      {openDialog === "remove" && (
        <RemoveFromProjectDialog
          run={run}
          sourceProjectId={sourceProjectId}
          triggerRef={removeTriggerRef}
          onClose={() => setOpenDialog("none")}
          association={association}
          onRemoved={() => {
            setOpenDialog("none");
            onRemoved();
          }}
          onStaleSource={onStaleAssociation}
        />
      )}
    </>
  );
}
