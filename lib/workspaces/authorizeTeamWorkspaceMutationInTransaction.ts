/**
 * Team Project Backend, Phase 8C-A — the ONE canonical transaction-scoped
 * "is this uid currently allowed to perform this capability in this Team
 * Workspace" check, called from INSIDE an already-open
 * `adminDb.runTransaction()` callback. Every Team Project mutation
 * (create/rename/archive/restore) funnels its authorization decision
 * through this function rather than re-deriving the read/validate sequence
 * per call site.
 *
 * Deliberately distinct from `resolveWorkspaceAccess()` (Phase 8B): that
 * resolver performs its OWN, non-transactional reads (`getWorkspace()`,
 * `getWorkspaceMembershipForBinding()`) and is safe only as an optional
 * request-time precheck — never as the authoritative gate for a write,
 * since a revocation could land between its reads and a later, separate
 * write. This function reads Workspace + membership state through the
 * SAME `Transaction` handle the caller's write will also go through, so
 * Firestore's own optimistic-concurrency conflict detection on those
 * documents is what closes the revocation race (see
 * `docs/workspaces/phase8-team-workspace-foundation.md`'s Phase 8C.0.1
 * revocation-serialization contract: a membership mutation that commits
 * before this transaction's own commit forces a conflict/retry, and the
 * retried read sees the fresh, denying state).
 *
 * Stronger than `resolveWorkspaceAccess()` in one respect, deliberately:
 * the canonical owner membership is read and validated for EVERY caller,
 * not only when the caller's own role claims to be Owner. A Team
 * Workspace whose stored `ownerUserId` has no genuine, active Owner-role
 * membership is in a corrupted state — every mutation fails closed until
 * that's repaired, never silently permitted merely because the requesting
 * caller's own membership happens to look fine in isolation.
 */

import "server-only";
import type { Transaction } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { isCanonicalTeamOwnerMembership } from "./ownerInvariant";
import { isWellFormedWorkspaceV1, type TeamWorkspaceV1 } from "./types";
import { roleHasCapability, type WorkspaceCapability } from "./capabilities";
import type { WorkspaceMembershipV1 } from "./membershipTypes";

export type TeamMutationAuthorizationDenialReason =
  | "workspace_not_found"
  | "workspace_malformed"
  | "membership_not_found"
  | "membership_removed"
  | "membership_malformed"
  | "owner_integrity_violation"
  | "insufficient_capability";

export type TeamMutationAuthorizationResult =
  | { ok: true; workspace: TeamWorkspaceV1; membership: WorkspaceMembershipV1 }
  | { ok: false; reason: TeamMutationAuthorizationDenialReason };

/**
 * Read/validate order (frozen — do not reorder):
 *   1. Workspace W: exists, well-formed, `id === workspaceId`, `type === "team"`.
 *   2. Caller's own membership at `computeMembershipId(workspaceId, uid)`:
 *      exists, well-formed, bound to this exact (workspaceId, uid), `status === "active"`.
 *   3. Canonical owner membership at `computeMembershipId(workspaceId, W.ownerUserId)`
 *      (deduplicated to the SAME read as step 2 when `uid === W.ownerUserId`):
 *      exists, well-formed, and `isCanonicalTeamOwnerMembership()` holds.
 *   4. `roleHasCapability(callerMembership.role, requiredCapability)`.
 *
 * Never checks rollout eligibility (`TEAM_WORKSPACES_ENABLED`/
 * `TEAM_WORKSPACES_CANARY_UIDS`) — that gate runs in the CALLER, before
 * `adminDb.runTransaction()` is ever entered, mirroring
 * `createTeamWorkspace()`/`transferTeamWorkspaceOwnership()`'s established
 * precedent of checking rollout before any Firestore access at all.
 *
 * Never throws on an authorization denial — returns `{ok: false, reason}`.
 * A thrown error here (a genuine Firestore read failure inside the
 * transaction) propagates to the caller's own `try/catch` around
 * `runTransaction()`, exactly like every other read inside this codebase's
 * existing Team transactions.
 */
export async function authorizeTeamWorkspaceMutationInTransaction(
  tx: Transaction,
  args: { uid: string; workspaceId: string; requiredCapability: WorkspaceCapability }
): Promise<TeamMutationAuthorizationResult> {
  if (!adminDb) {
    // Structurally unreachable — every caller only invokes this from
    // inside an already-open `adminDb.runTransaction()`, which itself
    // requires `adminDb` to be non-null. Kept as an explicit fail-closed
    // branch for type-safety, never a non-null assertion.
    return { ok: false, reason: "workspace_not_found" };
  }

  const workspaceRef = adminDb.collection("workspaces").doc(args.workspaceId);
  const callerMembershipId = computeMembershipId(args.workspaceId, args.uid);
  const callerRef = adminDb.collection("workspaceMemberships").doc(callerMembershipId);

  const [workspaceSnap, callerSnap] = await Promise.all([tx.get(workspaceRef), tx.get(callerRef)]);

  if (!workspaceSnap.exists) {
    return { ok: false, reason: "workspace_not_found" };
  }
  const workspaceData = workspaceSnap.data();
  if (!isWellFormedWorkspaceV1(workspaceData) || workspaceData.id !== args.workspaceId) {
    return { ok: false, reason: "workspace_malformed" };
  }
  if (workspaceData.type !== "team") {
    return { ok: false, reason: "workspace_malformed" };
  }
  const workspace = workspaceData as TeamWorkspaceV1;

  if (!callerSnap.exists) {
    return { ok: false, reason: "membership_not_found" };
  }
  const callerMembership = validateMembershipBinding(callerSnap.data(), { workspaceId: args.workspaceId, uid: args.uid });
  if (!callerMembership) {
    return { ok: false, reason: "membership_malformed" };
  }
  if (callerMembership.status !== "active") {
    return { ok: false, reason: "membership_removed" };
  }

  let ownerMembership: WorkspaceMembershipV1;
  if (args.uid === workspace.ownerUserId) {
    // Deduplicated read — the caller IS the workspace's current owner, so
    // the membership document already fetched above is the same document
    // the owner-integrity check would otherwise re-fetch.
    ownerMembership = callerMembership;
  } else {
    const ownerMembershipId = computeMembershipId(args.workspaceId, workspace.ownerUserId);
    const ownerRef = adminDb.collection("workspaceMemberships").doc(ownerMembershipId);
    const ownerSnap = await tx.get(ownerRef);
    if (!ownerSnap.exists) {
      return { ok: false, reason: "owner_integrity_violation" };
    }
    const validatedOwner = validateMembershipBinding(ownerSnap.data(), { workspaceId: args.workspaceId, uid: workspace.ownerUserId });
    if (!validatedOwner) {
      return { ok: false, reason: "owner_integrity_violation" };
    }
    ownerMembership = validatedOwner;
  }
  if (!isCanonicalTeamOwnerMembership({ workspace, membership: ownerMembership })) {
    return { ok: false, reason: "owner_integrity_violation" };
  }

  if (!roleHasCapability(callerMembership.role, args.requiredCapability)) {
    return { ok: false, reason: "insufficient_capability" };
  }

  return { ok: true, workspace, membership: callerMembership };
}
