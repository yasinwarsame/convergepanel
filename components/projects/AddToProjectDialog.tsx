"use client";

/**
 * Phase 7E-A — "Add to project" chooser: presents only Active Projects
 * (never Archived — spec item 12) as assignment targets for one Unfiled
 * run, then dispatches exactly one `PATCH /api/user/runs/{runId}/project`
 * via `useRunProjectAssociation()`.
 *
 * Reuses `useProjects({status:"active"})` verbatim for the target list —
 * same production-proven parser/integrity check Active/Archived Projects
 * sections already use (a contradictory archived row injected into an
 * "active" response still fails the whole page closed here, exactly as
 * it does there), same opaque-cursor pagination. This hook instance is
 * independent of the main page's own Active Projects section instance —
 * opening/paginating the chooser never touches the main section's state.
 *
 * `run.projectId` (always `null` for a canonical Unfiled row — the only
 * kind `UnfiledRunAssignAction` ever passes in) is threaded through as
 * this operation's `expectedProjectId`, never a hardcoded literal, never
 * inferred from anything else.
 */

import { useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { runProjectAssociationErrorCopy, isStaleUnfiledAssociationError, isStaleTargetAssociationError } from "@/components/projects/runProjectAssociationErrorCopy";
import { isDefinitiveEmptyProjectsState, useProjects, type ProjectsListErrorCode } from "@/hooks/useProjects";
import type { ProjectRunSummary } from "@/hooks/useUnfiledRuns";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

function chooserInitialErrorCopy(code: ProjectsListErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view your projects.", retry: false };
    default:
      return { message: "Couldn't load your projects right now. This is usually temporary.", retry: true };
  }
}

function chooserLoadMoreErrorCopy(code: ProjectsListErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more projects. Please try again.", action: "retry" };
}

export function AddToProjectDialog({
  run,
  triggerRef,
  onClose,
  association,
  onAssigned,
  onStaleUnfiled,
}: {
  run: ProjectRunSummary;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  association: UseRunProjectAssociationResult;
  onAssigned: (projectName: string) => void;
  onStaleUnfiled: () => void;
}) {
  const active = useProjects({ status: "active" });
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = association.isRunBusy(run.id);

  async function handleAdd(requestClose: () => void) {
    if (submitting || !selectedProjectId) return;
    setError(null);
    const selectedProject = active.items.find((p) => p.id === selectedProjectId);
    const result = await association.assign(run.id, selectedProjectId, run.projectId);
    if (result.status === "ok") {
      requestClose();
      onAssigned(selectedProject?.name ?? "the project");
      return;
    }
    setError(runProjectAssociationErrorCopy(result.errorCode));
    if (isStaleUnfiledAssociationError(result.errorCode)) {
      onStaleUnfiled();
    } else if (isStaleTargetAssociationError(result.errorCode)) {
      setSelectedProjectId(null);
      active.resetAndReloadFromStart();
    }
  }

  return (
    <ProjectDialogFrame title="Add to project" triggerRef={triggerRef} onClose={onClose}>
      {({ requestClose }) => (
        <div className="mt-4">
          {active.status === "loading" && <SectionLoadingRow label="Loading active projects…" />}

          {active.status === "error" &&
            active.initialErrorCode &&
            (() => {
              const copy = chooserInitialErrorCopy(active.initialErrorCode);
              return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={active.retryInitial} />;
            })()}

          {active.status === "ready" && isDefinitiveEmptyProjectsState(active) && <SectionEmptyBox lines={["No active projects available."]} />}

          {active.status === "ready" && active.items.length > 0 && (
            <ul className="max-h-64 space-y-1 overflow-y-auto" role="listbox" aria-label="Active projects">
              {active.items.map((project) => {
                const selected = project.id === selectedProjectId;
                return (
                  <li key={project.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => setSelectedProjectId(project.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm break-words ${
                        selected ? "border-cp-accent bg-cp-primary-soft text-cp-text" : "border-cp-border text-cp-text hover:bg-cp-raised"
                      }`}
                    >
                      {project.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {active.status === "ready" &&
            active.hasMore &&
            (() => {
              const copy = active.loadMoreErrorCode ? chooserLoadMoreErrorCopy(active.loadMoreErrorCode) : null;
              return (
                <SectionPagination
                  loadingMore={active.loadingMore}
                  errorMessage={copy?.message ?? null}
                  errorAction={copy?.action ?? null}
                  onLoadMore={active.loadMore}
                  onReload={active.resetAndReloadFromStart}
                />
              );
            })()}

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-700">
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
              type="button"
              disabled={submitting || !selectedProjectId}
              onClick={() => handleAdd(requestClose)}
              className="rounded-lg bg-cp-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cp-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}
