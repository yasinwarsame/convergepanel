/**
 * Team Video Verification read/dedup validation, Phase 8C-E.3.3.1 —
 * structural mirror of `lib/workspaces/teamClaimVerificationRowValidation.ts`,
 * adapted for the `videoVerifications` collection's own `type` discriminator.
 *
 * Pure, zero I/O — the caller supplies one already-fetched Firestore
 * document's data (either from the shared detail-read route or a Team
 * dedup candidate). Team has no historical missing-`projectId`
 * compatibility debt (Personal Video rows never have a
 * `workspaceId`/`projectId` field at all) — so `absent` and `malformed`
 * `projectId` states both collapse to a validation failure here, exactly
 * like the Claim validator's own documented rationale.
 *
 * Deliberately NOT shared with the Claim validator and NOT a full Video
 * result schema validator — see Phase 8C-E.3.0 §54: a little duplication
 * of these four binding-field checks is safer than reopening
 * already-Production-safe Claim code for abstraction aesthetics.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { classifyProjectIdFieldState } from "@/lib/projects/runProjectNormalizationEligibility";

export type TeamVideoVerificationRowValidationResult =
  | { ok: true; userId: string; workspaceId: string; projectId: string | null }
  | { ok: false };

/**
 * Validates: `userId` (non-empty string), `workspaceId` (non-empty
 * string, exactly equal to the caller-supplied expected Workspace id —
 * never merely "some workspace"), `type` (must be exactly
 * `"video_verification"`), `timestamp` (a genuine `firebase-admin/firestore`
 * `Timestamp` instance, never blind-cast), and `projectId` (must be
 * exactly `null` or a valid assigned string — `absent`/`malformed` both
 * fail closed).
 */
export function validateTeamVideoVerificationRowShape(data: Record<string, unknown>, expectedWorkspaceId: string): TeamVideoVerificationRowValidationResult {
  if (typeof data.userId !== "string" || data.userId.length === 0) {
    return { ok: false };
  }
  if (typeof data.workspaceId !== "string" || data.workspaceId.length === 0 || data.workspaceId !== expectedWorkspaceId) {
    return { ok: false };
  }
  if (data.type !== "video_verification") {
    return { ok: false };
  }
  if (!(data.timestamp instanceof Timestamp)) {
    return { ok: false };
  }

  const hasProjectIdField = Object.prototype.hasOwnProperty.call(data, "projectId");
  const fieldState = classifyProjectIdFieldState({ hasProjectIdField, projectIdValue: data.projectId });
  switch (fieldState) {
    case "null":
      return { ok: true, userId: data.userId, workspaceId: data.workspaceId, projectId: null };
    case "assigned":
      return { ok: true, userId: data.userId, workspaceId: data.workspaceId, projectId: data.projectId as string };
    case "absent":
    case "malformed":
      return { ok: false };
  }
}
