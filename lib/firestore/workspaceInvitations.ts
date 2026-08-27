/**
 * Team Workspace Invitations, Phase 8D.1 — canonical types, validators,
 * and the five Firestore transaction primitives (create/resend/revoke/
 * accept/list) for `workspaceInvitations/{id}` and
 * `workspaceInvitationKeys/{wik_*}`. Domain + persistence only — no API
 * route, no email provider integration (see Phase 8D.2), no UI.
 *
 * Every mutation funnels fresh transactional authorization through
 * `authorizeTeamWorkspaceMutationInTransaction()` (create/resend:
 * `members.invite`; revoke: `members.manage`, checked INDEPENDENTLY —
 * never inferred from `members.invite` merely because Owner/Admin
 * currently hold both), plus a second, orthogonal
 * `canManageInvitationTargetRole()` check on the invitation's OWN target
 * role — a caller can hold the operation capability while still being
 * forbidden from acting on a specific target role (Admin may never
 * create/resend/revoke an Admin-target invitation).
 *
 * `workspaceInvitationKeys/{wik_*}` is the single authoritative "what is
 * the CURRENT invitation for this (workspaceId, normalizedEmail) pair"
 * pointer — resend/revoke/accept/list all defer to
 * `guard.currentInvitationId`, never to `invitation.status` alone (a
 * superseded invitation's own `status` field is never rewritten when a
 * newer one replaces it — see the CREATE guard-state matrix below).
 *
 * No Workspace/membership/capability/owner-invariant primitive is
 * redefined here — `computeMembershipId()`, `isWellFormedWorkspaceV1()`,
 * `isCanonicalTeamOwnerMembership()`, `validateMembershipBinding()`,
 * `resolveWorkspaceAccess()`, and `authorizeTeamWorkspaceMutationInTransaction()`
 * are all reused exactly as Phase 8B/8C left them.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb, adminAuth } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission, capacityControlled } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
import { reserveTeamWorkspaceCanarySlot, releaseTeamWorkspaceCanarySlot } from "@/lib/workspaces/teamWorkspaceCanaryCapacity";
import { authorizeTeamWorkspaceMutationInTransaction, type TeamMutationAuthorizationDenialReason } from "@/lib/workspaces/authorizeTeamWorkspaceMutationInTransaction";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import { canManageInvitationTargetRole } from "@/lib/workspaces/invitationRoleAuthority";
import { normalizeInvitationEmail } from "@/lib/workspaces/invitationEmail";
import { computeWorkspaceInvitationKey } from "@/lib/workspaces/invitationKey";
import { generateWorkspaceInvitationToken, hashWorkspaceInvitationToken, verifyWorkspaceInvitationToken } from "@/lib/workspaces/invitationToken";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { validateMembershipBinding } from "@/lib/workspaces/membershipBinding";
import { isCanonicalTeamOwnerMembership } from "@/lib/workspaces/ownerInvariant";
import { isWellFormedWorkspaceV1, type TeamWorkspaceV1 } from "@/lib/workspaces/types";
import type { WorkspaceMembershipRole, WorkspaceMembershipV1 } from "@/lib/workspaces/membershipTypes";

// ==================================================================
// Canonical types — extracted to `invitationTypes.ts` in Phase 10B.1 for
// dependency hygiene (see that module's doc comment); re-exported here
// unchanged so no existing importer of this file is affected.
// ==================================================================

export {
  WORKSPACE_INVITATION_ROLES,
  WORKSPACE_INVITATION_STATUSES,
  WORKSPACE_INVITATION_DELIVERY_STATUSES,
  isWellFormedWorkspaceInvitationV1,
  isWellFormedWorkspaceInvitationKeyV1,
} from "@/lib/workspaces/invitationTypes";
export type { WorkspaceInvitationRole, WorkspaceInvitationStatus, WorkspaceInvitationDeliveryStatus, WorkspaceInvitationV1, WorkspaceInvitationKeyV1 } from "@/lib/workspaces/invitationTypes";

import {
  WORKSPACE_INVITATION_ROLES,
  isPositiveInteger,
  isWellFormedWorkspaceInvitationV1,
  isWellFormedWorkspaceInvitationKeyV1,
  type WorkspaceInvitationRole,
  type WorkspaceInvitationV1,
  type WorkspaceInvitationKeyV1,
  type WorkspaceInvitationDeliveryStatus,
} from "@/lib/workspaces/invitationTypes";

const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

function addSeconds(ts: Timestamp, seconds: number): Timestamp {
  return new Timestamp(ts.seconds + seconds, ts.nanoseconds);
}

/**
 * Phase 10B.2 — the single call shape every invitation-admin operation
 * uses to decide target-Workspace Team admission. Composes the reviewed
 * Phase 10B.1 foundation (`resolveTeamWorkspaceTargetAdmission()`)
 * against this file's own env bindings; never re-derives precedence
 * logic locally.
 */
