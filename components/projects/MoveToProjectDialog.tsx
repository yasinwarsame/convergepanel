"use client";

/**
 * Phase 7E-B — "Move to project" chooser for an already-assigned run.
 * Deliberately a SEPARATE component from `AddToProjectDialog.tsx`, not a
 * refactor of it — protects the already-production-canary-proven Phase
 * 7E-A Add flow from any regression risk while this increment ships. Some
 * code similarity with `AddToProjectDialog` is accepted deliberately; a
 * shared generic chooser can be extracted later if repetition becomes
 * substantial, per explicit product direction.
 *
 * `sourceProjectId` (the run's OWN canonical `projectId`, threaded down
 * from the caller — never re-derived here) is excluded from the offered
 * Active Projects list. This exclusion is target-eligibility filtering,
 * not integrity filtering: a malformed/wrong-status row from
 * `useProjects({status:"active"})` still fails the whole response closed
 * through that hook's own established parser, unaffected by this filter.
 *
 * The empty-state/pagination edge case (spec item 25): if the only Active
 * Project returned is the current source Project, the VISIBLE (post-
 * exclusion) target list is empty, but `hasMore` is evaluated from the
 * underlying `useProjects` state directly, never derived from the
 * filtered array's length — so "Load more" keeps showing whenever more
 * pages exist, and the terminal "No other active projects available."
 * only renders once the underlying read is truly exhausted
 * (`hasMore === false`) AND the filtered list is empty.
 */

import { useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { runProjectAssociationErrorCopy, isStaleUnfiledAssociationError, isStaleTargetAssociationError } from "@/components/projects/runProjectAssociationErrorCopy";
import { useProjects, type ProjectsListErrorCode } from "@/hooks/useProjects";
import type { ProjectRunSummary } from "@/hooks/useProjectRuns";
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

export function MoveToProjectDialog({
  run,
  sourceProjectId,
  triggerRef,
  onClose,
  association,
  onMoved,
  onStaleSource,
}: {
  run: ProjectRunSummary;
  sourceProjectId: string;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  association: UseRunProjectAssociationResult;
  onMoved: (projectName: string) => void;
  onStaleSource: () => void;
}) {
  const active = useProjects({ status: "active" });
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = association.isRunBusy(run.id);
  const moveInFlight = association.getBusyOperation(run.id) === "move";

  const visibleTargets = active.items.filter((p) => p.id !== sourceProjectId);

  async function handleMove(requestClose: () => void) {
    if (submitting || !selectedProjectId) return;
    setError(null);
    const selectedProject = active.items.find((p) => p.id === selectedProjectId);
    const result = await association.move(run.id, selectedProjectId, sourceProjectId);
    if (result.status === "ok") {
      requestClose();
      onMoved(selectedProject?.name ?? "the project");
      return;
    }
    setError(runProjectAssociationErrorCopy(result.errorCode));
    if (isStaleUnfiledAssociationError(result.errorCode)) {
      onStaleSource();
    } else if (isStaleTargetAssociationError(result.errorCode)) {
      setSelectedProjectId(null);
      active.resetAndReloadFromStart();
    }
  }

  return (
    <ProjectDialogFrame title="Move to project" triggerRef={triggerRef} onClose={onClose}>
      {({ requestClose }) => (
        <div className="mt-4">
          {active.status === "loading" && <SectionLoadingRow label="Loading active projects…" />}

          {active.status === "error" &&
            active.initialErrorCode &&
            (() => {
              const copy = chooserInitialErrorCopy(active.initialErrorCode);
              return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={active.retryInitial} />;
            })()}

          {active.status === "ready" && visibleTargets.length === 0 && !active.hasMore && (
            <SectionEmptyBox lines={["No other active projects available."]} />
          )}

          {active.status === "ready" && visibleTargets.length > 0 && (
            <ul className="max-h-64 space-y-1 overflow-y-auto" role="listbox" aria-label="Active projects">
              {visibleTargets.map((project) => {
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
              onClick={() => handleMove(requestClose)}
              className="rounded-lg bg-cp-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cp-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {moveInFlight ? "Moving…" : "Move"}
            </button>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}
