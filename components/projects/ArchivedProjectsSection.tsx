"use client";

/**
 * Phase 7C — "Archived Projects" section: `GET /api/user/projects?status=archived`.
 * Read-only summary rows only — explicitly no "Restore" control in this
 * phase (that's mutation UI, out of scope).
 */

import { isDefinitiveEmptyProjectsState, type ProjectsListErrorCode, type UseProjectsResult } from "@/hooks/useProjects";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";

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

function ProjectRow({ name }: { name: string }) {
  return (
    <li className="rounded-xl border-2 border-cp-border bg-cp-raised px-3 py-3">
      <span className="block text-sm font-medium text-cp-text">{name}</span>
    </li>
  );
}

export function ArchivedProjectsSection({ result }: { result: UseProjectsResult }) {
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
            <ProjectRow key={item.id} name={item.name} />
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