function isTargetWorkspaceAdmitted(uid: string, workspaceId: string): boolean {
  return resolveTeamWorkspaceTargetAdmission({ uid, workspaceId, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS, canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS }).enabled;
}

/** Same composition for the capacity-scope predicate — see `capacityControlled()`'s own doc comment for why it deliberately takes no uid. */
function isWorkspaceCapacityControlled(workspaceId: string): boolean {
  return capacityControlled({ workspaceId, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS });
}

// ==================================================================
// CREATE
// ==================================================================

export type CreateWorkspaceInvitationResult =
  | {
      status: "created";
      invitationId: string;
      workspaceId: string;
      normalizedEmail: string;
      role: WorkspaceInvitationRole;
      expiresAt: Timestamp;
      deliveryVersion: number;
      /** Transient — exists ONLY in this in-memory result, for the Phase 8D.2 delivery boundary to consume immediately. Never logged, never re-derivable from persisted state. */
      rawToken: string;
    }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "role_target_forbidden" }
  | { status: "invalid_email" }
  | { status: "invalid_role" }
  | { status: "duplicate_live_invitation" }
  | { status: "workspace_member_capacity_reached" }
  | { status: "state_corruption" }
  | { status: "create_failed" };

/**
 * The raw token, its hash, and the invitation's opaque auto-id are all
 * generated/allocated exactly ONCE, before `runTransaction()` is ever
 * entered — never inside the retryable callback, so a Firestore-internal
 * retry reuses the identical id/token/hash rather than silently minting a
 * second set of security material for the same logical create attempt.
 */
export async function createWorkspaceInvitation(args: { uid: string; workspaceId: string; email: unknown; role: unknown }): Promise<CreateWorkspaceInvitationResult> {
  if (!isTargetWorkspaceAdmitted(args.uid, args.workspaceId)) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const emailResult = normalizeInvitationEmail(args.email);
  if (!emailResult.ok) {
    return { status: "invalid_email" };
  }
  const normalizedEmail = emailResult.normalizedEmail;

  if (typeof args.role !== "string" || !WORKSPACE_INVITATION_ROLES.includes(args.role as WorkspaceInvitationRole)) {
    return { status: "invalid_role" };
  }
  const requestedRole = args.role as WorkspaceInvitationRole;

  const rawToken = generateWorkspaceInvitationToken();
  const tokenHash = hashWorkspaceInvitationToken(rawToken);
  const invitationRef = adminDb.collection("workspaceInvitations").doc();
  const invitationId = invitationRef.id;
  const guardKey = computeWorkspaceInvitationKey(args.workspaceId, normalizedEmail);
  const guardRef = adminDb.collection("workspaceInvitationKeys").doc(guardKey);

  type TxResult =
    | { kind: "created"; invitation: WorkspaceInvitationV1 }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "role_target_forbidden" }
    | { kind: "duplicate_live_invitation" }
    | { kind: "workspace_member_capacity_reached" }
    | { kind: "state_corruption" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "members.invite" });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      if (!canManageInvitationTargetRole({ callerRole: auth.membership.role, targetRole: requestedRole })) {
        return { kind: "role_target_forbidden" };
      }

      // Capacity classification (Phase 10A.4 state-based reservation model,
      // Phase 10B.2 integration): a brand-new guard, or one whose current
      // invitation is accepted/revoked, means this create is a GENUINELY
      // NEW reservation (+1, subject to the cap). A guard whose current
      // invitation is pending-but-expired means the replacement inherits
      // that SAME already-counted reservation — net delta 0, and the
      // replacement must succeed even at/above the cap (see branch C
      // below). Never set true/false based on expiresAt for any other
      // reason — reservation ownership is state-based, not wall-clock.
      let priorReservationCarriesOver = false;

      const guardSnap = await tx.get(guardRef);
      if (guardSnap.exists) {
        const guardData = guardSnap.data();
        if (!isWellFormedWorkspaceInvitationKeyV1(guardData) || guardData.workspaceId !== args.workspaceId || guardData.normalizedEmail !== normalizedEmail) {
          return { kind: "state_corruption" };
        }
        const currentRef = adminDb!.collection("workspaceInvitations").doc(guardData.currentInvitationId);
        const currentSnap = await tx.get(currentRef);
        if (!currentSnap.exists) {
          return { kind: "state_corruption" };
        }
        const currentData = currentSnap.data();
        if (
          !isWellFormedWorkspaceInvitationV1(currentData) ||
          currentData.id !== guardData.currentInvitationId ||
          currentData.workspaceId !== args.workspaceId ||
          currentData.normalizedEmail !== normalizedEmail
        ) {
          return { kind: "state_corruption" };
        }
        if (currentData.status === "pending" && currentData.expiresAt.toMillis() > Timestamp.now().toMillis()) {
          return { kind: "duplicate_live_invitation" };
        }
        // pending+expired, accepted, or revoked — supersede below.
        if (currentData.status === "pending") {
          // Expired-but-still-pending: its reservation carries over.
          priorReservationCarriesOver = true;
        }
      }

      if (!priorReservationCarriesOver && isWorkspaceCapacityControlled(args.workspaceId)) {
        const reserve = await reserveTeamWorkspaceCanarySlot(tx, args.workspaceId);
        if (reserve.status === "capacity_reached") {
          return { kind: "workspace_member_capacity_reached" };
        }
        if (reserve.status !== "reserved") {
          return { kind: "state_corruption" };
        }
      }

      const now = Timestamp.now();
      const expiresAt = addSeconds(now, INVITATION_TTL_SECONDS);
      const invitation: WorkspaceInvitationV1 = {
        schemaVersion: 1,
        id: invitationId,
        workspaceId: args.workspaceId,
        normalizedEmail,
        role: requestedRole,
        status: "pending",
        tokenHash,
        expiresAt,
        createdAt: now,
        updatedAt: now,
        invitedByUserId: args.uid,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
        revokedByUserId: null,
        deliveryVersion: 1,
        lastDeliveryAttemptAt: null,
        lastDeliveryStatus: null,
        lastDeliveryVersion: null,
        providerMessageId: null,
      };
      tx.create(invitationRef, invitation);

      const guard: WorkspaceInvitationKeyV1 = { workspaceId: args.workspaceId, normalizedEmail, currentInvitationId: invitationId, updatedAt: now };
      tx.set(guardRef, guard, { merge: false });

      return { kind: "created", invitation };
    });
  } catch (err) {
    logger.warn("[firestore/workspaceInvitations] Invitation creation transaction failed", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "create_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "role_target_forbidden":
      return { status: "role_target_forbidden" };
    case "duplicate_live_invitation":
      return { status: "duplicate_live_invitation" };
    case "workspace_member_capacity_reached":
      return { status: "workspace_member_capacity_reached" };
    case "state_corruption":
      return { status: "state_corruption" };
    case "created":
      return {
        status: "created",
        invitationId: txResult.invitation.id,
        workspaceId: txResult.invitation.workspaceId,
        normalizedEmail: txResult.invitation.normalizedEmail,
        role: txResult.invitation.role,
        expiresAt: txResult.invitation.expiresAt,
        deliveryVersion: txResult.invitation.deliveryVersion,
        rawToken,
      };
  }
}

