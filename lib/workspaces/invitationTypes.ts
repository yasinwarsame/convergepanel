/**
 * Team Workspace Invitations — neutral domain types and pure
 * well-formedness validators for `workspaceInvitations/{id}` and
 * `workspaceInvitationKeys/{wik_*}`, extracted from
 * `lib/firestore/workspaceInvitations.ts` in Phase 10B.1 for dependency
 * hygiene: `lib/workspaces/teamWorkspaceCanaryCapacity.ts` needs these
 * shapes to validate guard/invitation records during its own bootstrap
 * read, but `lib/firestore/workspaceInvitations.ts` will itself import
 * the capacity module in Phase 10B.2 — importing the validators from the
 * mutation-holding file directly would create a runtime cycle. This
 * mirrors the existing `membershipTypes.ts`/`workspaceMemberships.ts`
 * split (pure domain types + validators live separately from the
 * Firestore transaction primitives that mutate them).
 *
 * Extraction is strictly mechanical — no logic changed. Every export here
 * is byte-identical in behavior to what `workspaceInvitations.ts`
 * previously defined inline; that file now imports and re-exports these
 * same bindings so no existing importer (`workspaceInvitationDelivery.ts`,
 * every existing test) observes any difference.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { isValidNormalizedInvitationEmail } from "@/lib/workspaces/invitationEmail";
import { isWellFormedInvitationTokenHash } from "@/lib/workspaces/invitationToken";

export type WorkspaceInvitationRole = "admin" | "member" | "reviewer" | "viewer";
export const WORKSPACE_INVITATION_ROLES: readonly WorkspaceInvitationRole[] = ["admin", "member", "reviewer", "viewer"];

export type WorkspaceInvitationStatus = "pending" | "accepted" | "revoked";
export const WORKSPACE_INVITATION_STATUSES: readonly WorkspaceInvitationStatus[] = ["pending", "accepted", "revoked"];

export type WorkspaceInvitationDeliveryStatus = "sent" | "failed";
export const WORKSPACE_INVITATION_DELIVERY_STATUSES: readonly WorkspaceInvitationDeliveryStatus[] = ["sent", "failed"];

/** The invitation document itself, at `workspaceInvitations/{id}` where `id` is a Firestore auto-id — see the module's original doc comment (now in `lib/firestore/workspaceInvitations.ts`) for why (mirrors `workspaces/{id}`'s own auto-id convention, not a prefixed-UUID scheme). */
export interface WorkspaceInvitationV1 {
  schemaVersion: 1;
  id: string;
  workspaceId: string;
  normalizedEmail: string;
  role: WorkspaceInvitationRole;
  status: WorkspaceInvitationStatus;
  tokenHash: string;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  invitedByUserId: string;
  acceptedAt: Timestamp | null;
  acceptedByUserId: string | null;
  revokedAt: Timestamp | null;
  revokedByUserId: string | null;
  /** Email/token issuance version — starts at 1, incremented by resend only. Never incremented by revoke. */
  deliveryVersion: number;
  lastDeliveryAttemptAt: Timestamp | null;
  lastDeliveryStatus: WorkspaceInvitationDeliveryStatus | null;
  /** The `deliveryVersion` the last successfully-recorded (non-stale) delivery result actually corresponds to — makes the persisted metadata self-describing. */
  lastDeliveryVersion: number | null;
  providerMessageId: string | null;
}

/** The current-invitation guard, at `workspaceInvitationKeys/{wik_*}` — see `invitationKey.ts`. No token material. */
export interface WorkspaceInvitationKeyV1 {
  workspaceId: string;
  normalizedEmail: string;
  currentInvitationId: string;
  updatedAt: Timestamp;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// ==================================================================
// Validators — never a blind cast; every authorization/state decision
// that depends on these lives in the callers, not here.
// ==================================================================

export function isWellFormedWorkspaceInvitationV1(data: unknown): data is WorkspaceInvitationV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;

  if (d.schemaVersion !== 1) return false;
  if (typeof d.id !== "string" || d.id.length === 0) return false;
  if (typeof d.workspaceId !== "string" || d.workspaceId.length === 0) return false;
  if (!isValidNormalizedInvitationEmail(d.normalizedEmail)) return false;
  if (typeof d.role !== "string" || !WORKSPACE_INVITATION_ROLES.includes(d.role as WorkspaceInvitationRole)) return false;
  if (typeof d.status !== "string" || !WORKSPACE_INVITATION_STATUSES.includes(d.status as WorkspaceInvitationStatus)) return false;
  if (!isWellFormedInvitationTokenHash(d.tokenHash)) return false;
  if (!(d.expiresAt instanceof Timestamp)) return false;
  if (!(d.createdAt instanceof Timestamp)) return false;
  if (!(d.updatedAt instanceof Timestamp)) return false;
  if (typeof d.invitedByUserId !== "string" || d.invitedByUserId.length === 0) return false;

  const acceptedAtNull = d.acceptedAt === null;
  const acceptedByNull = d.acceptedByUserId === null;
  if (acceptedAtNull !== acceptedByNull) return false;
  if (!acceptedAtNull) {
    if (!(d.acceptedAt instanceof Timestamp)) return false;
    if (!(typeof d.acceptedByUserId === "string" && d.acceptedByUserId.length > 0)) return false;
  }

  const revokedAtNull = d.revokedAt === null;
  const revokedByNull = d.revokedByUserId === null;
  if (revokedAtNull !== revokedByNull) return false;
  if (!revokedAtNull) {
    if (!(d.revokedAt instanceof Timestamp)) return false;
    if (!(typeof d.revokedByUserId === "string" && d.revokedByUserId.length > 0)) return false;
  }

  // Status/removal-field coherence — mirrors membershipTypes.ts's
  // status/removedAt coherence pattern.
  if (d.status === "accepted" && acceptedAtNull) return false;
  if (d.status !== "accepted" && !acceptedAtNull) return false;
  if (d.status === "revoked" && revokedAtNull) return false;
  if (d.status !== "revoked" && !revokedAtNull) return false;

  if (!isPositiveInteger(d.deliveryVersion)) return false;
  if (!(d.lastDeliveryAttemptAt === null || d.lastDeliveryAttemptAt instanceof Timestamp)) return false;
  if (!(d.lastDeliveryStatus === null || (typeof d.lastDeliveryStatus === "string" && WORKSPACE_INVITATION_DELIVERY_STATUSES.includes(d.lastDeliveryStatus as WorkspaceInvitationDeliveryStatus)))) return false;
  if (!(d.lastDeliveryVersion === null || isPositiveInteger(d.lastDeliveryVersion))) return false;
  // Deliberately NOT required merely because lastDeliveryStatus === "failed" — a failed send may have no provider-assigned id.
  if (!(d.providerMessageId === null || (typeof d.providerMessageId === "string" && d.providerMessageId.length > 0))) return false;

  return true;
}

export function isWellFormedWorkspaceInvitationKeyV1(data: unknown): data is WorkspaceInvitationKeyV1 {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (typeof d.workspaceId !== "string" || d.workspaceId.length === 0) return false;
  if (!isValidNormalizedInvitationEmail(d.normalizedEmail)) return false;
  if (typeof d.currentInvitationId !== "string" || d.currentInvitationId.length === 0) return false;
  if (!(d.updatedAt instanceof Timestamp)) return false;
  return true;
}
