"use client";

/**
 * Phase 7C — "Unfiled" section: `GET /api/user/project-runs?scope=unfiled`.
 * Reuses `WorkspaceRunCard` unmodified (not a copy) — `ProjectRunSummary`
 * is structurally `RunSummaryBase & {projectId}`, a strict superset of
 * `WorkspaceRunSummary`, so passing an Unfiled run item into the exact
 * same card component type-checks and renders identically, including its
 * canonical `/?openResearchRun={id}` report link and governance chip.
 *
 * Phase 7E-A adds exactly one action: "Add to project", rendered via
 * `WorkspaceRunCard`'s optional `actions` slot (never nested inside the
 * card's own report-navigation `<a>`). This section owns the one shared
 * post-assignment acknowledgement (a lightweight local status message —
 * this codebase has no shared toast primitive; mirrors
 * `GovernanceDashboard.tsx`'s local self-clearing pattern) because the
 * assigned run's OWN card unmounts the instant Unfiled resets, so any
 * per-card-owned acknowledgement would never have a chance to be seen.
 */

import { useEffect, useRef, useState } from "react";
import { isDefinitiveEmptyUnfiledState, type UnfiledRunsErrorCode, type UseUnfiledRunsResult } from "@/hooks/useUnfiledRuns";
import { WorkspaceRunCard } from "@/components/workspace/WorkspaceRunCard";
import { UnfiledRunAssignAction } from "@/components/projects/UnfiledRunAssignAction";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

const TOAST_DURATION_MS = 4000;

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

export function UnfiledResearchSection({
  result,
  association,
  onAssigned,
}: {
  result: UseUnfiledRunsResult;
  association: UseRunProjectAssociationResult;
  /** Read refresh only — a pure "reload Unfiled from page 1" callback. Called both on successful assignment and on a stale-state conflict; this section decides on its own whether that call also earns a success acknowledgement. */
  onAssigned: () => void;
}) {
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = result;
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  function handleAssignSuccess(projectName: string) {
    setToast(`Added to ${projectName}.`);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    onAssigned();
  }

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-cp-text">Unfiled</h2>

      {toast && (
        <p role="status" className="mt-2 text-sm font-medium text-cp-accent">
          {toast}
        </p>
      )}

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
            <WorkspaceRunCard
              key={item.id}
              item={item}
              actions={
                <UnfiledRunAssignAction run={item} association={association} onAssignSuccess={handleAssignSuccess} onStaleUnfiled={onAssigned} />
              }
            />
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