// ==================================================================
// RESEND
// ==================================================================

export type ResendWorkspaceInvitationResult =
  | {
      status: "resent";
      invitationId: string;
      workspaceId: string;
      normalizedEmail: string;
      role: WorkspaceInvitationRole;
      expiresAt: Timestamp;
      deliveryVersion: number;
      rawToken: string;
    }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "invalid_delivery_version" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "role_target_forbidden" }
  | { status: "invitation_not_found" }
  | { status: "invalid_state" }
  | { status: "stale_superseded" }
  | { status: "invitation_version_conflict" }
  | { status: "state_corruption" }
  | { status: "resend_failed" };

export async function resendWorkspaceInvitation(args: { uid: string; workspaceId: string; invitationId: string; expectedDeliveryVersion: unknown }): Promise<ResendWorkspaceInvitationResult> {
  if (!isPositiveInteger(args.expectedDeliveryVersion)) {
    return { status: "invalid_delivery_version" };
  }
  const expectedDeliveryVersion = args.expectedDeliveryVersion;

  if (!isTargetWorkspaceAdmitted(args.uid, args.workspaceId)) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const rawToken = generateWorkspaceInvitationToken();
  const tokenHash = hashWorkspaceInvitationToken(rawToken);

  type TxResult =
    | { kind: "resent"; invitation: WorkspaceInvitationV1 }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "role_target_forbidden" }
    | { kind: "invitation_not_found" }
    | { kind: "invalid_state" }
    | { kind: "stale_superseded" }
    | { kind: "invitation_version_conflict" }
    | { kind: "state_corruption" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "members.invite" });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      const invitationRef = adminDb!.collection("workspaceInvitations").doc(args.invitationId);
      const invitationSnap = await tx.get(invitationRef);
      if (!invitationSnap.exists) {
        return { kind: "invitation_not_found" };
      }
      const invitationData = invitationSnap.data();
      if (!isWellFormedWorkspaceInvitationV1(invitationData) || invitationData.id !== args.invitationId || invitationData.workspaceId !== args.workspaceId) {
        return { kind: "invitation_not_found" };
      }

      if (invitationData.status !== "pending") {
        return { kind: "invalid_state" };
      }

      const guardKey = computeWorkspaceInvitationKey(invitationData.workspaceId, invitationData.normalizedEmail);
      const guardRef = adminDb!.collection("workspaceInvitationKeys").doc(guardKey);
      const guardSnap = await tx.get(guardRef);
      if (!guardSnap.exists) {
        return { kind: "state_corruption" };
      }
      const guardData = guardSnap.data();
      if (!isWellFormedWorkspaceInvitationKeyV1(guardData) || guardData.workspaceId !== invitationData.workspaceId || guardData.normalizedEmail !== invitationData.normalizedEmail) {
        return { kind: "state_corruption" };
      }
      if (guardData.currentInvitationId !== args.invitationId) {
        return { kind: "stale_superseded" };
      }

      if (invitationData.deliveryVersion !== expectedDeliveryVersion) {
        return { kind: "invitation_version_conflict" };
      }

      if (!canManageInvitationTargetRole({ callerRole: auth.membership.role, targetRole: invitationData.role })) {
        return { kind: "role_target_forbidden" };
      }

      const now = Timestamp.now();
      const expiresAt = addSeconds(now, INVITATION_TTL_SECONDS);
      const nextVersion = invitationData.deliveryVersion + 1;
      const updates = { tokenHash, expiresAt, updatedAt: now, deliveryVersion: nextVersion };
      tx.update(invitationRef, updates);

      return { kind: "resent", invitation: { ...invitationData, ...updates } };
    });
  } catch (err) {
    logger.warn("[firestore/workspaceInvitations] Invitation resend transaction failed", { workspaceId: args.workspaceId, invitationId: args.invitationId, error: err instanceof Error ? err.message : String(err) });
    return { status: "resend_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "role_target_forbidden":
      return { status: "role_target_forbidden" };
    case "invitation_not_found":
      return { status: "invitation_not_found" };
    case "invalid_state":
      return { status: "invalid_state" };
    case "stale_superseded":
      return { status: "stale_superseded" };
    case "invitation_version_conflict":
      return { status: "invitation_version_conflict" };
    case "state_corruption":
      return { status: "state_corruption" };
    case "resent":
      return {
        status: "resent",
        invitationId: txResult.invitation.id,
        workspaceId: txResult.invitation.workspaceId,
        normalizedEmail: txResult.invitation.normalizedEmail,
        role: txResult.invitation.role,
        expiresAt: txResult.invitation.expiresAt,
        deliveryVersion: txResult.invitation.deliveryVersion,
        rawToken,
      };
  }
}

