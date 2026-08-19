"use client";

/**
 * Phase 7D — "New Project" dialog: `POST /api/user/projects`. Exactly one
 * submit dispatches exactly one request (button disabled while
 * `lifecycle.isCreating`); no optimistic Project insertion before the
 * canonical 201 response. On success, closes and defers to the caller
 * (`onCreated`) to reset the Active Projects section from page 1 — this
 * component never mutates list state directly.
 */

import { useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { projectMutationErrorCopy } from "@/components/projects/projectMutationErrorCopy";
import { isValidProjectNameClientSide, PROJECT_NAME_MAX_LENGTH } from "@/lib/projects/projectNameClient";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";

export function NewProjectDialog({
  triggerRef,
  onClose,
  lifecycle,
  onCreated,
}: {
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  lifecycle: UseProjectLifecycleResult;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submitting = lifecycle.isCreating;

  async function handleSubmit(e: React.FormEvent, requestClose: () => void) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    const result = await lifecycle.createProject(name);
    if (result.status === "ok") {
      requestClose();
      onCreated();
    } else {
      setError(projectMutationErrorCopy(result.errorCode));
    }
  }

  return (
    <ProjectDialogFrame title="New project" triggerRef={triggerRef} onClose={onClose} initialFocusRef={inputRef}>
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
              {submitting ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      )}
    </ProjectDialogFrame>
  );
}
