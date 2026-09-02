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
 * deferred; there is no Team research composer yet for any of that to be
 * meaningful against), and each row is plain text, never a link into
 * `app/page.tsx` (the frozen architecture boundary — Personal composer
 * stays Personal-only) or any not-yet-existing Team run detail route.
 * "Start research" is intentionally absent here — PHASE 12A.3 is where
 * that becomes real.
 */

import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
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
}: {
  workspaceId: string;
  workspaceName: string;
  project: TeamProjectDetailMeta;
  canReadAudit: boolean;
}) {
  const runs = useTeamProjectRuns({ workspaceId, projectId: project.id });
  const { items, hasMore, status, initialErrorCode, loadingMore, loadMoreErrorCode, loadMore, retryInitial, resetAndReloadFromStart } = runs;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">{workspaceName}</h1>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="projects" showAudit={canReadAudit} />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold text-cp-text break-words">{project.name}</h2>
        <span className="rounded-full border border-cp-border px-2.5 py-0.5 text-xs font-medium text-cp-muted">
          {project.status === "active" ? "Active" : "Archived"}
        </span>
      </div>

      <section className="mt-6">
        {status === "loading" && <SectionLoadingRow label="Loading research…" />}

        {status === "error" &&
          initialErrorCode &&
          (() => {
            const copy = detailInitialErrorCopy(initialErrorCode);
            return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={retryInitial} />;
          })()}

        {status === "ready" && isDefinitiveEmptyTeamProjectRunsState({ status, items, hasMore }) && (
          <SectionEmptyBox
            lines={[
              "No research in this project yet.",
              "Team research will be started from this project once the dedicated Team research flow is available.",
            ]}
          />
        )}

        {status === "ready" && items.length > 0 && (
          <ul className="mt-4 space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl border-2 border-cp-border bg-cp-raised px-3 py-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 flex-1">
                    <span className="text-xs font-medium text-cp-faint">{new Date(item.at).toLocaleString()}</span>
                    <span className="mt-1 block text-sm font-medium text-cp-text line-clamp-2">{item.question}</span>
                    <span className="mt-1 block text-xs text-cp-muted">{teamRunStatusLine(item)}</span>
                  </span>
                  <GovernanceChip status={item.governanceStatus} />
                </div>
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
    </main>
  );
}