// ==================================================================
// REVOKE
// ==================================================================

export type RevokeWorkspaceInvitationResult =
  | { status: "revoked"; invitationId: string }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "invalid_delivery_version" }
  | { status: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
  | { status: "role_target_forbidden" }
  | { status: "invitation_not_found" }
  | { status: "state_corruption" }
  | { status: "stale_superseded" }
  | { status: "invitation_version_conflict" }
  | { status: "invalid_state_for_revoke" }
  | { status: "revoke_failed" };

export async function revokeWorkspaceInvitation(args: { uid: string; workspaceId: string; invitationId: string; expectedDeliveryVersion: unknown }): Promise<RevokeWorkspaceInvitationResult> {
  if (!isPositiveInteger(args.expectedDeliveryVersion)) {
    return { status: "invalid_delivery_version" };
  }
  const expectedDeliveryVersion = args.expectedDeliveryVersion;

  if (!isTargetWorkspaceAdmitted(args.uid, args.workspaceId)) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  type TxResult =
    | { kind: "revoked"; invitationId: string }
    | { kind: "already_revoked"; invitationId: string }
    | { kind: "unauthorized"; reason: TeamMutationAuthorizationDenialReason }
    | { kind: "role_target_forbidden" }
    | { kind: "invitation_not_found" }
    | { kind: "state_corruption" }
    | { kind: "stale_superseded" }
    | { kind: "invitation_version_conflict" }
    | { kind: "invalid_state_for_revoke" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const auth = await authorizeTeamWorkspaceMutationInTransaction(tx, { uid: args.uid, workspaceId: args.workspaceId, requiredCapability: "members.manage" });
      if (!auth.ok) {
        return { kind: "unauthorized", reason: auth.reason };
      }

      const invitationRef = adminDb!.collection("workspaceInvitations").doc(args.invitationId);
      const invitationSnap = await tx.get(invitationRef);
      if (!invitationSnap.exists) {
        return { kind: "invitation_not_found" };
      }
      const invitationData = invitationSnap.data();
      if (!isWellFormedWorkspaceInvitationV1(invitationData) || invitationData.id !== args.invitationId || invitationData.workspaceId !== args.workspaceId) {
        return { kind: "invitation_not_found" };
      }

      const guardKey = computeWorkspaceInvitationKey(invitationData.workspaceId, invitationData.normalizedEmail);
      const guardRef = adminDb!.collection("workspaceInvitationKeys").doc(guardKey);
      const guardSnap = await tx.get(guardRef);
      if (!guardSnap.exists) {
        return { kind: "state_corruption" };
      }
      const guardData = guardSnap.data();
      if (!isWellFormedWorkspaceInvitationKeyV1(guardData) || guardData.workspaceId !== invitationData.workspaceId || guardData.normalizedEmail !== invitationData.normalizedEmail) {
        return { kind: "state_corruption" };
      }
      if (guardData.currentInvitationId !== args.invitationId) {
        return { kind: "stale_superseded" };
      }

      if (invitationData.deliveryVersion !== expectedDeliveryVersion) {
        return { kind: "invitation_version_conflict" };
      }

      if (!canManageInvitationTargetRole({ callerRole: auth.membership.role, targetRole: invitationData.role })) {
        return { kind: "role_target_forbidden" };
      }

      if (invitationData.status === "accepted") {
        return { kind: "invalid_state_for_revoke" };
      }
      if (invitationData.status === "revoked") {
        // Idempotent success — this invitation is still the guard's current
        // target (already confirmed above). No capacity read/write here:
        // an already-revoked invitation's reservation was already released
        // on its FIRST revoke; a second decrement would underflow.
        return { kind: "already_revoked", invitationId: invitationData.id };
      }

      // First pending -> revoked transition: this invitation was counted
      // as a reservation whether live or expired (Phase 10A.4 state-based
      // model) — release exactly once, in the SAME transaction as the
      // status write below. A capacity failure aborts the whole revoke:
      // the invitation stays pending, nothing partially transitions.
      if (isWorkspaceCapacityControlled(args.workspaceId)) {
        const release = await releaseTeamWorkspaceCanarySlot(tx, args.workspaceId);
        if (release.status !== "released") {
          return { kind: "state_corruption" };
        }
      }

      const now = Timestamp.now();
      tx.update(invitationRef, { status: "revoked", revokedAt: now, revokedByUserId: args.uid, updatedAt: now });
      return { kind: "revoked", invitationId: invitationData.id };
    });
  } catch (err) {
    logger.warn("[firestore/workspaceInvitations] Invitation revoke transaction failed", { workspaceId: args.workspaceId, invitationId: args.invitationId, error: err instanceof Error ? err.message : String(err) });
    return { status: "revoke_failed" };
  }

  switch (txResult.kind) {
    case "unauthorized":
      return { status: "unauthorized", reason: txResult.reason };
    case "role_target_forbidden":
      return { status: "role_target_forbidden" };
    case "invitation_not_found":
      return { status: "invitation_not_found" };
    case "state_corruption":
      return { status: "state_corruption" };
    case "stale_superseded":
      return { status: "stale_superseded" };
    case "invitation_version_conflict":
      return { status: "invitation_version_conflict" };
    case "invalid_state_for_revoke":
      return { status: "invalid_state_for_revoke" };
    case "revoked":
    case "already_revoked":
      return { status: "revoked", invitationId: txResult.invitationId };
  }
}

