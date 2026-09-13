"use client";

/**
 * ADD-TO-TEAM-PROJECT §T/§U — "Add to Team Project" chooser for ONE
 * Personal research run: pick a Team Workspace, then an ACTIVE Project in
 * it, read the fidelity disclosure, confirm. Dispatches exactly one
 * `POST .../research/snapshots` through `useTeamResearchSnapshot()`.
 *
 * Reuses the existing selection surfaces verbatim: `useWorkspaceList()`
 * (the viewer's active Team memberships — pages to completion, never a
 * truncated list) and `useTeamProjects({status: "active"})` (a
 * contradictory archived row still fails the page closed). Neither is an
 * authorization boundary: the dialog only OFFERS; the server decides,
 * inside its own transaction, and every denial is rendered honestly here.
 * The capability matrix is deliberately NOT duplicated in this component —
 * a Reviewer/Viewer who picks a Workspace simply receives the server's
 * `insufficient_capability` and clear copy.
 *
 * Project is MANDATORY. There is no "Unfiled" choice: the Team UI has no
 * detail route for an Unfiled run, so an Unfiled snapshot would be
 * unreachable.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { ProjectDialogFrame } from "@/components/projects/ProjectDialogFrame";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { useWorkspaceList } from "@/hooks/useWorkspaceList";
import { isDefinitiveEmptyTeamProjectsState, useTeamProjects, type TeamProjectsListErrorCode } from "@/hooks/useTeamProjects";
import type { UseTeamResearchSnapshotResult } from "@/hooks/useTeamResearchSnapshot";
import type { TeamResearchSnapshotDto } from "@/lib/workspaces/teamResearchSnapshotResponse";
import { shouldReloadProjectsAfterSnapshotError, teamResearchSnapshotErrorCopy } from "@/components/workspace/teamResearchSnapshotErrorCopy";

/**
 * §U — shown before confirmation, every time. Says what happens (a copy),
 * what does not (the Personal report is unchanged), and what Team members
 * currently see. Never implies the report moves, pixel-identical Team
 * presentation, or that governance carries over.
 */
export const ADD_TO_TEAM_FIDELITY_DISCLOSURE =
  "This creates a Team copy of this research. Your Personal report will stay unchanged. Team members may currently see the underlying model responses rather than the full Deep Research layout.";

function projectsInitialErrorCopy(code: TeamProjectsListErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view this Workspace's projects.", retry: false };
    case "insufficient_capability":
      return { message: "You don't have permission to view projects in this Workspace.", retry: false };
    case "team_workspace_not_found":
      return { message: "This Workspace could not be found.", retry: false };
    default:
      return { message: "Couldn't load this Workspace's projects right now. This is usually temporary.", retry: true };
  }
}

function projectsLoadMoreErrorCopy(code: TeamProjectsListErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more projects. Please try again.", action: "retry" };
}

const optionClass = (selected: boolean) =>
  `w-full rounded-lg border px-3 py-2 text-left text-sm break-words ${selected ? "border-cp-accent bg-cp-primary-soft text-cp-text" : "border-cp-border text-cp-text hover:bg-cp-raised"}`;

/**
 * Mounted only once a Workspace is chosen — `useTeamProjects` needs a
 * concrete `workspaceId`, and remounting on a Workspace change gives a
 * fresh, independent list instance (never a stale page from the previous
 * Workspace).
 */
