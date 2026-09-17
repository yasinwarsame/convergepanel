"use client";

/**
 * Team Projects UI, Phase 12A.2 — the
 * `/workspace/team/{workspaceId}/projects/{projectId}` client shell.
 * `project` ({id, name, status}) is resolved once, server-side, at the
 * page's own authorization gate (same pattern as Personal's
 * `ProjectDetailShell.tsx` obtaining `project` from
 * `resolveProjectForOwner()`) — no live resync while this page is open.
 *
 * Research is rendered READ-ONLY: no Move/Remove/Assign actions (PHASE
 * 12A.2 Section U/V — Team run→project (re)association UI is explicitly
 * deferred). PHASE 12A.4 — each row is now a real link, but it still never
 * links into `app/page.tsx` (the frozen architecture boundary — Personal
 * composer stays Personal-only); it links only to the new, still-Team-only
 * `/workspace/team/{workspaceId}/projects/{projectId}/research/{runId}`
 * detail route.
 *
 * PHASE 12A.3 — "Start Research" is now real: a PERMANENT capability
 * (mirrors "New Project"/"Invite Member"'s own established permanence),
 * visible for an authorized caller regardless of existing run count,
 * activation state, or how many previous runs this Project already has.
 * Rendered only when `canStartResearch && project.status === "active"` —
 * mirrors "New Project"'s own simpler hidden-not-disabled precedent
 * (`canCreateProject`) rather than the seat-limit's visible-but-disabled
 * pattern, since an archived Project or a lacking-capability caller has no
 * partial "start research" affordance that would ever succeed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import { AssigneeChips, type AssigneeChipItem } from "@/components/workspace/projects/AssigneeChips";
import { RunAssigneeDialog } from "@/components/workspace/projects/RunAssigneeDialog";
import { useTeamRunAssignee } from "@/hooks/useTeamRunAssignee";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import { teamResearchDetailHref } from "@/lib/workspaces/teamResearchDetailHref";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import {
  useTeamClaimVerificationList,
  teamClaimListInitialErrorCopy,
  teamClaimListLoadMoreErrorCopy,
} from "@/hooks/useTeamClaimVerificationList";
import {
  useTeamProjectRuns,
  isDefinitiveEmptyTeamProjectRunsState,
  type TeamProjectRunsErrorCode,
  type TeamProjectRunSummary,
} from "@/hooks/useTeamProjectRuns";

export interface TeamProjectDetailMeta {
  id: string;
  name: string;
  status: "active" | "archived";
  /** Project/Research Assignment (D9) — READ-ONLY here; resolved server-side by the page. No editor and no OCC token on this surface. Absent ⇒ no chips. */
  assignees?: AssigneeChipItem[];
}

function detailInitialErrorCopy(code: TeamProjectRunsErrorCode): { message: string; retry: boolean } {
  switch (code) {
    case "unauthorized":
    case "auth_error":
      return { message: "Please sign in again to view this project.", retry: false };
    default:
      return { message: "Couldn't load this project's research right now. This is usually temporary.", retry: true };
  }
}

function detailLoadMoreErrorCopy(code: TeamProjectRunsErrorCode): { message: string; action: "retry" | "reload" } {
  if (code === "invalid_cursor") {
    return { message: "This page link is no longer valid.", action: "reload" };
  }
  return { message: "Couldn't load more research. Please try again.", action: "retry" };
}

/** Pure, exact mirror of `workspaceRunStatusLine()`'s composition (`components/workspace/WorkspaceRunCard.tsx`) — reused as a formula rather than the card component itself, since that component's row is a `next/link` into `app/page.tsx`, which this read-only Team surface must never do. */
function teamRunStatusLine(item: Pick<TeamProjectRunSummary, "status" | "modelsOk" | "modelsTotal" | "synthesisConsensusScore">): string {
  let base: string;
  if (item.modelsOk != null && item.modelsTotal != null) {
    base = `${item.modelsOk}/${item.modelsTotal} model responses`;
    if (item.status && item.status !== "complete") {
      base += ` · ${item.status}`;
    }
  } else if (item.status === "error") {
    base = "Run ended with an error";
  } else {
    base = "Research panel";
  }
  if (item.synthesisConsensusScore != null) {
    base += ` · Synthesis ${item.synthesisConsensusScore}/100`;
  }
  return base;
}