// ==================================================================
// ACCEPT
// ==================================================================

export type AcceptWorkspaceInvitationResult =
  | { status: "accepted"; invitationId: string; workspaceId: string; role: WorkspaceInvitationRole; membershipId: string; alreadyMember: boolean; effectiveRole: WorkspaceMembershipRole }
  | { status: "firestore_unavailable" }
  | { status: "invalid_input" }
  | { status: "email_verification_required" }
  | { status: "auth_lookup_failed" }
  | { status: "invitation_invalid_or_expired" }
  | { status: "invitation_email_mismatch" }
  | { status: "state_corruption" }
  | { status: "accept_failed" };

/**
 * Acceptance credentials are `invitationId` + `rawToken` — never a
 * collection-wide `tokenHash` query. `uid` is the ALREADY-authenticated
 * caller (the future 8D.2 route resolves this via the existing session/
 * bearer-token boundary before calling this function; this helper assumes
 * it, never re-derives it). `resolveRequestIdentity()` is never modified
 * or broadened — the authoritative account email comes from
 * `adminAuth.getUser(uid)` directly, a narrow, acceptance-local lookup.
 *
 * Phase 10B.2 reorders the transaction body (Phase 10A.2/10A.4's frozen
 * design) so that:
 *   - `workspaceId` is NEVER accepted from the caller — it is derived
 *     exclusively from the stored invitation document, inside the
 *     transaction, at the point it's first read (step 1) — never earlier,
 *     never from any request field.
 *   - the verified email match (step in the middle of the transaction, at
 *     the position marked below) happens BEFORE target-Workspace
 *     admission is evaluated, so a wrong-email caller's response can
 *     never differ based on whether the target Workspace happens to be
 *     canary-admitted — closing that oracle.
 *   - target-Workspace admission denial maps to the SAME generic
 *     `invitation_invalid_or_expired` concealed result as every other
 *     invitation-invalid case — never a distinguishable
 *     `team_workspaces_disabled`, which no longer exists as a possible
 *     result of this function at all (the old USER-only pre-transaction
 *     gate is removed, not merely relocated).
 */
