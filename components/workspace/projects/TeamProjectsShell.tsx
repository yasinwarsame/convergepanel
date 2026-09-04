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

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTeamProjects, isDefinitiveEmptyTeamProjectsState, type TeamProjectsListErrorCode, type TeamProjectSummary } from "@/hooks/useTeamProjects";
import { useTeamProjectLifecycle } from "@/hooks/useTeamProjectLifecycle";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { TeamNewProjectDialog } from "@/components/workspace/projects/TeamNewProjectDialog";
import { TeamProjectLifecycleRow, type TeamProjectLifecycleOutcome } from "@/components/workspace/projects/TeamProjectLifecycleRow";
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

  // Phase PROJECT-UI-AR-P3A-I1 — lifecycle feedback and focus are owned
  // HERE, never by a row or dialog: `refreshSections()` empties both lists
  // (`items.length > 0` gates), so any row-local message or focused
  // trigger unmounts in the same commit and is lost. The status region and
  // the two section headings below are always mounted, so they survive the
  // refetch and can carry the message / receive focus deterministically.
  //   committed archive/restore → success notice (role="status"), refetch,
  //     then focus the section the Project MOVED TO once both lists have
  //     finished reloading;
  //   stale/denied/gone (refresh-triggering) outcome → error notice
  //     (role="alert"), refetch, then focus the notice — never a
  //     success-style section jump;
  //   generic/network failure → stays local to the still-mounted row or
  //     dialog (no refetch happens), so nothing here changes.
  // `focusTarget` is consumed exactly once by the effect below and cleared,
  // so an unrelated later render can never refocus a section.
  const [lifecycleNotice, setLifecycleNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [focusTarget, setFocusTarget] = useState<"active" | "archived" | "notice" | null>(null);
  const activeHeadingRef = useRef<HTMLHeadingElement>(null);
  const archivedHeadingRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);

  const handleLifecycleAttemptStart = useCallback(() => {
    setLifecycleNotice(null);
  }, []);

  const handleLifecycleOutcome = useCallback(
    (outcome: TeamProjectLifecycleOutcome) => {
      // ORDER MATTERS: start the canonical refetch FIRST so both lists are
      // already "loading" by the time the focus intent is set. Otherwise a
      // synchronous (legacy-mode) render between `setFocusTarget` and
      // `refreshSections` would see both lists still "ready" and apply focus
      // before the refetch, defeating the "only after refresh" contract.
      refreshSections();
      if (outcome.kind === "committed") {
        setLifecycleNotice({ tone: "success", message: outcome.operation === "archive" ? `${outcome.projectName} was archived.` : `${outcome.projectName} was restored.` });
        setFocusTarget(outcome.operation === "archive" ? "archived" : "active");
      } else {
        setLifecycleNotice({ tone: "error", message: outcome.message });
        setFocusTarget("notice");
      }
    },
    [refreshSections]
  );

  // Focus moves only AFTER the canonical refetch has settled (neither list is
  // still loading) — the `refreshSections()` call above flips both lists to
  // "loading" in the same batch as `setFocusTarget`, so this effect waits for
  // the post-refresh render, then applies the intent exactly once.
  const listsSettled = result.status !== "loading" && archived.status !== "loading";
  useEffect(() => {
    if (!focusTarget || !listsSettled) return;
    const target = focusTarget === "active" ? activeHeadingRef.current : focusTarget === "archived" ? archivedHeadingRef.current : noticeRef.current;
    target?.focus();
    setFocusTarget(null);
  }, [focusTarget, listsSettled]);

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
        <h2 ref={activeHeadingRef} id="team-active-projects-heading" tabIndex={-1} className="text-lg font-semibold text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
          Projects
        </h2>
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

      {lifecycleNotice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={lifecycleNotice.tone === "error" ? "alert" : "status"}
          className={`mt-3 break-words rounded-lg border px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent ${lifecycleNotice.tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-cp-border bg-cp-raised text-cp-text"}`}
        >
          {lifecycleNotice.tone === "error" ? "Error: " : "Done: "}
          {lifecycleNotice.message}
        </div>
      )}

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
            <TeamProjectLifecycleRow key={item.id} workspaceId={workspaceId} project={item} canManageProjects={canManageProjects} lifecycle={lifecycle} onLifecycleAttemptStart={handleLifecycleAttemptStart} onLifecycleOutcome={handleLifecycleOutcome} />
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
        <h2 ref={archivedHeadingRef} id="team-archived-projects-heading" tabIndex={-1} className="text-lg font-semibold text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent">
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
              <TeamProjectLifecycleRow key={item.id} workspaceId={workspaceId} project={item} canManageProjects={canManageProjects} lifecycle={lifecycle} onLifecycleAttemptStart={handleLifecycleAttemptStart} onLifecycleOutcome={handleLifecycleOutcome} />
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
