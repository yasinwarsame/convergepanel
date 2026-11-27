"use client";

/**
 * ZCA L-4 — the client half of every Team Workspace page (D-4 #8–#14, #22–#25).
 *
 * Each page's server render is a neutral shell that names its `kind` and passes only URL params and
 * identity-free values (static env flags; the origin query, validated on the server). This component
 * loads `GET /api/workspaces/[workspaceId]` with the Firebase bearer and renders the page's existing
 * shell with EXACTLY the props its Server Component used to compute from the cookie's identity.
 *
 * Gate, in the pages' former order: access (every denial → 404 from the endpoint → `notFound()`) →
 * the kind's required capabilities (missing → the same `notFound()`, indistinguishable from
 * non-membership) → render.
 */
import { notFound } from "next/navigation";
import { useAuthorizedResource } from "@/hooks/useAuthorizedResource";
import { AuthorizedPageGate } from "@/components/workspace/AuthorizedPageGate";
import {
  parseTeamWorkspaceAccessResponse,
  type ClientWorkspaceCapability,
  type TeamWorkspaceAccessInfo,
} from "@/lib/workspaces/teamWorkspaceAccessTypes";
import type { TeamClaimOriginTarget } from "@/lib/workspaces/teamClaimOriginHandoff";
import WorkspaceOverviewShell from "@/components/workspace/WorkspaceOverviewShell";
import WorkspaceAuditLogShell from "@/components/workspace/WorkspaceAuditLogShell";
import TeamWorkspaceClaimsShell from "@/components/workspace/claims/TeamWorkspaceClaimsShell";
import TeamClaimDetailShell from "@/components/workspace/projects/TeamClaimDetailShell";
import TeamClaimComposerShell from "@/components/workspace/claims/TeamClaimComposerShell";
import WorkspaceMembersShell from "@/components/workspace/WorkspaceMembersShell";
import TeamProjectsShell from "@/components/workspace/projects/TeamProjectsShell";
import TeamResearchDetailShell from "@/components/workspace/projects/TeamResearchDetailShell";
import TeamWorkspaceVideosShell from "@/components/workspace/videos/TeamWorkspaceVideosShell";
import TeamVideoComposerShell from "@/components/workspace/videos/TeamVideoComposerShell";
import TeamVideoDetailShell from "@/components/workspace/videos/TeamVideoDetailShell";

export type TeamPageProps =
  | { kind: "overview"; workspaceId: string }
  | { kind: "audit"; workspaceId: string; showGovernanceSummary: boolean; showReviewIntegrityMetrics: boolean }
  | { kind: "claims"; workspaceId: string }
  | { kind: "claimDetail"; workspaceId: string; verificationId: string }
  | { kind: "claimNew"; workspaceId: string; originTarget: TeamClaimOriginTarget | null }
  | { kind: "members"; workspaceId: string }
  | { kind: "projects"; workspaceId: string }
  | { kind: "researchDetail"; workspaceId: string; runId: string }
  | { kind: "videos"; workspaceId: string }
  | { kind: "videoNew"; workspaceId: string }
  | { kind: "videoDetail"; workspaceId: string; verificationId: string };

/** Each kind's required capabilities — exactly the `notFound()` checks its Server Component made. */
export const TEAM_PAGE_REQUIRED_CAPABILITIES: Readonly<Record<TeamPageProps["kind"], readonly ClientWorkspaceCapability[]>> = {
  overview: [],
  audit: ["audit.read"],
  claims: ["research.read"],
  claimDetail: ["research.read"],
  claimNew: ["research.create"],
  members: ["members.read"],
  projects: ["projects.read"],
  researchDetail: ["research.read"],
  videos: ["research.read"],
  videoNew: ["research.create"],
  videoDetail: ["research.read"],
};

export default function TeamWorkspacePage(props: TeamPageProps) {
  const resource = useAuthorizedResource<TeamWorkspaceAccessInfo>(
    props.workspaceId ? `/api/workspaces/${encodeURIComponent(props.workspaceId)}` : null,
    parseTeamWorkspaceAccessResponse,
  );
  return <AuthorizedPageGate resource={resource}>{(access) => <TeamPageBody page={props} access={access} />}</AuthorizedPageGate>;
}

function TeamPageBody({ page, access }: { page: TeamPageProps; access: TeamWorkspaceAccessInfo }) {
  const has = (c: ClientWorkspaceCapability) => access.capabilities.includes(c);
  if (!TEAM_PAGE_REQUIRED_CAPABILITIES[page.kind].every(has)) notFound();
  const workspaceId = page.workspaceId;
  const workspaceName = access.workspace.name;

  switch (page.kind) {
    case "overview":
      return (
        <WorkspaceOverviewShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          canInvite={has("members.invite")}
          canManageInvitations={has("members.manage")}
          canCreateProject={has("projects.create")}
          canStartResearch={has("research.create") && has("research.organize")}
          canReadMembers={has("members.read")}
          canReadAudit={has("audit.read")}
        />
      );
    case "audit":
      return (
        <WorkspaceAuditLogShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          canReadMembers={has("members.read")}
          showGovernanceSummary={page.showGovernanceSummary}
          showReviewIntegrityMetrics={page.showReviewIntegrityMetrics}
        />
      );
    case "claims":
      return (
        <TeamWorkspaceClaimsShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          showMembers={has("members.read")}
          showAudit={has("audit.read")}
          canCreateClaim={has("research.create")}
        />
      );
    case "claimDetail":
      return (
        <TeamClaimDetailShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          verificationId={page.verificationId}
          project={null}
          showMembers={has("members.read")}
          showAudit={has("audit.read")}
        />
      );
    case "claimNew":
      return (
        <TeamClaimComposerShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          showMembers={has("members.read")}
          showAudit={has("audit.read")}
          project={null}
          originTarget={page.originTarget}
        />
      );
    case "members":
      return (
        <WorkspaceMembersShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          callerRole={access.role}
          canInvite={has("members.invite")}
          canManageInvitations={has("members.manage")}
          canReadMembers={has("members.read")}
          canReadAudit={has("audit.read")}
        />
      );
    case "projects":
      return (
        <TeamProjectsShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          canCreateProject={has("projects.create")}
          canManageProjects={has("projects.manage")}
          canReadMembers={has("members.read")}
          canReadAudit={has("audit.read")}
          assignmentUiEnabled={access.projectAssignmentUiEnabled}
        />
      );
    case "researchDetail":
      return (
        <TeamResearchDetailShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          runId={page.runId}
          project={null}
          showMembers={has("members.read")}
          showAudit={has("audit.read")}
          canVerifyClaim={has("research.create")}
          canCreateExport={has("exports.create")}
          reportReviewEnabled={access.reportReviewEnabled}
        />
      );
    case "videos":
      return (
        <TeamWorkspaceVideosShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          showMembers={has("members.read")}
          showAudit={has("audit.read")}
          canCreateVideo={has("research.create")}
        />
      );
    case "videoNew":
      return (
        <TeamVideoComposerShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          showMembers={has("members.read")}
          showAudit={has("audit.read")}
          project={null}
        />
      );
    case "videoDetail":
      return (
        <TeamVideoDetailShell
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          verificationId={page.verificationId}
          project={null}
          showMembers={has("members.read")}
          showAudit={has("audit.read")}
        />
      );
  }
}
