/**
 * Team Run Lists, Phase 8C-B2 — the authoritative "may this uid read runs
 * in this Team Workspace" resolver for every B2 route. Replaces the
 * discarded `resolveExplicitTeamRunBinding()` draft from the original
 * 8C-B.0 audit — that design read a Workspace document before rollout
 * was ever checked, which this resolver's whole existence is designed to
 * prevent (Phase 8C-B.0.1 hardening).
 *
 * Ordering is security-critical and mandatory:
 *   1. Target-Workspace admission (Phase 10B.3.1: `resolveTeamWorkspaceTargetAdmission()`,
 *      evaluated against the caller-supplied `args.workspaceId` directly)
 *      — pure, zero I/O. A caller/target pair admitted by NEITHER global,
 *      nor uid-canary, nor this specific Workspace's own canary
 *      admission is denied with ZERO Firestore reads, before
 *      `resolveWorkspaceAccess()` (which would otherwise call
 *      `getWorkspace()` unconditionally) is ever invoked. This is a
 *      pre-filter only, never a substitute for the real authorization
 *      below — `resolveWorkspaceAccess()` independently re-evaluates
 *      target admission itself (against the canonical `workspace.id` it
 *      loads), so this step can never grant anything on its own; it only
 *      ever narrows which requests bother reading Firestore at all. Prior
 *      to Phase 10B.3.1 this step used the USER-scoped
 *      `resolveTeamWorkspacesMode()`, which would have denied a
 *      legitimate Workspace-canary-only caller before step 2 ever got a
 *      chance to admit them — replaced, not merely relocated.
 *   2. Only after that pre-filter: the existing, UNMODIFIED
 *      `resolveWorkspaceAccess()` is called exactly once — never a
 *      separate `getWorkspace()`, never a reimplementation of its
 *      Workspace/membership/owner-integrity logic.
 *   3. `workspaceType !== "team"` is rejected explicitly. This closes the
 *      Personal-Workspace collision: a run stored with
 *      `workspaceId: "personal-B"` could otherwise let requester B —
 *      who genuinely owns `personal-B` — be granted `resolveWorkspaceAccess`
 *      access to it as though it were a shared Team resource, purely
 *      because B is that Workspace's real Personal owner. Rejecting any
 *      non-"team" grant here means this resolver can only ever produce
 *      `granted: true` for a genuine Team Workspace.
 *
 * No creator/ownership fallback, no old-Team (`isTeamAdmin()`/
 * `memberRole()`/`loadUserAndTeam()`-based) authorization path, no
 * Personal fallback, no legacy fallback — Workspace membership +
 * capability evaluation only, exactly mirroring `resolveWorkspaceAccess()`
 * itself.
 */

import "server-only";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "./teamWorkspaceTargetAdmission";
import { resolveWorkspaceAccess } from "./resolveWorkspaceAccess";
import type { WorkspaceMembershipV1 } from "./membershipTypes";
import type { WorkspaceCapability } from "./capabilities";
import type { TeamWorkspaceV1 } from "./types";

export type ResolveTeamRunWorkspaceAccessResult =
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

export async function resolveTeamRunWorkspaceAccess(args: { uid: string; workspaceId: string }): Promise<ResolveTeamRunWorkspaceAccessResult> {
  // Step 1 — target-Workspace admission pre-filter FIRST. Pure, zero I/O.
  // Nothing below this line runs for a caller/target pair not admitted by
  // any mechanism.
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

  // Step 2 — the ONE Workspace resolution path, reused verbatim.
  const access = await resolveWorkspaceAccess({ uid: args.uid, workspaceId: args.workspaceId });

  if (!access.granted) {
    // `resolveWorkspaceAccess()`'s own reason set includes "not_owner",
    // which only ever fires for a Personal-typed Workspace the caller
    // doesn't own. That is conceptually identical, from this resolver's
    // perspective, to "this isn't a Team Workspace I can use" —
    // `wrong_workspace_type` is the correct bucket for it, never a new,
    // separately-exposed reason (both map to the same concealed public
    // response either way).
    if (access.reason === "not_owner") {
      return { granted: false, reason: "wrong_workspace_type" };
    }
    return { granted: false, reason: access.reason };
  }

  // Step 3 — the mandatory Team-type guard. Closes the Personal-Workspace
  // collision case.
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
