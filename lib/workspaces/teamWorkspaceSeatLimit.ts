/**
 * Permanent Team Workspace Collaborator-Seat Limit, Phase 12A.1S.1 — the
 * ONE authoritative product-entitlement constant. Every Team Workspace may
 * have at most this many collaborator seats: an active non-owner
 * membership, or a valid non-expired pending invitation (see
 * `teamWorkspaceSeatAdmission.ts` for the full occupancy formula). The
 * canonical Workspace Owner never consumes one of these seats.
 *
 * Deliberately distinct from `teamWorkspaceCanaryCapacity.ts`'s
 * `MAX_TEAM_WORKSPACE_CANARY_MEMBERS` (a Tier-2 rollout-containment device
 * that goes fully inert at GA, per that module's own frozen contract) —
 * the PHASE 12A.1S.0 audit established this limit must be a separate,
 * always-on, permanent product rule, never conditional on
 * `TEAM_WORKSPACES_ENABLED` or any canary admission source.
 *
 * Fixed for this phase, not plan-based. `getTeamWorkspaceCollaboratorSeatLimit()`
 * reserves a seam for a future plan-driven entitlement lookup (mirroring
 * `lib/plans.ts`'s existing per-plan-limit pattern elsewhere in this app)
 * without callers needing to change their call sites later — no
 * pricing/plan logic is implemented here.
 */

export const TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT = 5;

/** Pure getter seam — today always returns the fixed constant regardless of `workspaceId`. */
export function getTeamWorkspaceCollaboratorSeatLimit(_workspaceId: string): number {
  return TEAM_WORKSPACE_COLLABORATOR_SEAT_LIMIT;
}
