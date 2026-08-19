"use client";

/**
 * Phase 7E-B — the Project detail shell: one Project's assigned research,
 * with Move/Remove controls. Split into a pure, prop-driven view
 * (`ProjectDetailShellView`, directly testable) and a thin default-export
 * wrapper that supplies the two live hooks — mirrors `ProjectsShell.tsx`'s
 * identical split.
 *
 * No Project lifecycle controls here by design (spec item 7/31/46) —
 * Rename/Archive/Restore remain exclusively on `/workspace/projects`.
 * `project` ({id, name, status}) is obtained once, server-side, at the
 * page's own authorization gate (`resolveProjectForOwner()`) — no live
 * resync while this page is open; a concurrent rename in another tab is
 * resolved only on reload/navigation (deliberate scope, spec item 30).
 *
 * The post-Move/Remove acknowledgement is section-owned here (not per-
 * card), for the identical reason `UnfiledResearchSection`'s toast is
 * section-owned: the moved/removed run's OWN card unmounts the instant
 * this page's run list resets, so a per-card-owned acknowledgement would
 * never have a chance to be seen.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { WorkspaceRunCard } from "@/components/workspace/WorkspaceRunCard";
import { AssignedRunActions } from "@/components/projects/AssignedRunActions";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { useProjectRuns, isDefinitiveEmptyProjectRunsState, type UseProjectRunsResult, type ProjectRunsErrorCode } from "@/hooks/useProjectRuns";
import { useRunProjectAssociation } from "@/hooks/useRunProjectAssociation";
import type { UseRunProjectAssociationResult } from "@/hooks/useRunProjectAssociation";

const TOAST_DURATION_MS = 4000;

export interface ProjectDetailMeta {
  id: string;
  name: string;
  status: "active" | "archived";
}

function detailInitialErrorCopy(code: ProjectRunsErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view this project.", retry: false };
    default:
      return { message: "Couldn't load this project's research right now. This is usually temporary.", retry: true };
  }
}

function detailLoadMoreErrorCopy(code: ProjectRunsErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more research. Please try again.", action: "retry" };
}

export function ProjectDetailShellView({
  project,
  runs,
  association,
}: {
  project: ProjectDetailMeta;
  runs: UseProjectRunsResult;
  association: UseRunProjectAssociationResult;
}) {
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = runs;
  const [toast, setToast] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setToast(null), TOAST_DURATION_MS);
  }

  function handleMoved(projectName: string) {
    showToast(`Moved to ${projectName}.`);
    resetAndReloadFromStart();
  }

  function handleRemoved() {
    showToast("Removed from project.");
    resetAndReloadFromStart();
  }

  function handleStaleAssociation() {
    resetAndReloadFromStart();
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <Link href="/workspace/projects" className="text-sm font-medium text-cp-accent hover:underline">
        ← Back to Projects
      </Link>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-cp-text break-words">{project.name}</h1>
        <span className="rounded-full border border-cp-border px-2.5 py-0.5 text-xs font-medium text-cp-muted">
          {project.status === "active" ? "Active" : "Archived"}
        </span>
      </div>

      {toast && (
        <p role="status" className="mt-3 text-sm font-medium text-cp-accent">
          {toast}
        </p>
      )}

      <section className="mt-8">
        {status === "loading" && <SectionLoadingRow label="Loading research…" />}

        {status === "error" &&
          initialErrorCode &&
          (() => {
            const copy = detailInitialErrorCopy(initialErrorCode);
            return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={retryInitial} />;
          })()}

        {status === "ready" && isDefinitiveEmptyProjectRunsState({ status, items, hasMore }) && (
          <SectionEmptyBox lines={["No research in this project."]} />
        )}

        {status === "ready" && items.length > 0 && (
          <ul className="mt-4 space-y-2">
            {items.map((item) => (
              <WorkspaceRunCard
                key={item.id}
                item={item}
                actions={
                  // Defense-in-depth (spec item 13): the server/hook already
                  // fails the WHOLE page closed on any projectId mismatch, so
                  // this branch should never be reachable — but this page
                  // still never trusts the route parameter as the
                  // authoritative source for a contradictory row.
                  item.projectId === project.id ? (
                    <AssignedRunActions
                      run={item}
                      sourceProjectId={project.id}
                      association={association}
                      onMoved={handleMoved}
                      onRemoved={handleRemoved}
                      onStaleAssociation={handleStaleAssociation}
                    />
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}

        {status === "ready" &&
          hasMore &&
          (() => {
            const copy = loadMoreErrorCode ? detailLoadMoreErrorCopy(loadMoreErrorCode) : null;
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
    </main>
  );
}

export default function ProjectDetailShell({ project }: { project: ProjectDetailMeta }) {
  const runs = useProjectRuns(project.id);
  const association = useRunProjectAssociation();
  return <ProjectDetailShellView project={project} runs={runs} association={association} />;
}
