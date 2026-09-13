/**
 * ADD-TO-TEAM-PROJECT §L — immutable provenance for a Team run that was
 * created as a SNAPSHOT of a Personal research run.
 *
 * Shape follows the one existing cross-artifact pointer in this schema,
 * `ClaimVerificationOrigin` (`{type, runId, claimId}` on verifications):
 * a discriminated `type`, the source pointer, and ONLY the point-in-time
 * facts that have no other canonical home. The source's own `createdAt`/
 * `completedAt` qualify — the snapshot's own timestamps are fresh Team
 * timestamps, so without these two the original research date would be
 * lost. Deliberately NOT stored here: the source owner uid (it equals the
 * snapshot's own `userId`, which is the canonical home), the destination
 * `workspaceId`/`projectId`/`createdAt` (all first-class on the run
 * document). Duplicating any of those would create a second copy that
 * could drift from the authoritative one; this type cannot express it.
 *
 * Written ONLY inside the snapshot primitive's `tx.create()` — never as a
 * second write. A Team run without a well-formed `origin` was never
 * created through that primitive (Phase 4C: absence of best-effort state
 * proves nothing, so provenance must be structurally inseparable from the
 * artifact it describes).
 */

import { Timestamp } from "firebase-admin/firestore";

export const PERSONAL_RESEARCH_SNAPSHOT_ORIGIN_TYPE = "personal_research" as const;

export interface PersonalResearchSnapshotOriginV1 {
  type: typeof PERSONAL_RESEARCH_SNAPSHOT_ORIGIN_TYPE;
  /** The Personal source run id. Never mutated, never re-resolved for authorization. */
  runId: string;
  /** The source run's own `createdAt`, copied verbatim at snapshot time. */
  sourceCreatedAt: Timestamp;
  /** The source run's own `completedAt`, or `null` when the source carried none (older complete runs). */
  sourceCompletedAt: Timestamp | null;
}

/**
 * Pure. Returns `null` when the source's `createdAt` is not a genuine
 * `Timestamp` — a source without a trustworthy creation instant cannot
 * yield trustworthy provenance, and the caller conceals it as
 * `source_not_found` rather than fabricating a date.
 */
export function buildPersonalResearchSnapshotOrigin(args: {
  sourceRunId: string;
  sourceCreatedAt: unknown;
  sourceCompletedAt: unknown;
}): PersonalResearchSnapshotOriginV1 | null {
  if (typeof args.sourceRunId !== "string" || args.sourceRunId.length === 0) return null;
  if (!(args.sourceCreatedAt instanceof Timestamp)) return null;
  const completed = args.sourceCompletedAt instanceof Timestamp ? args.sourceCompletedAt : null;
  return {
    type: PERSONAL_RESEARCH_SNAPSHOT_ORIGIN_TYPE,
    runId: args.sourceRunId,
    sourceCreatedAt: args.sourceCreatedAt,
    sourceCompletedAt: completed,
  };
}

/**
 * Pure structural check used when an existing snapshot is re-read through
 * the idempotency lock: the stored run must genuinely be a snapshot of the
 * EXPECTED source, not merely some run that happens to sit in the target
 * Project. `expectedSourceRunId` is required — an origin check that does
 * not pin the source is not a provenance check.
 */
export function isWellFormedPersonalResearchSnapshotOrigin(value: unknown, expectedSourceRunId: string): value is PersonalResearchSnapshotOriginV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.type !== PERSONAL_RESEARCH_SNAPSHOT_ORIGIN_TYPE) return false;
  if (typeof v.runId !== "string" || v.runId.length === 0) return false;
  if (v.runId !== expectedSourceRunId) return false;
  if (!(v.sourceCreatedAt instanceof Timestamp)) return false;
  if (!(v.sourceCompletedAt === null || v.sourceCompletedAt instanceof Timestamp)) return false;
  return true;
}
