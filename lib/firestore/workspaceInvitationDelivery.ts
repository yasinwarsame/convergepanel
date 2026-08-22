/**
 * Team Workspace Invitations, Phase 8D.1 — records the result of an
 * ALREADY-COMPLETED external email send. No provider call is made here
 * (Phase 8D.2 owns the actual Resend HTTPS integration) — this is purely
 * a version-guarded Firestore write.
 *
 * Version-guarded so a delayed/out-of-order provider response for an old
 * `deliveryVersion` can never clobber metadata that already belongs to a
 * newer resend (Phase 8D.0.2's delivery-metadata-race correction): if the
 * invitation's current `deliveryVersion` no longer matches the version
 * this specific result was for, the write is skipped entirely and
 * `stale_delivery_result` is returned — never treated as a failure of the
 * invitation itself.
 *
 * Respects the SAME Team Workspace rollout gate as every other invitation
 * operation — `resolveTeamWorkspacesMode()` /
 * `TEAM_WORKSPACES_ENABLED` / `TEAM_WORKSPACES_CANARY_UIDS` — evaluated
 * against the authenticated REQUESTER's `uid` (the future 8D.2 route's
 * own caller, e.g. the admin who triggered a resend, or the system
 * identity behind the create/resend orchestration), never against the
 * invitation's `invitedByUserId` or any other stored field. This is a
 * gate check only, exactly like every other invitation function's own
 * rollout check — it does NOT re-derive `members.invite`/`members.manage`
 * authorization, which belongs solely to the originating create/resend
 * operation. No invitation-specific rollout flag exists or is introduced
 * here (Phase 8D.0.2 froze reuse of the existing primitive for every
 * invitation Firestore operation, this one included).
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS } from "@/lib/env";
import { resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";
import { isWellFormedWorkspaceInvitationV1, WORKSPACE_INVITATION_DELIVERY_STATUSES, type WorkspaceInvitationDeliveryStatus } from "./workspaceInvitations";

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export type RecordWorkspaceInvitationDeliveryResultOutcome =
  | { status: "recorded" }
  | { status: "stale_delivery_result" }
  | { status: "team_workspaces_disabled" }
  | { status: "invalid_input" }
  | { status: "invitation_not_found" }
  | { status: "state_corruption" }
  | { status: "firestore_unavailable" }
  | { status: "record_failed" };

export async function recordWorkspaceInvitationDeliveryResult(args: {
  uid: unknown;
  invitationId: unknown;
  deliveryVersion: unknown;
  status: unknown;
  providerMessageId: unknown;
}): Promise<RecordWorkspaceInvitationDeliveryResultOutcome> {
  if (typeof args.uid !== "string" || args.uid.length === 0) {
    return { status: "invalid_input" };
  }
  if (typeof args.invitationId !== "string" || args.invitationId.length === 0) {
    return { status: "invalid_input" };
  }
  if (!isPositiveInteger(args.deliveryVersion)) {
    return { status: "invalid_input" };
  }
  if (typeof args.status !== "string" || !WORKSPACE_INVITATION_DELIVERY_STATUSES.includes(args.status as WorkspaceInvitationDeliveryStatus)) {
    return { status: "invalid_input" };
  }
  if (!(args.providerMessageId === null || (typeof args.providerMessageId === "string" && args.providerMessageId.length > 0))) {
    return { status: "invalid_input" };
  }

  const uid = args.uid;
  const invitationId = args.invitationId;
  const deliveryVersion = args.deliveryVersion;
  const deliveryStatus = args.status as WorkspaceInvitationDeliveryStatus;
  const providerMessageId = args.providerMessageId as string | null;

  // Rollout gate, evaluated before ANY Firestore access — same primitive,
  // same env vars, same convention as every other invitation operation.
  const rollout = resolveTeamWorkspacesMode({ uid, globalEnabled: TEAM_WORKSPACES_ENABLED, canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS });
  if (!rollout.enabled) {
    return { status: "team_workspaces_disabled" };
  }

  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  type TxResult = { kind: "recorded" } | { kind: "stale" } | { kind: "not_found" } | { kind: "state_corruption" };

  let txResult: TxResult;
  try {
    txResult = await adminDb.runTransaction<TxResult>(async (tx) => {
      const invitationRef = adminDb!.collection("workspaceInvitations").doc(invitationId);
      const snap = await tx.get(invitationRef);
      if (!snap.exists) {
        return { kind: "not_found" };
      }
      const data = snap.data();
      if (!isWellFormedWorkspaceInvitationV1(data) || data.id !== invitationId) {
        return { kind: "state_corruption" };
      }
      if (data.deliveryVersion !== deliveryVersion) {
        return { kind: "stale" };
      }

      const now = Timestamp.now();
      tx.update(invitationRef, {
        lastDeliveryAttemptAt: now,
        lastDeliveryStatus: deliveryStatus,
        lastDeliveryVersion: deliveryVersion,
        providerMessageId,
      });
      return { kind: "recorded" };
    });
  } catch (err) {
    logger.warn("[firestore/workspaceInvitationDelivery] Delivery-result recording transaction failed", { invitationId, error: err instanceof Error ? err.message : String(err) });
    return { status: "record_failed" };
  }

  switch (txResult.kind) {
    case "not_found":
      return { status: "invitation_not_found" };
    case "state_corruption":
      return { status: "state_corruption" };
    case "stale":
      return { status: "stale_delivery_result" };
    case "recorded":
      return { status: "recorded" };
  }
}