export async function acceptWorkspaceInvitation(args: { uid: string; invitationId: unknown; rawToken: unknown }): Promise<AcceptWorkspaceInvitationResult> {
  if (typeof args.invitationId !== "string" || args.invitationId.length === 0) {
    return { status: "invalid_input" };
  }
  if (typeof args.rawToken !== "string" || args.rawToken.length === 0) {
    return { status: "invalid_input" };
  }
  const invitationId = args.invitationId;
  const rawToken = args.rawToken;

  // Firebase Auth lookup happens BEFORE the Firestore transaction — see
  // module doc comment. `users/{uid}.email` (mutable, Firestore-mirrored)
  // is never used as the authorization proof.
  if (!adminAuth) {
    return { status: "auth_lookup_failed" };
  }
  let verifiedEmail: string;
  try {
    const userRecord = await adminAuth.getUser(args.uid);
    if (typeof userRecord.email !== "string" || userRecord.email.length === 0 || userRecord.emailVerified !== true) {
      return { status: "email_verification_required" };
    }
    const normalized = normalizeInvitationEmail(userRecord.email);
    if (!normalized.ok) {
      return { status: "email_verification_required" };
    }
    verifiedEmail = normalized.normalizedEmail;
  } catch {
    return { status: "auth_lookup_failed" };
  }

  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  type TxResult =
    | { kind: "accepted"; invitationId: string; workspaceId: string; role: WorkspaceInvitationRole; membershipId: string; alreadyMember: boolean; effectiveRole: WorkspaceMembershipRole }
    | { kind: "invitation_invalid_or_expired" }
    | { kind: "invitation_email_mismatch" }
    | { kind: "state_corruption" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      // 1. Invitation.
      const invitationRef = adminDb!.collection("workspaceInvitations").doc(invitationId);
      const invitationSnap = await tx.get(invitationRef);
      if (!invitationSnap.exists) {
        return { kind: "invitation_invalid_or_expired" };
      }
      const invitationData = invitationSnap.data();
      if (!isWellFormedWorkspaceInvitationV1(invitationData) || invitationData.id !== invitationId) {
        return { kind: "invitation_invalid_or_expired" };
      }
      if (invitationData.status !== "pending") {
        return { kind: "invitation_invalid_or_expired" };
      }
      if (invitationData.expiresAt.toMillis() <= Timestamp.now().toMillis()) {
        return { kind: "invitation_invalid_or_expired" };
      }
      if (!verifyWorkspaceInvitationToken({ rawToken, storedTokenHash: invitationData.tokenHash })) {
        return { kind: "invitation_invalid_or_expired" };
      }

      // 2. Guard.
      const guardKey = computeWorkspaceInvitationKey(invitationData.workspaceId, invitationData.normalizedEmail);
      const guardRef = adminDb!.collection("workspaceInvitationKeys").doc(guardKey);
      const guardSnap = await tx.get(guardRef);
      if (!guardSnap.exists) {
        return { kind: "invitation_invalid_or_expired" };
      }
      const guardData = guardSnap.data();
      if (!isWellFormedWorkspaceInvitationKeyV1(guardData) || guardData.workspaceId !== invitationData.workspaceId || guardData.normalizedEmail !== invitationData.normalizedEmail) {
        return { kind: "invitation_invalid_or_expired" };
      }
      if (guardData.currentInvitationId !== invitationId) {
        return { kind: "invitation_invalid_or_expired" };
      }

      // 3. Verified email match — deliberately BEFORE target-Workspace
      // admission (step 4) so a wrong-email caller's response is
      // identical regardless of the target Workspace's canary state.
      if (verifiedEmail !== invitationData.normalizedEmail) {
        return { kind: "invitation_email_mismatch" };
      }

      // 4. Target-Workspace Team admission — workspaceId derived ONLY
      // from the invitation document just read above, never from any
      // caller-supplied field. Denial is concealed identically to every
      // other invitation-invalid case, never a distinguishable
      // team_workspaces_disabled.
      if (!isTargetWorkspaceAdmitted(args.uid, invitationData.workspaceId)) {
        return { kind: "invitation_invalid_or_expired" };
      }

      // 5. Workspace.
      const workspaceRef = adminDb!.collection("workspaces").doc(invitationData.workspaceId);
      const workspaceSnap = await tx.get(workspaceRef);
      if (!workspaceSnap.exists) {
        return { kind: "invitation_invalid_or_expired" };
      }
      const workspaceData = workspaceSnap.data();
      if (!isWellFormedWorkspaceV1(workspaceData) || workspaceData.id !== invitationData.workspaceId || workspaceData.type !== "team") {
        return { kind: "invitation_invalid_or_expired" };
      }
      const workspace = workspaceData as TeamWorkspaceV1;

      // 6. Owner-membership integrity.
      const ownerMembershipId = computeMembershipId(workspace.id, workspace.ownerUserId);
      const ownerRef = adminDb!.collection("workspaceMemberships").doc(ownerMembershipId);
      const ownerSnap = await tx.get(ownerRef);
      if (!ownerSnap.exists) {
        return { kind: "invitation_invalid_or_expired" };
      }
      const ownerMembership = validateMembershipBinding(ownerSnap.data(), { workspaceId: workspace.id, uid: workspace.ownerUserId });
      if (!ownerMembership || !isCanonicalTeamOwnerMembership({ workspace, membership: ownerMembership })) {
        return { kind: "invitation_invalid_or_expired" };
      }

      // 7. Caller's own membership — read-only classification, no write
      // staged yet (capacity's own reads, step 8, must still precede
      // every write in this transaction).
      const membershipId = computeMembershipId(invitationData.workspaceId, args.uid);
      const membershipRef = args.uid === workspace.ownerUserId ? ownerRef : adminDb!.collection("workspaceMemberships").doc(membershipId);
      const membershipSnap = args.uid === workspace.ownerUserId ? ownerSnap : await tx.get(membershipRef);

      let effectiveRole: WorkspaceMembershipRole;
      let alreadyMember = false;
      let membershipWrite: "reactivate" | "create" | "none";

      if (membershipSnap.exists) {
        const existing = validateMembershipBinding(membershipSnap.data(), { workspaceId: invitationData.workspaceId, uid: args.uid });
        if (!existing) {
          return { kind: "state_corruption" };
        }
        if (existing.status === "active") {
          alreadyMember = true;
          effectiveRole = existing.role;
          membershipWrite = "none"; // No membership mutation — role is never silently changed.
        } else {
          // status === "removed" — reactivate. createdAt PRESERVED.
          effectiveRole = invitationData.role;
          membershipWrite = "reactivate";
        }
      } else {
        effectiveRole = invitationData.role;
        membershipWrite = "create";
      }

      // 8. Capacity adjustment. A valid reserved invitation already owns
      // its seat (Phase 10A.4): new-membership and reactivation are
      // ALWAYS delta 0 and never consult capacity at all — a reserved
      // invitation must be acceptable even at/above the cap. Only the
      // already-active branch releases a redundant reservation (-1),
      // exactly once, in the SAME transaction as the writes below. A
      // capacity failure here aborts the whole acceptance atomically: no
      // membership mutation, no invitation mutation, no capacity mutation.
      if (alreadyMember && isWorkspaceCapacityControlled(invitationData.workspaceId)) {
        const release = await releaseTeamWorkspaceCanarySlot(tx, invitationData.workspaceId);
        if (release.status !== "released") {
          return { kind: "state_corruption" };
        }
      }

      // 9. Stage writes — all reads (including capacity's own) are complete.
      const now = Timestamp.now();
      if (membershipWrite === "reactivate") {
        tx.update(membershipRef, {
          status: "active",
          role: invitationData.role,
          updatedAt: now,
          invitedByUserId: invitationData.invitedByUserId,
          removedAt: null,
          removedByUserId: null,
        });
      } else if (membershipWrite === "create") {
        const newMembership: WorkspaceMembershipV1 = {
          schemaVersion: 1,
          id: membershipId,
          workspaceId: invitationData.workspaceId,
          uid: args.uid,
          role: invitationData.role,
          status: "active",
          createdAt: now,
          updatedAt: now,
          invitedByUserId: invitationData.invitedByUserId,
          removedAt: null,
          removedByUserId: null,
        };
        tx.create(membershipRef, newMembership);
      }

      tx.update(invitationRef, { status: "accepted", acceptedAt: now, acceptedByUserId: args.uid, updatedAt: now });

      return { kind: "accepted", invitationId, workspaceId: invitationData.workspaceId, role: invitationData.role, membershipId, alreadyMember, effectiveRole };
    });
  } catch (err) {
    logger.warn("[firestore/workspaceInvitations] Invitation acceptance transaction failed", { invitationId, error: err instanceof Error ? err.message : String(err) });
    return { status: "accept_failed" };
  }

  switch (txResult.kind) {
    case "invitation_invalid_or_expired":
      return { status: "invitation_invalid_or_expired" };
    case "invitation_email_mismatch":
      return { status: "invitation_email_mismatch" };
    case "state_corruption":
      return { status: "state_corruption" };
    case "accepted":
      return {
        status: "accepted",
        invitationId: txResult.invitationId,
        workspaceId: txResult.workspaceId,
        role: txResult.role,
        membershipId: txResult.membershipId,
        alreadyMember: txResult.alreadyMember,
        effectiveRole: txResult.effectiveRole,
      };
  }
}

