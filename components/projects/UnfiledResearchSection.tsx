"use client";

/**
 * Phase 7C — "Unfiled" section: `GET /api/user/project-runs?scope=unfiled`.
 * Reuses `WorkspaceRunCard` unmodified (not a copy) — `ProjectRunSummary`
 * is structurally `RunSummaryBase & {projectId}`, a strict superset of
 * `WorkspaceRunSummary`, so passing an Unfiled run item into the exact
 * same card component type-checks and renders identically, including its
 * canonical `/?openResearchRun={id}` report link and governance chip. No
 * "Move to Project"/"Assign" affordance — mutation UI, out of scope.
 */

import { isDefinitiveEmptyUnfiledState, type UnfiledRunsErrorCode, type UseUnfiledRunsResult } from "@/hooks/useUnfiledRuns";
import { WorkspaceRunCard } from "@/components/workspace/WorkspaceRunCard";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";

function initialErrorCopy(code: UnfiledRunsErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view your research.", retry: false };
    default:
      return { message: "Couldn't load your unfiled research right now. This is usually temporary.", retry: true };
  }
}

function loadMoreErrorCopy(code: UnfiledRunsErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more research. Please try again.", action: "retry" };
}

export function UnfiledResearchSection({ result }: { result: UseUnfiledRunsResult }) {
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = result;

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-cp-text">Unfiled</h2>

      {status === "loading" && <SectionLoadingRow label="Loading your unfiled research…" />}

      {status === "error" &&
        initialErrorCode &&
        (() => {
          const copy = initialErrorCopy(initialErrorCode);
          return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={retryInitial} />;
        })()}

      {status === "ready" && isDefinitiveEmptyUnfiledState({ status, items, hasMore }) && <SectionEmptyBox lines={["No unfiled research."]} />}

      {status === "ready" && items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <WorkspaceRunCard key={item.id} item={item} />
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
