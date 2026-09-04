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

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTeamProjects, isDefinitiveEmptyTeamProjectsState, type TeamProjectsListErrorCode, type TeamProjectSummary } from "@/hooks/useTeamProjects";
import { useTeamProjectLifecycle } from "@/hooks/useTeamProjectLifecycle";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { TeamNewProjectDialog } from "@/components/workspace/projects/TeamNewProjectDialog";
import { TeamProjectLifecycleRow } from "@/components/workspace/projects/TeamProjectLifecycleRow";
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
  canManageProjects,
  canReadAudit,
}: {
  workspaceId: string;
  workspaceName: string;
  canCreateProject: boolean;
  /** Server-derived `projects.manage` capability — UX visibility only; the archive/restore API re-authorizes every call. */
  canManageProjects: boolean;
  canReadAudit: boolean;
}) {
  const router = useRouter();
  // Phase PROJECT-UI-AR-I1 — two independent list instances: the active
  // section (unchanged behavior + New Project) and an Archived Projects
  // section so archived Team Projects are deliberately discoverable for
  // Restore. Both refetch from page one after any committed or
  // stale-detected lifecycle transition (`refreshSections`) — never an
  // optimistic row move, never a retained old updateTime token.
  const result = useTeamProjects({ workspaceId, status: "active" });
  const archived = useTeamProjects({ workspaceId, status: "archived" });
  const lifecycle = useTeamProjectLifecycle({ workspaceId });
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = result;
  const { resetAndReloadFromStart: reloadActiveFromStart } = result;
  const { resetAndReloadFromStart: reloadArchivedFromStart } = archived;
  const refreshSections = useCallback(() => {
    reloadActiveFromStart();
    reloadArchivedFromStart();
  }, [reloadActiveFromStart, reloadArchivedFromStart]);

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
            <TeamProjectLifecycleRow key={item.id} workspaceId={workspaceId} project={item} canManageProjects={canManageProjects} lifecycle={lifecycle} refreshSections={refreshSections} />
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
      <section className="mt-10" aria-labelledby="team-archived-projects-heading">
        <h2 id="team-archived-projects-heading" className="text-lg font-semibold text-cp-text">
          Archived Projects
        </h2>
        {archived.status === "loading" && <SectionLoadingRow label="Loading archived Projects…" />}
        {archived.status === "error" &&
          archived.initialErrorCode &&
          (() => {
            const copy = initialErrorCopy(archived.initialErrorCode);
            return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={archived.retryInitial} />;
          })()}
        {archived.status === "ready" && isDefinitiveEmptyTeamProjectsState({ status: archived.status, items: archived.items, hasMore: archived.hasMore }) && (
          <SectionEmptyBox lines={["No archived projects."]} />
        )}
        {archived.status === "ready" && archived.items.length > 0 && (
          <ul className="mt-4 space-y-2">
            {archived.items.map((item) => (
              <TeamProjectLifecycleRow key={item.id} workspaceId={workspaceId} project={item} canManageProjects={canManageProjects} lifecycle={lifecycle} refreshSections={refreshSections} />
            ))}
          </ul>
        )}
        {archived.status === "ready" &&
          archived.hasMore &&
          (() => {
            const copy = archived.loadMoreErrorCode ? loadMoreErrorCopy(archived.loadMoreErrorCode) : null;
            return (
              <SectionPagination
                loadingMore={archived.loadingMore}
                errorMessage={copy?.message ?? null}
                errorAction={copy?.action ?? null}
                onLoadMore={archived.loadMore}
                onReload={archived.resetAndReloadFromStart}
              />
            );
          })()}
      </section>
    </main>
  );
}