// ==================================================================
// LIST — current/actionable administrative view only.
// ==================================================================

export interface WorkspaceInvitationListItemV1 {
  id: string;
  normalizedEmail: string;
  role: WorkspaceInvitationRole;
  status: "pending";
  isExpired: boolean;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  invitedByUserId: string;
  deliveryVersion: number;
  lastDeliveryAttemptAt: Timestamp | null;
  lastDeliveryStatus: WorkspaceInvitationDeliveryStatus | null;
  lastDeliveryVersion: number | null;
}

export type ListWorkspaceInvitationsResult =
  | { status: "listed"; invitations: WorkspaceInvitationListItemV1[] }
  | { status: "team_workspaces_disabled" }
  | { status: "firestore_unavailable" }
  | { status: "workspace_not_found" }
  | { status: "workspace_malformed" }
  | { status: "membership_not_found" }
  | { status: "membership_removed" }
  | { status: "membership_malformed" }
  | { status: "owner_integrity_violation" }
  | { status: "lookup_failed" }
  | { status: "insufficient_capability" }
  | { status: "state_corruption" };

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/**
 * Derives currentness from `workspaceInvitationKeys.currentInvitationId`
 * (the SAME authority resend/revoke defer to) — never from
 * `invitation.status` alone, which would incorrectly resurface historical
 * superseded-but-still-`pending`-flagged rows. See module doc comment.
 */
