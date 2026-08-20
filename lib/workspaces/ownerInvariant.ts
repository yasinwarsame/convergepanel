/**
 * Team Workspace Core Foundation, Phase 8B — the ONE canonical "is this
 * membership row a genuine, currently-valid Team Owner" check. Shared by
 * `resolveWorkspaceAccess.ts` (read-path authorization) and
 * `transferTeamWorkspaceOwnership()` (write-path authorization) so the
 * Owner invariant is defined exactly once, never re-derived per call site.
 *
 * A membership with `role === "owner"` while `workspace.ownerUserId`
 * points at someone else is an INTEGRITY VIOLATION, not a lower-privilege
 * grant — see `resolveWorkspaceAccess.ts`'s doc comment for the full
 * denial-of-the-entire-outcome rationale. This function only answers the
 * pure yes/no invariant question; callers decide what to do with `false`
 * (deny outright vs. deny + log an integrity event).
 */

import "server-only";
import type { TeamWorkspaceV1 } from "./types";
import type { WorkspaceMembershipV1 } from "./membershipTypes";

/**
 * Every one of these must hold for `membership` to count as the
 * workspace's real, current Owner:
 *   workspace.type === "team"
 *   membership.status === "active"
 *   membership.workspaceId === workspace.id
 *   membership.role === "owner"
 *   workspace.ownerUserId === membership.uid
 *
 * Deliberately does NOT check `membership.uid === callers's authenticated
 * uid` — that binding is the caller's responsibility (typically already
 * guaranteed by having fetched this exact membership document via
 * `computeMembershipId(workspaceId, authenticatedUid)` in the first
 * place); this function only judges the row's own internal + cross-
 * document coherence.
 */
export function isCanonicalTeamOwnerMembership(args: { workspace: TeamWorkspaceV1; membership: WorkspaceMembershipV1 }): boolean {
  return (
    args.workspace.type === "team" &&
    args.membership.status === "active" &&
    args.membership.workspaceId === args.workspace.id &&
    args.membership.role === "owner" &&
    args.workspace.ownerUserId === args.membership.uid
  );
}
