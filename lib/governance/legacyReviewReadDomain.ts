import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { runIsLegacyOnlyForReviewMutation } from "./legacyReviewRunAuthority";
import { isWorkspaceBoundVerificationArtifact } from "@/lib/verification/verificationArtifactScope";

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
 * a legacy `teamRuns` row existed for the same artifact.
 *
 * THE RULE, identical in shape to PR #186's. A Workspace-bound artifact lies
 * OUTSIDE the authority domain of the legacy Team read surface. Legacy Team
 * membership, legacy Team admin, a valid `teamRuns` row and the legacy
 * adaptive-review settings are each insufficient, and both feature flags are
 * irrelevant — this is an authority boundary, not a rollout gate. The fix is
 * domain EXCLUSION, never teaching legacy routes to accept Workspace
 * capabilities: that would recreate the dual authority being closed.
 *
 * TWO LINKAGE SHAPES, ONE ANSWER. This module answers exactly one question —
 * "may this `teamRuns` row be read through legacy Team authority?" — and a row
 * reaches that answer by one of two routes, because `teamRuns` has two
 * different producers:
 *
 *   - RUN-BACKED rows (`runId` present). `lib/runPanelExecution.ts` writes the
 *     adaptive projection, and `teamGovernancePipeline.ts` a classic research
 *     row, whenever the OWNER belongs to a legacy team — with no `workspaceId`
 *     condition — so a Workspace-bound run routinely also has a legacy row.
 *     Authority comes from the canonical `runs/{runId}` document.
 *
 *   - VERIFICATION-BACKED rows (`runId` null, `verificationId` present). The
 *     TEAM WORKSPACE Claim route
 *     (`app/api/workspaces/{workspaceId}/verifications/route.ts`) calls the
 *     LEGACY `applyTeamGovernancePipeline({type: "verification", …})` with no
 *     `runId`, so a Workspace Claim verification ALSO writes a classic
 *     `teamRuns` row — carrying the claim text (5 000 chars), verdict,
 *     consensus summary and audit bundle. Authority comes from the canonical
 *     `verifications/{verificationId}` artifact.
 *
 * An earlier revision treated `runId === null` as proof a row could not be
 * Workspace-bound. The premise ("it is not a run") was true and the conclusion
 * was wrong: it left every Workspace-bound Claim verification readable through
 * the legacy Team list and audit export. Both shapes are classified now, so
 * there is no branch where a run-backed row is guarded while a
 * verification-backed row silently bypasses the same rule.
 *
 * THE PREDICATES ARE SHARED DELIBERATELY. Run binding uses
 * `runIsLegacyOnlyForReviewMutation()` — by its own doc comment the
 * authority-DOMAIN classifier, not a mutation-only check — so reads and
 * mutations can never answer differently. Verification binding uses
 * `isWorkspaceBoundVerificationArtifact()`, the same field-presence rule that
 * `/api/governance/*`, `/api/user/panel-history` and `/api/verify-video`
 * already enforce; this surface was simply the one that never adopted it.
 */

/** One chunk per `getAll()`, matching the batching precedent in `app/api/teams/runs/route.ts` and `lib/governance/reviewerIdentity.ts`. */
const CHUNK_SIZE = 10;
/** Chunks run concurrently, never more than this many at once — bounded, so a large team cannot open an unbounded number of simultaneous reads. */
const MAX_CONCURRENT_CHUNKS = 5;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The canonical run id a `teamRuns` row points at, or `null`.
 *
 * A row's own document id is NOT the run id: the adaptive projection id is
 * `buildAdaptiveTeamRunProjectionId(teamId, runId)` and the classic legacy id
 * is an opaque `{teamId}-{uid}-{ts}-{rand}` (`teamGovernancePipeline.ts`).
 * Both carry the run id in an explicit `runId` field.
 */
export function teamRunRowCanonicalRunId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return nonEmptyString((raw as Record<string, unknown>).runId);
}

/** The canonical verification artifact id a `teamRuns` row points at, or `null`. */
export function teamRunRowVerificationId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  return nonEmptyString((raw as Record<string, unknown>).verificationId);
}