export async function listWorkspaceInvitations(args: { uid: string; workspaceId: string }): Promise<ListWorkspaceInvitationsResult> {
  if (!isTargetWorkspaceAdmitted(args.uid, args.workspaceId)) {
    return { status: "team_workspaces_disabled" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  // NOTE (Phase 10B.2 scope boundary): `resolveWorkspaceAccess()` below
  // still performs its OWN internal user-scoped `resolveTeamWorkspacesMode()`
  // gate (Phase 10B.3's responsibility, not this phase's) — so a
  // Workspace-canary-only (non-uid-canary) caller who now passes the
  // target-admission check above will still be denied by that inner gate
  // today, via the SAME `team_workspaces_disabled` reason this function's
  // own switch below already maps to the same concealed response. This
  // migration does not yet GRANT list access to such a caller; it only
  // means the outer gate is no longer the thing blocking them, and fixes
  // this outer path onto the reviewed target-admission primitive ahead of
  // Phase 10B.3.

  const access = await resolveWorkspaceAccess({ uid: args.uid, workspaceId: args.workspaceId });
  if (!access.granted) {
    switch (access.reason) {
      case "workspace_not_found":
        return { status: "workspace_not_found" };
      case "workspace_malformed":
        return { status: "workspace_malformed" };
      case "lookup_failed":
        return { status: "lookup_failed" };
      case "not_owner":
        // Personal-mode denial — invitations are Team-only; concealed identically to workspace_not_found.
        return { status: "workspace_not_found" };
      case "team_workspaces_disabled":
        return { status: "team_workspaces_disabled" };
      case "membership_not_found":
        return { status: "membership_not_found" };
      case "membership_removed":
        return { status: "membership_removed" };
      case "membership_malformed":
        return { status: "membership_malformed" };
      case "owner_integrity_violation":
        return { status: "owner_integrity_violation" };
    }
  }
  if (access.workspaceType === "personal") {
    // Invitations are Team-only; a Personal Workspace has no membership/capability model to evaluate.
    return { status: "workspace_not_found" };
  }
  if (!access.capabilities.includes("members.read")) {
    return { status: "insufficient_capability" };
  }

  let guardQuerySnap;
  try {
    guardQuerySnap = await adminDb.collection("workspaceInvitationKeys").where("workspaceId", "==", args.workspaceId).get();
  } catch {
    return { status: "lookup_failed" };
  }

  if (guardQuerySnap.empty) {
    return { status: "listed", invitations: [] };
  }

  const guards: WorkspaceInvitationKeyV1[] = [];
  for (const doc of guardQuerySnap.docs) {
    const data = doc.data();
    if (!isWellFormedWorkspaceInvitationKeyV1(data) || data.workspaceId !== args.workspaceId) {
      return { status: "state_corruption" };
    }
    guards.push(data);
  }

  const invitationSnaps: FirebaseFirestore.DocumentSnapshot[] = [];
  try {
    for (const batch of chunk(guards, 10)) {
      const refs = batch.map((g) => adminDb!.collection("workspaceInvitations").doc(g.currentInvitationId));
      const snaps = await adminDb.getAll(...refs);
      invitationSnaps.push(...snaps);
    }
  } catch {
    return { status: "lookup_failed" };
  }

  const now = Timestamp.now();
  const items: WorkspaceInvitationListItemV1[] = [];
  for (let i = 0; i < guards.length; i++) {
    const guard = guards[i];
    const snap = invitationSnaps[i];
    if (!snap.exists) {
      return { status: "state_corruption" };
    }
    const data = snap.data();
    if (!isWellFormedWorkspaceInvitationV1(data) || data.id !== guard.currentInvitationId || data.workspaceId !== args.workspaceId || data.normalizedEmail !== guard.normalizedEmail) {
      return { status: "state_corruption" };
    }
    if (data.status !== "pending") {
      continue; // current accepted/revoked invitations are valid guard states but not actionable — omitted.
    }
    items.push({
      id: data.id,
      normalizedEmail: data.normalizedEmail,
      role: data.role,
      status: "pending",
      isExpired: data.expiresAt.toMillis() <= now.toMillis(),
      expiresAt: data.expiresAt,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      invitedByUserId: data.invitedByUserId,
      deliveryVersion: data.deliveryVersion,
      lastDeliveryAttemptAt: data.lastDeliveryAttemptAt,
      lastDeliveryStatus: data.lastDeliveryStatus,
      lastDeliveryVersion: data.lastDeliveryVersion,
    });
  }

  items.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  return { status: "listed", invitations: items };
}
