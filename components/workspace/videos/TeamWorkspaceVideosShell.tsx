"use client";

/**
 * TEAM-VERIFICATION-PARITY-R5-I2 — the canonical Workspace Videos list at
 * `/workspace/team/{W}/videos`, rendered after the Server Component has already
 * enforced identity, Team Workspace access and `research.read`.
 *
 * The All / Unfiled control selects the SERVER scope: "Unfiled" issues R5-I1's
 * own `?scope=unfiled` request. It never filters an "all" response client-side,
 * which would silently misreport the Workspace whenever the unfiled set spans
 * more than one page.
 *
 * I2 is discovery only: no create control, no uploader, no counts, no search,
 * no sort, no status filters. R5-I3 owns Team Video creation — every role,
 * including Owner, sees a read-only surface here.
 */

import { useState } from "react";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { TeamVideoListRow } from "@/components/workspace/videos/TeamVideoListRow";
import {
  useTeamVideoVerificationList,
  teamVideoListInitialErrorCopy,
  teamVideoListLoadMoreErrorCopy,
} from "@/hooks/useTeamVideoVerificationList";

export type TeamWorkspaceVideosShellProps = {
  workspaceId: string;
  /** Server-resolved, authorized Workspace display name. */
  workspaceName: string;
  /** Presentation hint from the server-resolved capability set (`audit.read`) — not authorization. */
  showAudit: boolean;
};

type VideoScope = "all" | "unfiled";

const FILTERS: { key: VideoScope; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unfiled", label: "Unfiled" },
];

export default function TeamWorkspaceVideosShell({ workspaceId, workspaceName, showAudit }: TeamWorkspaceVideosShellProps) {
  const [scope, setScope] = useState<VideoScope>("all");

  // Changing `scope` changes the hook's address, which drops the cursor, clears
  // the rows and aborts any in-flight request for the previous scope.
  const list = useTeamVideoVerificationList({ address: { kind: "workspace", workspaceId, scope } });

  const workspaceHref = `/workspace/team/${encodeURIComponent(workspaceId)}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <Breadcrumb
        className="mb-3"
        segments={[{ label: workspaceName, href: workspaceHref }, { label: "Videos" }]}
        mobileParent={{ label: workspaceName, href: workspaceHref }}
      />

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-cp-text">Videos</h1>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="videos" showAudit={showAudit} />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter videos">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={scope === f.key}
            onClick={() => setScope(f.key)}
            data-testid={`team-videos-filter-${f.key}`}
            className={
              scope === f.key
                ? "rounded-full border-2 border-cp-accent bg-cp-primary-soft px-3 py-1 text-sm font-semibold text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
                : "rounded-full border border-cp-border bg-cp-surface px-3 py-1 text-sm text-cp-muted transition-colors hover:border-cp-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      <section className="mt-6">
        {list.status === "loading" && <SectionLoadingRow label="Loading videos…" />}

        {list.status === "error" &&
          list.initialErrorCode !== null &&
          (() => {
            const copy = teamVideoListInitialErrorCopy(list.initialErrorCode);
            return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={list.retryInitial} />;
          })()}

        {list.status === "ready" && list.items.length === 0 && (
          <SectionEmptyBox lines={[scope === "unfiled" ? "No unfiled videos." : "No videos in this Workspace yet."]} />
        )}

        {list.status === "ready" && list.items.length > 0 && (
          <>
            <ul className="mt-2">
              {list.items.map((item) => (
                <TeamVideoListRow key={item.verificationId} workspaceId={workspaceId} item={item} showProject />
              ))}
            </ul>
            {(list.hasMore || list.loadMoreErrorCode !== null) && (
              <SectionPagination
                loadingMore={list.loadingMore}
                errorMessage={list.loadMoreErrorCode !== null ? teamVideoListLoadMoreErrorCopy(list.loadMoreErrorCode).message : null}
                errorAction={list.loadMoreErrorCode !== null ? teamVideoListLoadMoreErrorCopy(list.loadMoreErrorCode).action : null}
                onLoadMore={list.loadMore}
                onReload={list.resetAndReloadFromStart}
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}
