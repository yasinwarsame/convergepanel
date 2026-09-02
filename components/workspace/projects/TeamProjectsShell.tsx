"use client";

/**
 * Team Projects UI, Phase 12A.2 — the `/workspace/team/{workspaceId}/projects`
 * client shell: the PERMANENT Team Projects surface (Section B/Q — this
 * remains available regardless of activation completion, Project count,
 * or Workspace research state; nothing in this component reads or
 * depends on any activation-state signal).
 *
 * Deliberately NOT a reuse of Personal's `ActiveProjectsSection.tsx` —
 * that component renders no links to a Project-detail route at all (none
 * exists on the Personal side either), but Team Project rows here MUST
 * link to the new Team Project detail route, which a shared,
 * link-free component can't provide without modifying Personal's
 * behavior. Reuses the genuinely generic pieces instead: `SectionState`,
 * `TeamNewProjectDialog` (itself reusing `ProjectDialogFrame`/name
 * validators), `useTeamProjects`, `useTeamProjectLifecycle`.
 */

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTeamProjects, isDefinitiveEmptyTeamProjectsState, type TeamProjectsListErrorCode, type TeamProjectSummary } from "@/hooks/useTeamProjects";
import { useTeamProjectLifecycle } from "@/hooks/useTeamProjectLifecycle";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { TeamNewProjectDialog } from "@/components/workspace/projects/TeamNewProjectDialog";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";

function initialErrorCopy(code: TeamProjectsListErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view this Workspace's Projects.", retry: false };
    default:
      return { message: "Couldn't load this Workspace's Projects right now. This is usually temporary.", retry: true };
  }
}

function loadMoreErrorCopy(code: TeamProjectsListErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more Projects. Please try again.", action: "retry" };
}

export default function TeamProjectsShell({
  workspaceId,
  workspaceName,
  canCreateProject,
  canReadAudit,
}: {
  workspaceId: string;
  workspaceName: string;
  canCreateProject: boolean;
  canReadAudit: boolean;
}) {
  const router = useRouter();
  const result = useTeamProjects({ workspaceId });
  const lifecycle = useTeamProjectLifecycle({ workspaceId });
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = result;

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const newProjectTriggerRef = useRef<HTMLButtonElement>(null);

  /**
   * Phase 12A.2 Section M — on successful creation, enter the new
   * Project directly (mirrors 12A.1's Workspace-creation redirect
   * improvement) using ONLY the authoritative `project.id`/`workspaceId`
   * from the create response — never inferred from the typed name, never
   * re-derived by searching the list.
   */
  function handleProjectCreated(project: TeamProjectSummary) {
    router.push(`/workspace/team/${encodeURIComponent(project.workspaceId)}/projects/${encodeURIComponent(project.id)}`);
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">{workspaceName}</h1>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="projects" showAudit={canReadAudit} />

      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-cp-text">Projects</h2>
        {canCreateProject && (
          <button
            ref={newProjectTriggerRef}
            type="button"
            onClick={() => setNewProjectOpen(true)}
            className="rounded-lg border-2 border-cp-border bg-cp-surface px-3 py-1.5 text-xs font-semibold text-cp-text transition-colors hover:border-cp-accent hover:bg-cp-primary-soft"
          >
            New Project
          </button>
        )}
      </div>

      {newProjectOpen && (
        <TeamNewProjectDialog
          triggerRef={newProjectTriggerRef}
          onClose={() => setNewProjectOpen(false)}
          lifecycle={lifecycle}
          onCreated={handleProjectCreated}
        />
      )}

      {status === "loading" && <SectionLoadingRow label="Loading Projects…" />}

      {status === "error" &&
        initialErrorCode &&
        (() => {
          const copy = initialErrorCopy(initialErrorCode);
          return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={retryInitial} />;
        })()}

      {status === "ready" &&
        isDefinitiveEmptyTeamProjectsState({ status, items, hasMore }) &&
        (canCreateProject ? (
          <SectionEmptyBox lines={["No projects yet.", "Create a Project to organize your team's research and verification work."]} />
        ) : (
          <SectionEmptyBox lines={["No projects yet."]} />
        ))}

      {status === "ready" && items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="rounded-xl border-2 border-cp-border bg-cp-raised transition-colors hover:border-cp-accent hover:bg-cp-primary-soft">
              <Link
                href={`/workspace/team/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(item.id)}`}
                className="block px-3 py-3 text-sm font-medium text-cp-text"
              >
                {item.name}
              </Link>
            </li>
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
    </main>
  );
}
