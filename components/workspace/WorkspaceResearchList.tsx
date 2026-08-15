/**
 * Phase 5D — "Recent research" section: the list of Workspace-bound runs,
 * pagination, and the single provenance-safe empty state. Purely
 * prop-driven (`result: UseWorkspaceRunsResult`) so every state is
 * directly renderable via `renderToStaticMarkup`, matching this repo's
 * established no-jsdom testing convention.
 */

import { isDefinitiveEmptyState, type UseWorkspaceRunsResult, type WorkspaceRunsErrorCode } from "@/hooks/useWorkspaceRuns";
import { WorkspaceRunCard } from "@/components/workspace/WorkspaceRunCard";

/**
 * Pure: an initial-load runs error is either the SAME underlying
 * Workspace-prerequisite failure `GET /api/user/workspace` already guards
 * against (escalate — the whole page is degraded, not just the list), or
 * a runs-endpoint-specific failure that only affects this section (the
 * Workspace itself is fine; only the list temporarily isn't). See
 * `docs/workspaces/phase5d-workspace-research-design.md` §20–21.
 */
export type EscalatedWorkspaceRunsErrorCode = "workspace_missing" | "workspace_invalid" | "workspace_unavailable";

/** Type predicate so callers (e.g. `WorkspaceShellView`) can narrow to the exact codes `errorCopy()`'s `WorkspaceMetadataErrorCode` type accepts, not just a boolean. */
export function isEscalatedWorkspaceRunsError(code: WorkspaceRunsErrorCode): code is EscalatedWorkspaceRunsErrorCode {
  return code === "workspace_missing" || code === "workspace_invalid" || code === "workspace_unavailable";
}

export function classifyWorkspaceRunsInitialError(code: WorkspaceRunsErrorCode): "escalate" | "section-local" {
  return isEscalatedWorkspaceRunsError(code) ? "escalate" : "section-local";
}

function sectionErrorCopy(code: WorkspaceRunsErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view your research.", retry: false };
    case "invalid_cursor":
    case "index_required":
    case "internal_error":
    case "network_error":
    case "workspace_missing":
    case "workspace_invalid":
    case "workspace_unavailable":
      // The last three are unreachable in practice — the page-level
      // escalation (classifyWorkspaceRunsInitialError) handles them before
      // this component ever renders an error branch. Kept exhaustive so a
      // future new error code fails TypeScript compilation, not silently.
      return { message: "Couldn't load your research right now. This is usually temporary.", retry: true };
  }
}

function loadMoreErrorCopy(code: WorkspaceRunsErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    // Never surface "cursor" terminology; retrying the identical cursor
    // would just fail again identically, so offer an explicit reset
    // instead of a same-request retry.
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more research. Please try again.", action: "retry" };
}

function SectionInitialError({ code, onRetry }: { code: WorkspaceRunsErrorCode; onRetry: () => void }) {
  const copy = sectionErrorCopy(code);
  return (
    <div className="mt-4 rounded-lg border border-cp-border bg-cp-raised p-4" role="alert">
      <p className="text-sm text-cp-muted">{copy.message}</p>
      {copy.retry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md border border-cp-border px-3 py-1.5 text-sm font-medium text-cp-text transition-colors hover:bg-cp-surface"
        >
          Try again
        </button>
      )}
    </div>
  );
}

function PaginationControl({
  loadingMore,
  loadMoreErrorCode,
  onLoadMore,
  onReload,
}: {
  loadingMore: boolean;
  loadMoreErrorCode: WorkspaceRunsErrorCode | null;
  onLoadMore: () => void;
  onReload: () => void;
}) {
  if (loadMoreErrorCode) {
    const copy = loadMoreErrorCopy(loadMoreErrorCode);
    return (
      <div className="mt-4 flex flex-col items-center gap-2" role="alert">
        <p className="text-sm text-cp-muted">{copy.message}</p>
        <button
          type="button"
          onClick={copy.action === "reload" ? onReload : onLoadMore}
          className="rounded-xl border-2 border-cp-border bg-cp-surface px-5 py-2.5 text-sm font-semibold text-cp-muted shadow-sm transition-colors hover:border-cp-accent hover:bg-cp-primary-soft"
        >
          {copy.action === "reload" ? "Reload" : "Retry"}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-4 flex justify-center">
      <button
        type="button"
        disabled={loadingMore}
        onClick={onLoadMore}
        className="rounded-xl border-2 border-cp-border bg-cp-surface px-5 py-2.5 text-sm font-semibold text-cp-muted shadow-sm transition-colors hover:border-cp-accent hover:bg-cp-primary-soft disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loadingMore ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

export function WorkspaceResearchList({ result }: { result: UseWorkspaceRunsResult }) {
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = result;

  if (status === "error" && initialErrorCode && classifyWorkspaceRunsInitialError(initialErrorCode) === "escalate") {
    // The parent (WorkspaceShellView) is responsible for rendering the
    // page-level error for this case — this section renders nothing so
    // it isn't duplicated alongside the page-level error.
    return null;
  }

  return (
    <div className="mt-10">
      <h2 className="text-lg font-semibold text-cp-text">Recent research</h2>

      {status === "loading" && (
        <p className="mt-2 text-sm text-cp-muted" role="status">
          Loading your research…
        </p>
      )}

      {status === "error" && initialErrorCode && <SectionInitialError code={initialErrorCode} onRetry={retryInitial} />}

      {status === "ready" && isDefinitiveEmptyState({ status, items, hasMore }) && (
        <div className="mt-4 rounded-lg border border-cp-border bg-cp-raised p-4">
          <p className="text-sm text-cp-muted">New research will appear here.</p>
          <p className="mt-1 text-sm text-cp-muted">You can find all of your research in History.</p>
        </div>
      )}

      {status === "ready" && items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <WorkspaceRunCard key={item.id} item={item} />
          ))}
        </ul>
      )}

      {status === "ready" && hasMore && (
        <PaginationControl loadingMore={loadingMore} loadMoreErrorCode={loadMoreErrorCode} onLoadMore={loadMore} onReload={resetAndReloadFromStart} />
      )}
    </div>
  );
}
