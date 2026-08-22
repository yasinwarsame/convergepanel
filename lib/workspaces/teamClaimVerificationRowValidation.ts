/**
 * Team Claim Verification read validation, Phase 8C-E.1 — structural
 * mirror of `lib/workspaces/teamRunRowValidation.ts`, adapted for the
 * `verifications` collection's actual field names (`timestamp`, not
 * `createdAt`) and its polymorphic `type` discriminator (this collection
 * is also read for Video Verification via the same shared route, keyed
 * off a `?collection=` query param — this validator only ever applies
 * when that param selects `verifications`).
 *
 * Pure, zero I/O — the caller supplies one already-fetched Firestore
 * document's data. Team has no historical missing-`projectId`
 * compatibility debt (unlike Personal Claim rows, which never have a
 * `workspaceId`/`projectId` field at all) — so `absent` and `malformed`
 * `projectId` states both collapse to a validation failure here, exactly
 * like the ordinary-run row validator's own documented rationale.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { classifyProjectIdFieldState } from "@/lib/projects/runProjectNormalizationEligibility";

export type TeamClaimVerificationRowValidationResult =
  | { ok: true; userId: string; workspaceId: string; projectId: string | null }
  | { ok: false };

/**
 * Validates: `userId` (non-empty string), `workspaceId` (non-empty
 * string, exactly equal to the caller-supplied expected Workspace id —
 * never merely "some workspace"), `type` (must be exactly
 * `"claim_verification"` — this collection is polymorphic across the
 * shared read route), `timestamp` (a genuine `firebase-admin/firestore`
 * `Timestamp` instance, never blind-cast), and `projectId` (must be
 * exactly `null` or a valid assigned string — `absent`/`malformed` both
 * fail closed).
 */
export function validateTeamClaimVerificationRowShape(data: Record<string, unknown>, expectedWorkspaceId: string): TeamClaimVerificationRowValidationResult {
  if (typeof data.userId !== "string" || data.userId.length === 0) {
    return { ok: false };
  }
  if (typeof data.workspaceId !== "string" || data.workspaceId.length === 0 || data.workspaceId !== expectedWorkspaceId) {
    return { ok: false };
  }
  if (data.type !== "claim_verification") {
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
