"use client";

/**
 * Phase 7C — "Active Projects" section: `GET /api/user/projects` (default
 * `status=active`). Phase 7D adds lifecycle controls: a "New Project"
 * trigger near the heading, and Rename/Archive on every row (via the
 * shared `ProjectLifecycleRow`). Still no links to a Project-detail route
 * (none exists yet), no counts (no API supplies an authoritative one).
 */

import { useRef, useState } from "react";
import { isDefinitiveEmptyProjectsState, type ProjectsListErrorCode, type ProjectSummary, type UseProjectsResult } from "@/hooks/useProjects";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { ProjectLifecycleRow } from "@/components/projects/ProjectLifecycleRow";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";

function initialErrorCopy(code: ProjectsListErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view your Projects.", retry: false };
    default:
      return { message: "Couldn't load your Projects right now. This is usually temporary.", retry: true };
  }
}

function loadMoreErrorCopy(code: ProjectsListErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more Projects. Please try again.", action: "retry" };
}

export function ActiveProjectsSection({
  result,
  lifecycle,
  onRenamed,
  refreshSections,
  onCreated,
}: {
  result: UseProjectsResult;
  lifecycle: UseProjectLifecycleResult;
  onRenamed: (updated: ProjectSummary) => void;
  refreshSections: () => void;
  onCreated: () => void;
}) {
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = result;
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const newProjectTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-cp-text">Active Projects</h2>
        <button
          ref={newProjectTriggerRef}
          type="button"
          onClick={() => setNewProjectOpen(true)}
          className="rounded-lg border-2 border-cp-border bg-cp-surface px-3 py-1.5 text-xs font-semibold text-cp-text transition-colors hover:border-cp-accent hover:bg-cp-primary-soft"
        >
          New Project
        </button>
      </div>

      {newProjectOpen && (
        <NewProjectDialog
          triggerRef={newProjectTriggerRef}
          onClose={() => setNewProjectOpen(false)}
          lifecycle={lifecycle}
          onCreated={onCreated}
        />
      )}

      {status === "loading" && <SectionLoadingRow label="Loading your Projects…" />}

      {status === "error" &&
        initialErrorCode &&
        (() => {
          const copy = initialErrorCopy(initialErrorCode);
          return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={retryInitial} />;
        })()}

      {status === "ready" && isDefinitiveEmptyProjectsState({ status, items, hasMore }) && <SectionEmptyBox lines={["No active projects yet."]} />}

      {status === "ready" && items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <ProjectLifecycleRow key={item.id} project={item} variant="active" lifecycle={lifecycle} onRenamed={onRenamed} refreshSections={refreshSections} />
          ))}
        </ul>
      )}

      {status === "ready" &&
        hasMore &&
        (() => {
          const copy = loadMoreErrorCode ? loadMoreErrorCopy(loadMoreErrorCode) : null;
          return (
            <SectionPagination
              loadingMore={loadingMore}
              errorMessage={copy?.message ?? null}
              errorAction={copy?.action ?? null}
              onLoadMore={loadMore}
              onReload={resetAndReloadFromStart}
            />
          );
        })()}
    </section>
  );
}
