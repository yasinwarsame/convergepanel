"use client";

/**
 * Phase 7E-A — per-card "Add to project" trigger for one Unfiled run.
 * Owns only its own dialog-open state; the actual mutation and per-run
 * lock live in the shared `useRunProjectAssociation()` instance threaded
 * down from `ProjectsShell` (mirrors `ProjectLifecycleRow`'s identical
 * shared-hook-instance-per-shell shape from Phase 7D).
 */

import { useRef, useState } from "react";
import { AddToProjectDialog } from "@/components/projects/AddToProjectDialog";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";
import type { ProjectRunSummary } from "@/hooks/useUnfiledRuns";

const buttonClass =
  "rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text transition-colors hover:bg-cp-surface disabled:cursor-not-allowed disabled:opacity-50";

export function UnfiledRunAssignAction({
  run,
  association,
  onAssignSuccess,
  onStaleUnfiled,
}: {
  run: ProjectRunSummary;
  association: UseRunProjectAssociationResult;
  onAssignSuccess: (projectName: string) => void;
  onStaleUnfiled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const busy = association.isRunBusy(run.id);

  return (
    <>
      <button ref={triggerRef} type="button" disabled={busy} onClick={() => setOpen(true)} className={buttonClass}>
        Add to project
      </button>
      {open && (
        <AddToProjectDialog
          run={run}
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
          association={association}
          onAssigned={(projectName) => {
            setOpen(false);
            onAssignSuccess(projectName);
          }}
          onStaleUnfiled={onStaleUnfiled}
        />
      )}
    </>
  );
}
