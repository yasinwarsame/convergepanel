/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C — Firestore persistence
 * for the adaptive `teamRuns` queue projection
 * (docs/governance-decision-receipts-design.md §21.2/§21.6).
 *
 * Deliberately a NEW, separate file from `lib/firestore/runs.ts` (which
 * concerns the `runs` collection) — this one concerns `teamRuns`, a
 * different collection with a different, non-canonical role (§20.6/§21).
 *
 * Uses TRUE creation semantics (`DocumentReference.create()`), not
 * `.set()`/`.set(..., {merge:true})` — this is the specific, mandatory
 * correction from the Step 7 Part B review: an unconditional `.set()`
 * could silently overwrite a projection AFTER its `humanReviewStatus` had
 * already been synchronized by a future Part D review write, discarding
 * that sync on a later, redundant creation attempt (e.g. a retried
 * request, or the lifecycle step running again for the same run for any
 * reason). `.create()` throws (rather than silently overwriting) when the
 * document already exists, giving atomic create-if-absent behavior with
 * no separate `.get()`-then-`.set()` read/write gap to race on at all —
 * stronger than a check-then-write pattern, not just simpler.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { AdaptiveTeamRunProjection, buildAdaptiveTeamRunProjectionId } from "@/lib/governance/adaptiveTeamReview";

export type CreateAdaptiveTeamRunProjectionResult =
  | { status: "created"; projectionId: string }
  | { status: "already_exists"; projectionId: string }
  | { status: "firestore_unavailable" }
  | { status: "write_failed" };

export async function createAdaptiveTeamRunProjection(
  projection: AdaptiveTeamRunProjection
): Promise<CreateAdaptiveTeamRunProjectionResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const projectionId = buildAdaptiveTeamRunProjectionId(projection.teamId, projection.runId);

  try {
    await adminDb.collection("teamRuns").doc(projectionId).create(projection);
    return { status: "created", projectionId };
  } catch (err: unknown) {
    // Firestore's Admin SDK surfaces "document already exists" as an
    // ALREADY_EXISTS-coded error (gRPC code 6) from .create(). This is a
    // SUCCESSFUL, idempotent outcome for this function's purpose — the
    // invariant it protects (never rewrite an existing projection) is
    // satisfied by definition when .create() itself refuses to write.
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists", projectionId };
    }
    // Metadata-only logging — never the receipt conclusion, never
    // question text, never review data. Only runId/teamId (both plain
    // identifiers, not content) and the fixed failure category.
    logger.warn("[firestore/teamRuns] Failed to create adaptive team-run projection", {
      runId: projection.runId,
      teamId: projection.teamId,
    });
    return { status: "write_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D — a raw, unparsed read
 * of an adaptive `teamRuns` projection by its deterministic ID, used by the
 * review route's authorization phase (§21.6). Deliberately returns the raw
 * `Record<string, unknown>` rather than a validated `AdaptiveTeamRunProjection`
 * — the caller (the route) is responsible for checking the specific fields
 * it needs (`adaptive === true`, `teamId`, `runId`) defensively, exactly as
 * the instruction requires ("do not rely only on the deterministic
 * document ID... check stored fields too"); a full structural parser for
 * this read-only, single-caller lookup would be more machinery than this
 * one call site needs.
 */
export type GetAdaptiveTeamRunProjectionResult =
  | { status: "found"; projection: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

export async function getAdaptiveTeamRunProjection(teamId: string, runId: string): Promise<GetAdaptiveTeamRunProjectionResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const projectionId = buildAdaptiveTeamRunProjectionId(teamId, runId);

  try {
    const snap = await adminDb.collection("teamRuns").doc(projectionId).get();
    if (!snap.exists) {
      return { status: "not_found" };
    }
    return { status: "found", projection: snap.data()! };
  } catch (err: unknown) {
    logger.warn("[firestore/teamRuns] Failed to read adaptive team-run projection", { runId, teamId });
    return { status: "read_failed" };
  }
}

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D — projection
 * synchronization AFTER a canonical human-review decision has already
 * committed (docs/governance-decision-receipts-design.md §21.9).
 * Deliberately decoupled from `submitAdaptiveHumanReview()`'s own
 * transaction — never called from inside it, never part of the same
 * atomic write — so a projection-sync problem can never affect the
 * canonical decision's own success. Uses a plain `.update()` (not a
 * transaction): the only two writers of this document are this function
 * and `createAdaptiveTeamRunProjection()` above, and by the time this runs
 * the canonical review has ALREADY committed, so there is no meaningful
 * concurrent-writer race to protect against here, unlike the canonical
 * write itself.
 *
 * Only `humanReviewStatus`/`reviewedAt`/`updatedAt` are written — the full
 * comment and conditions are NEVER stored in `teamRuns`; they remain
 * canonical only in `governanceRecord.humanReview`.
 *
 * If the projection document doesn't exist (e.g. it was never created, or
 * was somehow removed), this returns `"not_found"` rather than creating
 * one — a review-sync call is not the place to backfill a missing
 * projection (§21.8's own fail-closed table: the projection must already
 * exist from the eligibility-routing lifecycle, Part C).
 */
export type SyncAdaptiveTeamRunProjectionResult =
  | { status: "synced" }
  | { status: "not_found" }
  | { status: "firestore_unavailable" }
  | { status: "write_failed" };

export async function syncAdaptiveTeamRunProjectionAfterReview(args: {
  teamId: string;
  runId: string;
  humanReviewStatus: AdaptiveTeamRunProjection["humanReviewStatus"];
  reviewedAt?: string;
  updatedAt: string;
}): Promise<SyncAdaptiveTeamRunProjectionResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const projectionId = buildAdaptiveTeamRunProjectionId(args.teamId, args.runId);

  try {
    await adminDb.collection("teamRuns").doc(projectionId).update({
      humanReviewStatus: args.humanReviewStatus,
      reviewedAt: args.reviewedAt,
      updatedAt: args.updatedAt,
    });
    return { status: "synced" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const notFound = code === 5 || code === "NOT_FOUND" || message.includes("NOT_FOUND") || message.includes("No document to update");
    if (notFound) {
      logger.warn("[firestore/teamRuns] Adaptive projection missing during review sync", {
        runId: args.runId,
        teamId: args.teamId,
      });
      return { status: "not_found" };
    }
    logger.warn("[firestore/teamRuns] Failed to sync adaptive team-run projection after review", {
      runId: args.runId,
      teamId: args.teamId,
    });
    return { status: "write_failed" };
  }
}
