/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — the authoritative "may this uid
 * read this Team Workspace's audit trail" resolver for
 * `GET /api/workspaces/{workspaceId}/audit-events`.
 *
 * Deliberately NOT the legacy `/api/governance/audit` authorization model
 * (`resolveGovernanceVisibleUserIdsCached()` — admin-email/reviewer-
 * assigner relationships, billing-plan gated). Per PHASE TEAM-GOV-R1's
 * architecture audit, that model has no Workspace-native concept at all.
 * This resolver imports nothing from `lib/governance/`.
 *
 * Structural mirror of `resolveTeamRunWorkspaceAccess()` — same admission
 * pre-filter (pure, zero I/O) before the one `resolveWorkspaceAccess()`
 * call, same Team-type guard. Kept as its own file rather than reusing
 * `resolveTeamRunWorkspaceAccess()` directly: that function's name/doc
 * comments are run-domain-specific, and this codebase's established
 * convention is one thin per-domain wrapper around the shared
 * `resolveWorkspaceAccess()` primitive (see also
 * `resolveTeamRunWorkspaceAccess.ts` itself, `resubmitWorkspaceReview.ts`,
 * etc.) rather than reusing another domain's differently-named wrapper.
 */

import "server-only";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "./teamWorkspaceTargetAdmission";
import { resolveWorkspaceAccess } from "./resolveWorkspaceAccess";
import type { WorkspaceMembershipV1 } from "./membershipTypes";
import type { WorkspaceCapability } from "./capabilities";
import type { TeamWorkspaceV1 } from "./types";

export type ResolveWorkspaceAuditAccessResult =
  | {
      granted: true;
      workspace: TeamWorkspaceV1;
      membership: WorkspaceMembershipV1;
      capabilities: readonly WorkspaceCapability[];
    }
  | {
      granted: false;
      reason:
        | "team_workspaces_disabled"
        | "workspace_not_found"
        | "workspace_malformed"
        | "lookup_failed"
        | "membership_not_found"
        | "membership_removed"
        | "membership_malformed"
        | "owner_integrity_violation"
        | "wrong_workspace_type";
    };

export async function resolveWorkspaceAuditAccess(args: { uid: string; workspaceId: string }): Promise<ResolveWorkspaceAuditAccessResult> {
  const admission = resolveTeamWorkspaceTargetAdmission({
    uid: args.uid,
    workspaceId: args.workspaceId,
    globalEnabled: TEAM_WORKSPACES_ENABLED,
    canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
    canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
  });
  if (!admission.enabled) {
    return { granted: false, reason: "team_workspaces_disabled" };
  }

  const access = await resolveWorkspaceAccess({ uid: args.uid, workspaceId: args.workspaceId });

  if (!access.granted) {
    if (access.reason === "not_owner") {
      // Personal-Workspace collision guard — see resolveTeamRunWorkspaceAccess.ts's
      // identical reasoning: "not_owner" only ever fires for a Personal
      // Workspace, which is conceptually "wrong type" from this resolver's view.
      return { granted: false, reason: "wrong_workspace_type" };
    }
    return { granted: false, reason: access.reason };
  }

  if (access.workspaceType !== "team") {
    return { granted: false, reason: "wrong_workspace_type" };
  }

  return {
    granted: true,
    workspace: access.workspace,
    membership: access.membership,
    capabilities: access.capabilities,
  };
}
