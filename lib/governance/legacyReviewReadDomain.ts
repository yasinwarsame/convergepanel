import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { runIsLegacyOnlyForReviewMutation } from "./legacyReviewRunAuthority";

/**
 * Phase 1 Review Stack Cross-Authority READ Guard — the list/export half of
 * the exclusion PR #186 established for mutation.
 *
 * WHAT PR #186 LEFT OPEN. That change made Workspace authority exclusive over
 * a Workspace-bound run's review-panel MUTATION. It did nothing to reads, and
 * `app/api/teams/**` contained no Workspace awareness at all. A legacy Team
 * ADMIN holding no Workspace capability could therefore reach canonical
 * Workspace-governed review state — reviewer identities, per-reviewer vote
 * decisions, assignment metadata, panel status/quorum/counts, the canonical
 * human-review status and answer-derived `receiptConclusion` — simply because
 * a legacy `teamRuns` projection existed for the same run. The projection is
 * created by `lib/runPanelExecution.ts` whenever the run OWNER belongs to a
 * legacy team with `adaptiveReviewSettings.enabled`, with no `workspaceId`
 * condition whatsoever, so the overlap is ordinary rather than exotic.
 *
 * THE RULE, identical in shape to PR #186's. A Workspace-bound run lies
 * OUTSIDE the authority domain of the legacy Team read surface. Legacy Team
 * membership, legacy Team admin, a valid `teamRuns` projection and the legacy
 * adaptive-review settings are each insufficient, and both feature flags are
 * irrelevant — this is an authority boundary, not a rollout gate. The fix is
 * domain EXCLUSION, never teaching legacy routes to accept Workspace
 * capabilities: that would recreate the dual authority being closed.
 *
 * WHY A SEPARATE MODULE FROM THE DETAIL ROUTES. A single-run legacy route
 * already reads `runs/{runId}` itself, so it needs only the pure predicate
 * (`runIsLegacyOnlyForReviewMutation`) applied to the snapshot it is holding —
 * exactly as PR #186's guards do, at no extra read cost. The LIST and EXPORT
 * surfaces are different: they start from `teamRuns` projection rows and hold
 * no canonical run document at all, so they need a batched canonical lookup.
 * That lookup is what this module provides, and nothing else.
 *
 * THE PREDICATE IS SHARED DELIBERATELY. `runIsLegacyOnlyForReviewMutation()`
 * is named for its first caller but is, by its own doc comment, the authority-
 * DOMAIN classifier — "it only decides which authority DOMAIN owns the run".
 * Reads and mutations must answer that question identically or the two halves
 * of the boundary could drift apart, so this module calls that same function
 * rather than reimplementing or re-deriving the classification.
 */

/** One chunk per `getAll()`, matching the established batching precedent in `app/api/teams/runs/route.ts` and `lib/governance/reviewerIdentity.ts`. */
const CHUNK_SIZE = 10;

/**
 * The canonical run id a `teamRuns` row points at, or `null` when the row
 * points at no canonical run at all.
 *
 * A row's own document id is NOT the run id: the adaptive projection id is
 * `buildAdaptiveTeamRunProjectionId(teamId, runId)` and the classic legacy id
 * is an opaque `{teamId}-{uid}-{ts}-{rand}` (`teamGovernancePipeline.ts`).
 * Both carry the run id in an explicit `runId` field, which is `null` for a
 * classic row created for a VERIFICATION rather than a research run. Such a
 * row has no canonical run document to classify and cannot be a
 * Workspace-bound run, so it is left entirely alone here — Workspace-bound
 * verification ARTIFACT scoping is a separate concern, already handled for the
 * `/api/governance/*` family by `isWorkspaceBoundVerificationArtifact()`, and
 * is deliberately out of this guard's scope.
 */
export function teamRunRowCanonicalRunId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const runId = (raw as Record<string, unknown>).runId;
  return typeof runId === "string" && runId.trim().length > 0 ? runId : null;
}

export type LegacyOnlyRunIdsResult = {
  /**
   * Exactly the run ids PROVABLY classified legacy-only from their canonical
   * run document. Membership is the whole contract: a caller treats absence as
   * "not readable through the legacy Team surface" and never needs to
   * distinguish why, so a Workspace binding, a Personal binding, a malformed
   * `workspaceId`, a missing run document and a failed read all collapse to
   * the same safe answer.
   */
  legacyOnly: Set<string>;
};

/**
 * Batched canonical classification for a set of `teamRuns` rows' run ids.
 *
 * FAILS CLOSED, which is the entire point. A run id is admitted only when its
 * canonical `runs/{runId}` document was read successfully AND
 * `runIsLegacyOnlyForReviewMutation()` accepted it. A read failure, an absent
 * run document, a Personal binding, a Team Workspace binding and a malformed
 * binding are all simply left out. Schema drift therefore cannot convert an
 * unknown run into legacy-authorized data — the direction every ambiguity
 * resolves in is exclusion.
 *
 * A chunk-level read failure excludes only that chunk's ids rather than
 * throwing, matching the degrade-per-chunk behaviour the team review queue
 * already relies on; but note the direction differs on purpose. There,
 * degrading means "omit enrichment"; here it means "omit the row", because a
 * row whose authority cannot be established must not be shown.
 */
export async function legacyOnlyRunIds(runIds: readonly string[]): Promise<LegacyOnlyRunIdsResult> {
  const legacyOnly = new Set<string>();
  const unique = Array.from(new Set(runIds.filter((id) => typeof id === "string" && id.trim().length > 0)));
  if (unique.length === 0) return { legacyOnly };

  if (!adminDb) {
    // No database handle: nothing can be proven legacy-only, so nothing is.
    logger.warn("[governance/legacyReviewReadDomain] Firestore unavailable; excluding every row from the legacy Team read domain", {
      runIdCount: unique.length,
    });
    return { legacyOnly };
  }

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE);
    try {
      const snaps = await adminDb.getAll(...chunk.map((id) => adminDb!.collection("runs").doc(id)));
      snaps.forEach((snap, idx) => {
        if (!snap.exists) return;
        if (runIsLegacyOnlyForReviewMutation(snap.data())) legacyOnly.add(chunk[idx]);
      });
    } catch (err: unknown) {
      // Metadata only — never a run's content, query or review data.
      logger.warn("[governance/legacyReviewReadDomain] Canonical binding read failed for a chunk; excluding those rows", {
        chunkSize: chunk.length,
        errorMessage: err instanceof Error ? err.message : "unknown_error",
      });
    }
  }

  return { legacyOnly };
}

/**
 * Convenience predicate over an already-resolved result, expressing the rule
 * a row-filtering caller applies: a row with no canonical run id at all stays
 * (it cannot be a Workspace-bound run), and a row that names one is kept only
 * if that run was proven legacy-only.
 */
export function teamRunRowIsInLegacyReadDomain(raw: unknown, result: LegacyOnlyRunIdsResult): boolean {
  const runId = teamRunRowCanonicalRunId(raw);
  if (runId === null) return true;
  return result.legacyOnly.has(runId);
}