export type LegacyReadDomain = {
  /**
   * Exactly the run ids PROVABLY classified legacy-only from their canonical
   * run document, and the verification ids PROVABLY classified non-Workspace
   * from their canonical artifact. Membership is the whole contract: callers
   * treat absence as "not readable through the legacy Team surface" and never
   * need to know why, so a Workspace binding, a Personal binding, a malformed
   * binding, a missing document and a failed read all collapse to one safe
   * answer.
   */
  legacyOnlyRunIds: Set<string>;
  legacyOnlyVerificationIds: Set<string>;
};

/** Batched, bounded-concurrency read of one collection, returning the ids whose document satisfies `admit`. */
async function classifyByDocument(
  collection: string,
  ids: readonly string[],
  admit: (data: unknown) => boolean
): Promise<Set<string>> {
  const admitted = new Set<string>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return admitted;

  if (!adminDb) {
    // No database handle: nothing can be proven, so nothing is admitted.
    logger.warn("[governance/legacyReviewReadDomain] Firestore unavailable; excluding every row from the legacy Team read domain", {
      collection,
      idCount: unique.length,
    });
    return admitted;
  }

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK_SIZE) chunks.push(unique.slice(i, i + CHUNK_SIZE));

  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
    const wave = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
    await Promise.all(
      wave.map(async (chunk) => {
        try {
          const snaps = await adminDb!.getAll(...chunk.map((id) => adminDb!.collection(collection).doc(id)));
          for (const snap of snaps) {
            // Associated by DOCUMENT IDENTITY, never by position in the
            // response array: a positional mapping would silently credit one
            // document's binding to another id if ordering ever changed, and
            // that misattribution would fail OPEN.
            const id = nonEmptyString((snap as { id?: unknown }).id);
            if (!id || !snap.exists) continue;
            if (admit(snap.data())) admitted.add(id);
          }
        } catch (err: unknown) {
          // Metadata only — never a row's content, query or review data. A
          // chunk-level failure excludes only that chunk's ids rather than
          // throwing: a row whose authority cannot be established is not shown.
          logger.warn("[governance/legacyReviewReadDomain] Canonical binding read failed for a chunk; excluding those rows", {
            collection,
            chunkSize: chunk.length,
            errorMessage: err instanceof Error ? err.message : "unknown_error",
          });
        }
      })
    );
  }

  return admitted;
}

/**
 * Classifies every linkage a page/export of `teamRuns` rows carries.
 *
 * Takes the ROWS rather than pre-extracted ids so a caller cannot accidentally
 * omit one: an id that never reached this function would be absent from the
 * result, and absence means exclusion — safe, but it would silently hide
 * legitimate rows. At most two batched passes (runs, verifications), both
 * bounded and both fail-closed.
 */
export async function resolveLegacyReadDomain(rows: readonly unknown[]): Promise<LegacyReadDomain> {
  const runIds: string[] = [];
  const verificationIds: string[] = [];
  for (const raw of rows) {
    const runId = teamRunRowCanonicalRunId(raw);
    if (runId !== null) {
      runIds.push(runId);
      continue;
    }
    const verificationId = teamRunRowVerificationId(raw);
    if (verificationId !== null) verificationIds.push(verificationId);
  }

  const [legacyOnlyRunIds, legacyOnlyVerificationIds] = await Promise.all([
    classifyByDocument("runs", runIds, (data) => runIsLegacyOnlyForReviewMutation(data)),
    classifyByDocument("verifications", verificationIds, (data) => !isWorkspaceBoundVerificationArtifact(data)),
  ]);

  return { legacyOnlyRunIds, legacyOnlyVerificationIds };
}

/**
 * The rule a row-filtering caller applies.
 *
 * A row backed by a run is kept only if that run was proven legacy-only; a row
 * backed by a verification artifact only if that artifact was proven
 * non-Workspace. A row naming NEITHER is kept: it references no canonical
 * artifact, so it has nothing in another authority domain to expose. That
 * shape is real and legitimate — `app/api/synthesize-panel` passes
 * `runId: runId || undefined`, so a legacy research row written without a run
 * id lands here — and hiding it would be an unjustified regression of existing
 * legacy behaviour rather than a security gain.
 */
export function teamRunRowIsInLegacyReadDomain(raw: unknown, domain: LegacyReadDomain): boolean {
  const runId = teamRunRowCanonicalRunId(raw);
  if (runId !== null) return domain.legacyOnlyRunIds.has(runId);

  const verificationId = teamRunRowVerificationId(raw);
  if (verificationId !== null) return domain.legacyOnlyVerificationIds.has(verificationId);

  return true;
}
