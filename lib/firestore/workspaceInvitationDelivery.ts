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
 * Respects the SAME target-Workspace Team admission every other
 * invitation operation now uses (Phase 10B.2) —
 * `resolveTeamWorkspaceTargetAdmission()` — evaluated against the
 * authenticated REQUESTER's `uid` (the route's own caller, e.g. the admin
 * who triggered a resend, or the system identity behind the create/resend
 * orchestration) AND the invitation's own canonical `workspaceId`, never
 * against `invitedByUserId` or any other stored field. This is a gate
 * check only, exactly like every other invitation function's own
 * admission check — it does NOT re-derive `members.invite`/
 * `members.manage` authorization, which belongs solely to the originating
 * create/resend operation.
 *
 * `workspaceId` is derived from the invitation document this function
 * ALREADY reads for its own `deliveryVersion`/OCC bookkeeping (Option B
 * of the Phase 10A.2 design closure) — never accepted as a caller-supplied
 * parameter, and never a second, separate read: admission is evaluated
 * from the SAME `tx.get()` this function always performed, just after
 * that read completes rather than before the transaction opens. This is
 * what closes the defect the Phase 10A.1/10A.2 audits identified: a
 * Workspace-scoped-only (non-uid-canary) authorized inviter could
 * previously create an invitation successfully but have this function
 * deny its own delivery-result bookkeeping, since the old check evaluated
 * only the USER-scoped resolver against the requester's `uid` alone.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { TEAM_WORKSPACES_ENABLED, TEAM_WORKSPACES_CANARY_UIDS, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS } from "@/lib/env";
import { resolveTeamWorkspaceTargetAdmission } from "@/lib/workspaces/teamWorkspaceTargetAdmission";
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

  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  type TxResult = { kind: "recorded" } | { kind: "stale" } | { kind: "not_found" } | { kind: "not_admitted" } | { kind: "state_corruption" };

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

      // Target-Workspace admission, derived from THIS SAME read's own
      // workspaceId field — no extra read, no caller-supplied workspaceId.
      const admission = resolveTeamWorkspaceTargetAdmission({
        uid,
        workspaceId: data.workspaceId,
        globalEnabled: TEAM_WORKSPACES_ENABLED,
        canaryUidsRaw: TEAM_WORKSPACES_CANARY_UIDS,
        canaryWorkspaceIdsRaw: TEAM_WORKSPACES_CANARY_WORKSPACE_IDS,
      });
      if (!admission.enabled) {
        return { kind: "not_admitted" };
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
    case "not_admitted":
      return { status: "team_workspaces_disabled" };
    case "state_corruption":
      return { status: "state_corruption" };
    case "stale":
      return { status: "stale_delivery_result" };
    case "recorded":
      return { status: "recorded" };
  }
}
