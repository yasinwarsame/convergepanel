/**
 * Team Workspace Core Foundation, Phase 8B — the canonical "what can this
 * uid do within this Workspace" resolver. Deliberately a NEW, additive
 * module, not a modification of `workspaceAccess.ts`/`workspaceResolver.ts`
 * — those answer a different question ("which Workspace does THIS
 * RESOURCE belong to, and does the resource's owner match this uid")
 * along the resource-binding axis Phase 1–7 already built. This module
 * answers "given a Workspace the caller already knows the id of, what is
 * their access WITHIN it" — the axis Phase 8B introduces for Team
 * Workspaces. The two resolvers compose (a route can resolve a resource's
 * `workspaceId` via the old resolver, then resolve capabilities within
 * that workspace via this one) but neither replaces the other.
 *
 * Two Firestore reads maximum, always: `getWorkspace()` (one doc-get) and,
 * for a Team Workspace only, `getWorkspaceMembershipForBinding()` (one
 * more doc-get, direct by deterministic id — no query). No N+1 pattern,
 * no "list all memberships and check for exactly one Owner" query — the
 * Owner invariant is verified purely from the two documents already read.
 */

import "server-only";
import { logger } from "@/lib/logger";
import { getWorkspace } from "@/lib/firestore/workspaces";
import { getWorkspaceMembershipForBinding } from "@/lib/firestore/workspaceMemberships";
import { isCanonicalTeamOwnerMembership } from "./ownerInvariant";
import { capabilitiesForRole, type WorkspaceCapability } from "./capabilities";
import type { WorkspaceMembershipV1 } from "./membershipTypes";
import type { PersonalWorkspaceV1, TeamWorkspaceV1 } from "./types";

export type ResolveWorkspaceAccessResult =
  | { granted: true; workspaceType: "personal"; workspace: PersonalWorkspaceV1 }
  | { granted: true; workspaceType: "team"; workspace: TeamWorkspaceV1; membership: WorkspaceMembershipV1; capabilities: readonly WorkspaceCapability[] }
  | {
      granted: false;
      reason:
        | "workspace_not_found"
        | "workspace_malformed"
        | "lookup_failed"
        | "not_owner" // Personal mode only.
        | "membership_not_found"
        | "membership_removed"
        | "membership_malformed"
        | "owner_integrity_violation";
    };

/**
 * PERSONAL: unchanged from Phase 1 — exact `ownerUserId === uid` equality,
 * no `workspaceMemberships` row required or consulted, no migration.
 *
 * TEAM: a normal (non-Owner) member needs an `active` membership bound to
 * this exact workspace/uid. An Owner additionally requires
 * `isCanonicalTeamOwnerMembership()` to hold — see that function's doc
 * comment. A membership claiming `role: "owner"` while
 * `workspace.ownerUserId` disagrees is an INTEGRITY VIOLATION: the entire
 * authorization result is denied for that membership (never reinterpreted
 * as Admin, never granted the lower capability set a non-Owner role would
 * have), and a structured integrity event is logged via the repository
 * logger — never `console.*`.
 */
export async function resolveWorkspaceAccess(args: { uid: string; workspaceId: string }): Promise<ResolveWorkspaceAccessResult> {
  const lookup = await getWorkspace(args.workspaceId);
  switch (lookup.status) {
    case "not_found":
      return { granted: false, reason: "workspace_not_found" };
    case "malformed":
      return { granted: false, reason: "workspace_malformed" };
    case "firestore_unavailable":
    case "read_failed":
      return { granted: false, reason: "lookup_failed" };
    case "found":
      break;
  }

  const workspace = lookup.workspace;

  if (workspace.type === "personal") {
    if (workspace.ownerUserId !== args.uid) {
      return { granted: false, reason: "not_owner" };
    }
    return { granted: true, workspaceType: "personal", workspace };
  }

  // workspace.type === "team" — no feature flag gates this path. Phase
  // 8B introduces no environment-contract change; the Team Workspace
  // backend surface is scoped to production exposure entirely by this
  // branch not being merged or deployed, not by a runtime kill switch.
  const membershipLookup = await getWorkspaceMembershipForBinding({ workspaceId: workspace.id, uid: args.uid });
  switch (membershipLookup.status) {
    case "not_found":
      return { granted: false, reason: "membership_not_found" };
    case "malformed":
      return { granted: false, reason: "membership_malformed" };
    case "firestore_unavailable":
    case "read_failed":
      return { granted: false, reason: "lookup_failed" };
    case "found":
      break;
  }

  const membership = membershipLookup.membership;
  if (membership.status !== "active") {
    return { granted: false, reason: "membership_removed" };
  }

  if (membership.role === "owner") {
    if (!isCanonicalTeamOwnerMembership({ workspace, membership })) {
      logger.error("[workspaces/resolveWorkspaceAccess] Owner-role membership does not match workspace.ownerUserId — integrity violation, denying entire access", {
        workspaceId: workspace.id,
        membershipUid: membership.uid,
        workspaceOwnerUserId: workspace.ownerUserId,
      });
      return { granted: false, reason: "owner_integrity_violation" };
    }
  }

  return {
    granted: true,
    workspaceType: "team",
    workspace,
    membership,
    capabilities: capabilitiesForRole(membership.role),
  };
}