function TeamProjectStep({
  workspaceId,
  selectedProjectId,
  onSelect,
  reloadToken,
}: {
  workspaceId: string;
  selectedProjectId: string | null;
  onSelect: (projectId: string, projectName: string) => void;
  reloadToken: number;
}) {
  const active = useTeamProjects({ workspaceId, status: "active" });
  // A stale-Project denial bumps `reloadToken`; the list is refetched from
  // the server before any further attempt. Ref-routed so the effect keys on
  // the token alone, never on the hook's callback identity.
  const reloadRef = useRef(active.resetAndReloadFromStart);
  reloadRef.current = active.resetAndReloadFromStart;
  useEffect(() => {
    if (reloadToken > 0) reloadRef.current();
  }, [reloadToken]);

  return (
    <div className="mt-4">
      <p className="text-sm font-medium text-cp-text">2. Choose an active Project</p>
      {active.status === "loading" && <SectionLoadingRow label="Loading active projects…" />}

      {active.status === "error" &&
        active.initialErrorCode &&
        (() => {
          const copy = projectsInitialErrorCopy(active.initialErrorCode);
          return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={active.retryInitial} />;
        })()}

      {active.status === "ready" && isDefinitiveEmptyTeamProjectsState(active) && (
        <SectionEmptyBox lines={["This Workspace has no active Projects.", "Research can only be added to an active Project."]} />
      )}

      {active.status === "ready" && active.items.length > 0 && (
        <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto" role="listbox" aria-label="Active projects">
          {active.items.map((project) => {
            const selected = project.id === selectedProjectId;
            return (
              <li key={project.id}>
                <button type="button" role="option" aria-selected={selected} onClick={() => onSelect(project.id, project.name)} className={optionClass(selected)}>
                  {project.name}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {active.status === "ready" &&
        active.hasMore &&
        (() => {
          const copy = active.loadMoreErrorCode ? projectsLoadMoreErrorCopy(active.loadMoreErrorCode) : null;
          return (
            <SectionPagination
              loadingMore={active.loadingMore}
              errorMessage={copy?.message ?? null}
              errorAction={copy?.action ?? null}
              onLoadMore={active.loadMore}
              onReload={active.resetAndReloadFromStart}
            />
          );
        })()}
    </div>
  );
}

export function AddToTeamProjectDialog({
  sourceRunId,
  triggerRef,
  onClose,
  snapshot,
  onCreated,
}: {
  sourceRunId: string;
  triggerRef: RefObject<HTMLElement>;
  onClose: () => void;
  snapshot: UseTeamResearchSnapshotResult;
  /** Called for BOTH a fresh creation and an idempotent `already_exists` — either way the destination now exists. */
  onCreated: (result: TeamResearchSnapshotDto) => void;
}) {
  const workspaces = useWorkspaceList();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectsReloadToken, setProjectsReloadToken] = useState(0);
  const submitting = snapshot.isSourceBusy(sourceRunId);
  const canSubmit = !submitting && selectedWorkspaceId !== null && selectedProject !== null;

  function chooseWorkspace(workspaceId: string) {
    if (workspaceId === selectedWorkspaceId) return;
    setSelectedWorkspaceId(workspaceId);
    // A Project belongs to exactly one Workspace — changing the Workspace
    // always clears the Project choice.
    setSelectedProject(null);
    setError(null);
  }

  async function handleConfirm(requestClose: () => void) {
    if (!canSubmit || selectedWorkspaceId === null || selectedProject === null) return;
    setError(null);
    const result = await snapshot.create({ sourceRunId, workspaceId: selectedWorkspaceId, projectId: selectedProject.id });
    if (result.status === "ok") {
      requestClose();
      onCreated(result.snapshot);
      return;
    }
    setError(teamResearchSnapshotErrorCopy(result.errorCode));
    if (shouldReloadProjectsAfterSnapshotError(result.errorCode)) {
      setSelectedProject(null);
      setProjectsReloadToken((n) => n + 1);
    }
  }

  const workspaceListSettled = workspaces.status === "ready" || workspaces.status === "partial_error";

  return (
    <ProjectDialogFrame title="Add to Team Project" triggerRef={triggerRef} onClose={onClose}>
      {({ requestClose }) => (
        <div className="mt-4">
          <p className="rounded-lg border border-cp-border bg-cp-raised px-3 py-2 text-sm text-cp-muted">{ADD_TO_TEAM_FIDELITY_DISCLOSURE}</p>

          <div className="mt-4">
            <p className="text-sm font-medium text-cp-text">1. Choose a Team Workspace</p>
            {(workspaces.status === "idle" || workspaces.status === "loading") && <SectionLoadingRow label="Loading your Team Workspaces…" />}
            {workspaces.status === "error" && (
              <SectionInitialErrorBox message="Couldn't load your Team Workspaces right now. This is usually temporary." retry onRetry={workspaces.retry} />
            )}
            {workspaceListSettled && workspaces.items.length === 0 && (
              <SectionEmptyBox lines={["You're not a member of any Team Workspace yet."]} />
            )}
            {workspaceListSettled && workspaces.items.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto" role="listbox" aria-label="Team Workspaces">
                {workspaces.items.map((ws) => {
                  const selected = ws.workspaceId === selectedWorkspaceId;
                  return (
                    <li key={ws.workspaceId}>
                      <button type="button" role="option" aria-selected={selected} onClick={() => chooseWorkspace(ws.workspaceId)} className={optionClass(selected)}>
                        {ws.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {workspaces.status === "partial_error" && (
              <p role="alert" className="mt-2 text-xs text-cp-muted">
                Some of your Workspaces may be missing from this list.{" "}
                <button type="button" onClick={workspaces.retry} className="font-medium text-cp-accent hover:underline">
                  Reload
                </button>
              </p>
            )}
          </div>

          {selectedWorkspaceId !== null && (
            <TeamProjectStep
              key={selectedWorkspaceId}
              workspaceId={selectedWorkspaceId}
              selectedProjectId={selectedProject?.id ?? null}
              onSelect={(id, name) => {
                setSelectedProject({ id, name });
                setError(null);
              }}
              reloadToken={projectsReloadToken}
            />
          )}

          {error && (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={requestClose} className="rounded-lg border border-cp-border px-4 py-2 text-sm font-medium text-cp-text hover:bg-cp-raised">
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => handleConfirm(requestClose)}
              className="rounded-lg bg-cp-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cp-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Adding…" : "Add to Team Project"}
            </button>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}
