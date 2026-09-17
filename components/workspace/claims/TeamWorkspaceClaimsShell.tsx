"use client";

/**
 * TEAM-VERIFICATION-PARITY-R4-I2 — the canonical Workspace Claims list at
 * `/workspace/team/{W}/claims`, rendered after the Server Component has already
 * enforced identity, Team Workspace access and `research.read`.
 *
 * The All / Unfiled control selects the SERVER scope: "Unfiled" issues R3's own
 * `?scope=unfiled` request. It never filters an "all" response client-side,
 * which would silently misreport the Workspace whenever the unfiled set spans
 * more than one page.
 *
 * I2 is discovery only: no create control, no counts, no search, no sort, no
 * status/assignee filters. R4-I3 owns ordinary Claim creation.
 */

import { useState } from "react";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import { SectionEmptyBox, SectionInitialErrorBox, SectionLoadingRow, SectionPagination } from "@/components/projects/SectionState";
import { TeamClaimListRow } from "@/components/workspace/claims/TeamClaimListRow";
import {
  useTeamClaimVerificationList,
  teamClaimListInitialErrorCopy,
  teamClaimListLoadMoreErrorCopy,
} from "@/hooks/useTeamClaimVerificationList";

export type TeamWorkspaceClaimsShellProps = {
  workspaceId: string;
  /** Server-resolved, authorized Workspace display name. */
  workspaceName: string;
  /** Presentation hint from the server-resolved capability set (`audit.read`) — not authorization. */
  showAudit: boolean;
};

type ClaimScope = "all" | "unfiled";

const FILTERS: { key: ClaimScope; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unfiled", label: "Unfiled" },
];

export default function TeamWorkspaceClaimsShell({ workspaceId, workspaceName, showAudit }: TeamWorkspaceClaimsShellProps) {
  const [scope, setScope] = useState<ClaimScope>("all");

  // Changing `scope` changes the hook's address, which drops the cursor, clears
  // the rows and orphans any in-flight request for the previous scope.
  const list = useTeamClaimVerificationList({ address: { kind: "workspace", workspaceId, scope } });

  const workspaceHref = `/workspace/team/${encodeURIComponent(workspaceId)}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <Breadcrumb
        className="mb-3"
        segments={[{ label: workspaceName, href: workspaceHref }, { label: "Claims" }]}
        mobileParent={{ label: workspaceName, href: workspaceHref }}
      />

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-cp-text">Claims</h1>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="claims" showAudit={showAudit} />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter claims">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={scope === f.key}
            onClick={() => setScope(f.key)}
            data-testid={`team-claims-filter-${f.key}`}
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
        {list.status === "loading" && <SectionLoadingRow label="Loading claims…" />}

        {list.status === "error" &&
          list.initialErrorCode !== null &&
          (() => {
            const copy = teamClaimListInitialErrorCopy(list.initialErrorCode);
            return <SectionInitialErrorBox message={copy.message} retry={copy.retry} onRetry={list.retryInitial} />;
          })()}

        {list.status === "ready" && list.items.length === 0 && (
          <SectionEmptyBox lines={[scope === "unfiled" ? "No unfiled claims." : "No claims in this Workspace yet."]} />
        )}

        {list.status === "ready" && list.items.length > 0 && (
          <>
            <ul className="mt-2">
              {list.items.map((item) => (
                <TeamClaimListRow key={item.verificationId} workspaceId={workspaceId} item={item} showProject />
              ))}
            </ul>
            {(list.hasMore || list.loadMoreErrorCode !== null) && (
              <SectionPagination
                loadingMore={list.loadingMore}
                errorMessage={list.loadMoreErrorCode !== null ? teamClaimListLoadMoreErrorCopy(list.loadMoreErrorCode).message : null}
                errorAction={list.loadMoreErrorCode !== null ? teamClaimListLoadMoreErrorCopy(list.loadMoreErrorCode).action : null}
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
