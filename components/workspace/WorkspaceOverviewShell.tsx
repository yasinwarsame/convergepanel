"use client";

/**
 * Team Workspace Activation Flow, Phase 12A.1 — the
 * `/workspace/team/{workspaceId}` client shell, i.e. the canonical
 * Workspace home page. Mirrors the existing Members/Audit shells'
 * pattern exactly: the Server Component page only resolves
 * identity/access and passes static props; this shell independently
 * fetches whatever list data it needs client-side.
 *
 * Fetches exactly the signals `deriveWorkspaceActivationState()` needs —
 * member list (always readable, `members.read` is held by every role),
 * pending invitations (only if `canManageInvitations`, mirroring
 * `WorkspaceMembersShell.loadInvitations()`'s identical guard — a Viewer
 * who can't list invitations still gets a correct `teamInvited` answer
 * from `hasNonOwnerMember` alone), and cheap `?limit=1` existence checks
 * against Projects/runs (both readable by every role via
 * `projects.read`/`research.read`). Four requests in parallel, never a
 * per-item loop — no N+1.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import {
  fetchWorkspaceMembers,
  fetchPendingInvitations,
  fetchTeamProjectsExistence,
  fetchTeamResearchExistence,
} from "@/lib/client/workspaceTeamClient";
import { deriveWorkspaceActivationState, type WorkspaceActivationState } from "@/lib/workspaces/activationState";
import WorkspaceNav from "@/components/workspace/WorkspaceNav";
import { Breadcrumb } from "@/components/shared/Breadcrumb";
import WorkspaceActivationPanel from "@/components/workspace/WorkspaceActivationPanel";
import ReviewErrorState from "@/components/teamGovernance/ReviewErrorState";

type LoadState = { status: "loading" } | { status: "error" } | { status: "ready"; activation: WorkspaceActivationState };

export default function WorkspaceOverviewShell({
  workspaceId,
  workspaceName,
  canInvite,
  canManageInvitations,
  canCreateProject,
  canStartResearch,
  canReadAudit,
}: {
  workspaceId: string;
  workspaceName: string;
  canInvite: boolean;
  canManageInvitations: boolean;
  canCreateProject: boolean;
  canStartResearch: boolean;
  canReadAudit: boolean;
}) {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const requestId = useRef(0);

  const load = useCallback(() => {
    if (!authReady) return;
    const thisRequest = ++requestId.current;
    setState({ status: "loading" });
    (async () => {
      const [membersResult, invitationsResult, projectsResult, researchResult] = await Promise.all([
        fetchWorkspaceMembers({ user, authReady, workspaceId }),
        canManageInvitations ? fetchPendingInvitations({ user, authReady, workspaceId }) : Promise.resolve({ status: "ok" as const, invitations: [] }),
        fetchTeamProjectsExistence({ user, authReady, workspaceId }),
        fetchTeamResearchExistence({ user, authReady, workspaceId }),
      ]);
      if (requestId.current !== thisRequest) return;
      if (membersResult.status !== "ok" || projectsResult.status !== "ok" || researchResult.status !== "ok") {
        setState({ status: "error" });
        return;
      }
      // A failed invitations fetch degrades gracefully rather than
      // failing the whole panel — `teamInvited` can still be answered
      // correctly from `hasNonOwnerMember` alone (see module doc).
      // Phase 12A.1C1 — an invitation whose status is still "pending" but
      // whose deadline has passed must NOT count toward "Invite your
      // team": it is no longer a usable invitation. Reuses the server's
      // own canonical `isExpired` field (already computed and already
      // displayed by WorkspaceMembersShell as "· Expired") rather than
      // re-deriving expiration from `expiresAt` a second time.
      const hasPendingInvitation = invitationsResult.status === "ok" && invitationsResult.invitations.some((inv) => !inv.isExpired);
      setState({
        status: "ready",
        activation: deriveWorkspaceActivationState({
          hasNonOwnerMember: membersResult.members.some((m) => !m.isCanonicalOwner),
          hasPendingInvitation,
          hasProject: projectsResult.hasAny,
          hasResearch: researchResult.hasAny,
        }),
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, user?.uid, workspaceId, canManageInvitations]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      {/*
        Phase 11B.3 — the Workspace's identity now lives in the breadcrumb, so
        the page heading is free to name the page itself ("Overview") instead of
        repeating the Workspace name the breadcrumb already shows.

        The Workspace segment links to this very route. That is deliberate and
        frozen: one predictable hierarchy across all seven Team surfaces beats a
        special case here, and only the final "Overview" segment carries
        `aria-current="page"`, so exactly one item is announced as current.

        No `mobileParent`: the only candidate parent is `/workspace/team`, which
        is gated by `resolveTeamWorkspacesMode()` while this page is gated only
        by `resolveWorkspaceAccess()`. A member outside the rollout can legitimately
        reach this Workspace but would hit notFound() at the chooser, so shipping
        that link would ship a predictably broken affordance.
      */}
      <Breadcrumb
        className="mb-3"
        segments={[
          { label: workspaceName, href: `/workspace/team/${encodeURIComponent(workspaceId)}` },
          { label: "Overview" },
        ]}
      />

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-cp-text">Overview</h1>
      </div>

      <WorkspaceNav workspaceId={workspaceId} active="overview" showAudit={canReadAudit} />

      {state.status === "loading" && (
        <div role="status" className="rounded-xl border border-cp-border bg-cp-surface px-6 py-10 text-center text-sm text-cp-muted shadow-sm">
          Loading Workspace…
        </div>
      )}

      {state.status === "error" && <ReviewErrorState message="We couldn't load this Workspace's setup status. Try again." onRetry={load} />}

      {state.status === "ready" && (
        <WorkspaceActivationPanel
          workspaceId={workspaceId}
          activation={state.activation}
          canInvite={canInvite}
          canCreateProject={canCreateProject}
          canStartResearch={canStartResearch}
        />
      )}

      {state.status === "ready" && state.activation.isFullyActive && (
        <p className="text-sm text-cp-muted">This Workspace is active. Use the navigation above to manage members and review activity.</p>
      )}
    </main>
  );
}