export default function TeamProjectDetailShell({
  workspaceId,
  workspaceName,
  project,
  canReadAudit,
  canStartResearch,
  canAssignResearch = false,
  assignmentUiEnabled = false,
  canReadClaims = false,
}: {
  workspaceId: string;
  workspaceName: string;
  project: TeamProjectDetailMeta;
  canReadAudit: boolean;
  canStartResearch: boolean;
  /** Project/Research Assignment — server-derived `research.organize` capability; UX visibility of the per-row "Assign" action only. The assignee API re-authorizes every call. */
  canAssignResearch?: boolean;
  /** Project/Research Assignment (D10) — server-derived rollout presentation hint (page-computed). */
  assignmentUiEnabled?: boolean;
  /** R4-I2 — server-derived `research.read`; gates only whether the read-only Claims section requests anything. The R3 list endpoint remains authoritative. */
  canReadClaims?: boolean;
}) {
  // Project/Research Assignment — `?assignee=me` VIEW filter on the research list.
  const [assignedToMe, setAssignedToMe] = useState(false);
  const assigneeFilter = assignmentUiEnabled && assignedToMe ? "me" : null;
  const runs = useTeamProjectRuns({ workspaceId, projectId: project.id, assigneeFilter });
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = runs;
  const assignment = useTeamRunAssignee({ workspaceId });
  /*
    R4-I2 — the read-only Claims section. Its state is entirely independent of
    the research list: a Claim error, retry or load-more never resets, refetches
    or hides research, and a research refetch (e.g. after an assignment) never
    resets the Claim list. `enabled` keeps it from issuing any request at all
    when the viewer lacks `research.read`.
  */
  const claims = useTeamClaimVerificationList({ address: { kind: "project", workspaceId, projectId: project.id }, enabled: canReadClaims });
  const showAssign = assignmentUiEnabled && canAssignResearch && project.status === "active";

  // Assignment feedback + focus are owned here (the refetch unmounts rows).
  const [assignDialogRun, setAssignDialogRun] = useState<{ id: string; question: string } | null>(null);
  const [assignNotice, setAssignNotice] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const assignTriggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const assignTriggerRef = useRef<HTMLElement | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [focusNotice, setFocusNotice] = useState(false);
  useEffect(() => {
    if (!focusNotice || status === "loading") return;
    noticeRef.current?.focus();
    setFocusNotice(false);
  }, [focusNotice, status]);
  const openAssign = useCallback((run: { id: string; question: string }) => {
    setAssignNotice(null);
    assignTriggerRef.current = assignTriggerRefs.current.get(run.id) ?? null;
    setAssignDialogRun(run);
  }, []);

  const startResearchHref = `/workspace/team/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(project.id)}/research/new`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <Breadcrumb
        className="mb-3"
        segments={[
          { label: workspaceName, href: `/workspace/team/${encodeURIComponent(workspaceId)}` },
          { label: "Projects", href: `/workspace/team/${encodeURIComponent(workspaceId)}/projects` },
          { label: project.name },
        ]}
        mobileParent={{ label: "Projects", href: `/workspace/team/${encodeURIComponent(workspaceId)}/projects` }}
      />

      {/*
        Phase 11B.3-C1 — page composition is the SAME on all seven Team Workspace
        surfaces: Breadcrumb -> page heading -> WorkspaceNav -> content.
      */}
      {/*
        The Project name is the page's primary heading (h2 -> h1) now that the
        Workspace-name h1 is gone. The whole header row moves above WorkspaceNav
        as one unit, so the status badge and Start Research keep their existing
        placement relative to the heading.
      */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-cp-text break-words">{project.name}</h1>
          <span className="rounded-full border border-cp-border px-2.5 py-0.5 text-xs font-medium text-cp-muted">
            {project.status === "active" ? "Active" : "Archived"}
          </span>
          {project.assignees && project.assignees.length > 0 && <AssigneeChips assignees={project.assignees} />}
        </div>
        {canStartResearch && project.status === "active" && (
          <Link
            href={startResearchHref}
            className="inline-flex items-center justify-center rounded-lg bg-cp-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
          >
            Start Research
          </Link>
        )}
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="projects" showAudit={canReadAudit} />

      {assignmentUiEnabled && (
        <label className="mt-4 inline-flex items-center gap-2 text-sm text-cp-muted">
          <input type="checkbox" checked={assignedToMe} onChange={(e) => setAssignedToMe(e.target.checked)} className="h-4 w-4" />
          Assigned to me
        </label>
      )}

      {assignNotice && (
        <div
          ref={noticeRef}
          tabIndex={-1}
          role={assignNotice.tone === "error" ? "alert" : "status"}
          className={`mt-3 break-words rounded-lg border px-3 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent ${assignNotice.tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-cp-border bg-cp-raised text-cp-text"}`}
        >
          {assignNotice.tone === "error" ? "Error: " : "Done: "}
          {assignNotice.message}
        </div>
      )}

      {assignDialogRun && showAssign && (
        <RunAssigneeDialog
          workspaceId={workspaceId}
          run={assignDialogRun}
          triggerRef={assignTriggerRef}
          onClose={() => setAssignDialogRun(null)}
          assignment={assignment}
          onSaved={() => {
            setAssignDialogRun(null);
            resetAndReloadFromStart();
            setAssignNotice({ tone: "success", message: "Research assignment updated." });
            setFocusNotice(true);
          }}
          onStaleOrGone={(message) => {
            setAssignDialogRun(null);
            resetAndReloadFromStart();
            setAssignNotice({ tone: "error", message });
            setFocusNotice(true);
          }}
        />
      )}

      <section className="mt-6">
        {status === "loading" && <SectionLoadingRow label="Loading research…" />}

        {status === "error" &&
          initialErrorCode &&
          (() => {
            const copy = detailInitialErrorCopy(initialErrorCode);
            return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={retryInitial} />;
          })()}

        {status === "ready" &&
          isDefinitiveEmptyTeamProjectRunsState({ status, items, hasMore }) &&
          (assigneeFilter === "me" ? (
            <SectionEmptyBox lines={["No research in this project is assigned to you."]} />
          ) : canStartResearch && project.status === "active" ? (
            <SectionEmptyBox lines={["No research in this project yet.", "Start research to run this Project's first panel."]} />
          ) : (
            <SectionEmptyBox lines={["No research in this project yet."]} />
          ))}

        {status === "ready" && items.length > 0 && (
          <ul className="mt-4 space-y-2">
            {items.map((item) => (
              <li key={item.id} className="flex items-stretch gap-2">
                <Link
                  href={teamResearchDetailHref({ workspaceId, projectId: project.id, runId: item.id })}
                  className="block min-w-0 flex-1 rounded-xl border-2 border-cp-border bg-cp-raised px-3 py-3 hover:border-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-cp-faint">{new Date(item.at).toLocaleString()}</span>
                      <span className="mt-1 block text-sm font-medium text-cp-text line-clamp-2">{item.question}</span>
                      <span className="mt-1 block text-xs text-cp-muted">{teamRunStatusLine(item)}</span>
                      {item.assignee !== null && (
                        <span className="mt-1 block text-xs text-cp-muted" data-testid="team-run-row-assignee">
                          Assigned to <span className={item.assignee.state === "stale" ? "line-through text-cp-faint" : "font-medium text-cp-text"}>{item.assignee.displayName}</span>
                          {item.assignee.state === "stale" ? " (no longer eligible)" : null}
                        </span>
                      )}
                    </span>
                    <GovernanceChip status={item.governanceStatus} />
                  </div>
                </Link>
                {/* Sibling action slot — NEVER nested inside the row link (the WorkspaceRunCard pattern). */}
                {showAssign && (
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) assignTriggerRefs.current.set(item.id, el);
                      else assignTriggerRefs.current.delete(item.id);
                    }}
                    disabled={assignment.isRunBusy(item.id)}
                    onClick={() => openAssign({ id: item.id, question: item.question })}
                    className="self-center rounded-lg border border-cp-border px-3 py-1.5 text-xs font-medium text-cp-text transition-colors hover:bg-cp-surface disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Assign
                  </button>
                )}
              </li>
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

      {canReadClaims && (
        <section className="mt-10" data-testid="team-project-claims-section">
          <h2 className="text-lg font-semibold text-cp-text">Claims</h2>

          {claims.status === "loading" && <SectionLoadingRow label="Loading claims…" />}

          {claims.status === "error" &&
            claims.initialErrorCode !== null &&
            (() => {
              const copy = teamClaimListInitialErrorCopy(claims.initialErrorCode);
              return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={claims.retryInitial} />;
            })()}

          {claims.status === "ready" && claims.items.length === 0 && <SectionEmptyBox lines={["No claims in this project yet."]} />}

          {claims.status === "ready" && claims.items.length > 0 && (
            <>
              <ul className="mt-2">
                {claims.items.map((item) => (
                  <TeamClaimListRow key={item.verificationId} workspaceId={workspaceId} item={item} showProject={false} />
                ))}
              </ul>
              {(claims.hasMore || claims.loadMoreErrorCode !== null) && (
                <SectionPagination
                  loadingMore={claims.loadingMore}
                  errorMessage={claims.loadMoreErrorCode !== null ? teamClaimListLoadMoreErrorCopy(claims.loadMoreErrorCode).message : null}
                  errorAction={claims.loadMoreErrorCode !== null ? teamClaimListLoadMoreErrorCopy(claims.loadMoreErrorCode).action : null}
                  onLoadMore={claims.loadMore}
                  onReload={claims.resetAndReloadFromStart}
                />
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
