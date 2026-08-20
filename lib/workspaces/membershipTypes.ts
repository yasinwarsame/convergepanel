/**
 * Team Workspace Core Foundation, Phase 8B — domain types for the
 * canonical membership model at `workspaceMemberships/{membershipId}`.
 * No `members[]` array on the Workspace document, no Workspace
 * subcollection — a top-level collection keyed by a deterministic id (see
 * `membershipId.ts`), mirroring this codebase's existing preference for
 * flat, independently-queryable collections over embedded arrays (e.g.
 * `workspaceMemberships` vs. denormalizing membership onto `workspaces`,
 * the same shape choice already made for `runs`/`projects` vs. embedding
 * them on `workspaces`). See docs/workspaces/phase8-team-workspace-foundation.md
 * for the full frozen Phase 8A–8A.2 rationale this implements.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";

/** Frozen V1 role set — `"owner"` is never assignable through an ordinary role-mutation path; see `capabilities.ts` and the dedicated ownership-transfer transaction. */
export type WorkspaceMembershipRole = "owner" | "admin" | "member" | "reviewer" | "viewer";

export const WORKSPACE_MEMBERSHIP_ROLES: readonly WorkspaceMembershipRole[] = ["owner", "admin", "member", "reviewer", "viewer"];

/** Frozen V1 status set. `"removed"` is a soft-delete marker — a removed membership document is never deleted, only marked. */
export type WorkspaceMembershipStatus = "active" | "removed";

export const WORKSPACE_MEMBERSHIP_STATUSES: readonly WorkspaceMembershipStatus[] = ["active", "removed"];

/**
 * The membership document itself, at `workspaceMemberships/{id}` where
 * `id === computeMembershipId(workspaceId, uid)` (see `membershipId.ts`).
 * `invitedByUserId: null` for the founder membership created alongside a
 * Team Workspace (see `createTeamWorkspace()`) — never a fabricated
 * inviter uid. `removedAt`/`removedByUserId` are both `null` until a
 * removal is recorded (removal itself is not implemented in Phase 8B; the
 * fields exist now so the shape never needs a breaking change later).
 */
export interface WorkspaceMembershipV1 {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  uid: string;
  role: WorkspaceMembershipRole;
  status: WorkspaceMembershipStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  invitedByUserId: string | null;
  removedAt: Timestamp | null;
  removedByUserId: string | null;
}

/**
 * Structural guard for data read back from Firestore — never a blind
 * cast, since every authorization decision in Phase 8B depends on this.
 * Fails closed on anything it cannot positively validate; this function
 * deliberately does NOT check `id === computeMembershipId(workspaceId, uid)`
 * or `workspaceId`/`uid` matching an expected caller-supplied value — those
 * are resource-binding checks that require knowing the *expected* values,
 * which this pure shape validator is never given. See
 * `lib/firestore/workspaceMemberships.ts`'s `getWorkspaceMembershipForBinding()`
 * for where that binding is enforced, mirroring exactly how
 * `isWellFormedWorkspaceV1` vs. `getWorkspace()`'s document-id check are
 * already split in this codebase.
 *
 * - Strictly validated: `schemaVersion` (literal `1`), `id`/`workspaceId`/`uid`
 *   (non-empty strings), `role` (must be one of the five frozen V1 roles),
 *   `status` (must be `"active"` or `"removed"`), `createdAt`/`updatedAt`
 *   (must be genuine `Timestamp` instances — authorization-adjacent for
 *   `updatedAt`, since it participates as an OCC precondition in the
 *   transfer transaction).
 * - `invitedByUserId` must be a non-empty string or exactly `null` — never
 *   `undefined` (a field that was never persisted is a malformed document,
 *   not an implicit `null`) and never an empty string.
 * - `removedAt`/`removedByUserId` must be internally coherent: both `null`
 *   (never removed) or both non-null-and-well-typed (`removedAt` a
 *   `Timestamp`, `removedByUserId` a non-empty string) together with
 *   `status === "removed"`. A document claiming `status: "removed"` with
 *   either removal field still `null`, or `status: "active"` with either
 *   removal field populated, is rejected as malformed — never repaired,
 *   never partially trusted.
 * - Unknown/extra fields are accepted, matching `isWellFormedWorkspaceV1`'s
 *   own open/forward-compatible schema policy.
 */
export function isWellFormedWorkspaceMembershipV1(data: unknown): data is WorkspaceMembershipV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;

  if (d.schemaVersion !== 1) return false;
  if (typeof d.id !== "string" || d.id.length === 0) return false;
  if (typeof d.workspaceId !== "string" || d.workspaceId.length === 0) return false;
  if (typeof d.uid !== "string" || d.uid.length === 0) return false;
  if (typeof d.role !== "string" || !WORKSPACE_MEMBERSHIP_ROLES.includes(d.role as WorkspaceMembershipRole)) return false;
  if (typeof d.status !== "string" || !WORKSPACE_MEMBERSHIP_STATUSES.includes(d.status as WorkspaceMembershipStatus)) return false;
  if (!(d.createdAt instanceof Timestamp)) return false;
  if (!(d.updatedAt instanceof Timestamp)) return false;

  if (!(d.invitedByUserId === null || (typeof d.invitedByUserId === "string" && d.invitedByUserId.length > 0))) return false;

  const removedAtIsNull = d.removedAt === null;
  const removedByIsNull = d.removedByUserId === null;
  if (removedAtIsNull !== removedByIsNull) return false; // must agree
  if (!removedAtIsNull) {
    if (!(d.removedAt instanceof Timestamp)) return false;
    if (!(typeof d.removedByUserId === "string" && d.removedByUserId.length > 0)) return false;
  }
  // Removal-field/status coherence.
  if (d.status === "removed" && removedAtIsNull) return false;
  if (d.status === "active" && !removedAtIsNull) return false;

  return true;
}
