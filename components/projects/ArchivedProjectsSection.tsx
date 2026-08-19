"use client";

/**
 * Phase 7C — "Archived Projects" section: `GET /api/user/projects?status=archived`.
 * Phase 7D adds Rename + Restore (via the shared `ProjectLifecycleRow`) —
 * explicitly no Archive control here and no "New Project" trigger.
 */

import { isDefinitiveEmptyProjectsState, type ProjectsListErrorCode, type ProjectSummary, type UseProjectsResult } from "@/hooks/useProjects";
import type { UseProjectLifecycleResult } from "@/hooks/useProjectLifecycle";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { ProjectLifecycleRow } from "@/components/projects/ProjectLifecycleRow";

function initialErrorCopy(code: ProjectsListErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view your Projects.", retry: false };
    default:
      return { message: "Couldn't load your archived Projects right now. This is usually temporary.", retry: true };
  }
}

function loadMoreErrorCopy(code: ProjectsListErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more Projects. Please try again.", action: "retry" };
}

export function ArchivedProjectsSection({
  result,
  lifecycle,
  onRenamed,
  refreshSections,
}: {
  result: UseProjectsResult;
  lifecycle: UseProjectLifecycleResult;
  onRenamed: (updated: ProjectSummary) => void;
  refreshSections: () => void;
}) {
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = result;

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-cp-text">Archived Projects</h2>

      {status === "loading" && <SectionLoadingRow label="Loading your archived Projects…" />}

      {status === "error" &&
        initialErrorCode &&
        (() => {
          const copy = initialErrorCopy(initialErrorCode);
          return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={retryInitial} />;
        })()}

      {status === "ready" && isDefinitiveEmptyProjectsState({ status, items, hasMore }) && <SectionEmptyBox lines={["No archived projects."]} />}

      {status === "ready" && items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <ProjectLifecycleRow key={item.id} project={item} variant="archived" lifecycle={lifecycle} onRenamed={onRenamed} refreshSections={refreshSections} />
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
