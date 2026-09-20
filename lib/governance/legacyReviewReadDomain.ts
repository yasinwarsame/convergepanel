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
 * ONE RULE, ONE FAILURE DIRECTION. An artifact is readable through legacy Team
 * authority ONLY when its canonical document was read successfully, carries a
 * readable body, and that body classifies as legacy. Everything else — a
 * Workspace or Personal binding, a malformed binding, a missing document, an
 * unreadable body, a failed read, a row naming no canonical artifact, and a row
 * naming two — is ineligible. The input validation is performed ONCE, in
 * `classifyCanonicalSnapshot()`, so both canonical record types answer every
 * malformed state identically; an earlier revision let the verification side
 * turn "cannot classify" into "allow", because `isWorkspaceBoundVerificationArtifact()`
 * returns false for a non-object and the call site negated it.
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

/**
 * Which canonical artifact, if any, a row's authority must be derived from.
 *
 * `none` and `conflict` are both ineligible. `none` because a row that names no
 * canonical artifact cannot be proven to belong to this authority domain — and
 * no writer produces one: every `applyTeamGovernancePipeline` caller supplies
 * exactly one id (`verify-claim` and the Team Workspace Claim route a
 * `verificationId`; `synthesize-panel` a `runId`, enforced by its own 400 when
 * one is missing), and `createAdaptiveTeamRunProjection` derives its id from a
 * `runId`. `conflict` because preferring one canonical artifact over the other
 * would be arbitrary: a legacy run id must not authorize rendering content that
 * came from a Workspace-bound verification.
 */
export type TeamRunRowLinkage =
  | { kind: "run"; id: string }
  | { kind: "verification"; id: string }
  | { kind: "none" }
  | { kind: "conflict" };

export function teamRunRowLinkage(raw: unknown): TeamRunRowLinkage {
  const runId = teamRunRowCanonicalRunId(raw);
  const verificationId = teamRunRowVerificationId(raw);
  if (runId !== null && verificationId !== null) return { kind: "conflict" };
  if (runId !== null) return { kind: "run", id: runId };
  if (verificationId !== null) return { kind: "verification", id: verificationId };
  return { kind: "none" };
}

export type LegacyReadDomain = {
  /**
   * Exactly the ids PROVABLY classified legacy. Membership is the whole
   * contract: callers treat absence as "not readable through the legacy Team
   * surface" and never need to know why, so every failure mode collapses to one
   * safe answer.
   */
  legacyOnlyRunIds: Set<string>;
  legacyOnlyVerificationIds: Set<string>;
  /**
   * True when at least one candidate's authority could NOT be determined —
   * a batched canonical read failed, or Firestore was unavailable.
   *
   * This is deliberately NOT the same as "classified ineligible". A missing
   * document, a Workspace binding, a Personal binding and a malformed binding
   * are all SUCCESSFUL classifications whose answer happens to be "no"; this
   * flag means the question could not be answered at all. Both outcomes
   * exclude the row, so a caller that only filters can ignore it — but a
   * caller producing a DURABLE artifact must not represent "could not
   * determine" as "there was nothing to include".
   */
  classificationUnavailable: boolean;
};

/** The authority domain a canonical document belongs to. Only `legacy` is readable here. */
type AuthorityDomain = "legacy" | "foreign" | "invalid";

/**
 * The SINGLE input-validation gate. Applied identically to every canonical
 * record type before any type-specific rule runs, so the two types can never
 * answer the same malformed state differently.
 */
function classifyCanonicalSnapshot(snap: unknown, domainOfBody: (body: Record<string, unknown>) => AuthorityDomain): AuthorityDomain {
  if (!snap || typeof snap !== "object") return "invalid";
  const candidate = snap as { exists?: unknown; data?: unknown };
  if (candidate.exists !== true) return "invalid";
  if (typeof candidate.data !== "function") return "invalid";
  const body = (candidate.data as () => unknown)();
  // An unreadable body is NOT evidence of legacy eligibility. This is the line
  // the verification side previously lacked.
  if (!body || typeof body !== "object" || Array.isArray(body)) return "invalid";
  return domainOfBody(body as Record<string, unknown>);
}

/** A run is legacy only when its canonical record carries no Workspace binding at all. */
function runBodyDomain(body: Record<string, unknown>): AuthorityDomain {
  return runIsLegacyOnlyForReviewMutation(body) ? "legacy" : "foreign";
}

/** A verification artifact is legacy only when it carries no `workspaceId` field at all. */
function verificationBodyDomain(body: Record<string, unknown>): AuthorityDomain {
  return isWorkspaceBoundVerificationArtifact(body) ? "foreign" : "legacy";
}

/**
 * Batched, bounded-concurrency classification of one collection.
 *
 * FAILS CLOSED in every direction. An id is admitted only when a snapshot whose
 * OWN id was in the requested chunk came back readable and classified `legacy`.
 * A snapshot carrying an id that was never requested contributes nothing — a
 * foreign result must not be able to mint an admitted id — and an id observed
 * more than once is admitted only if EVERY observation admitted it, so a
 * duplicate can never flip a denial open.
 */
async function classifyByDocument(
  collection: string,
  ids: readonly string[],
  domainOfBody: (body: Record<string, unknown>) => AuthorityDomain
): Promise<{ admitted: Set<string>; unavailable: boolean }> {
  const admitted = new Set<string>();
  const denied = new Set<string>();
  let unavailable = false;
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return { admitted, unavailable };

  if (!adminDb) {
    logger.warn("[governance/legacyReviewReadDomain] Firestore unavailable; excluding every row from the legacy Team read domain", {
      collection,
      idCount: unique.length,
    });
    return { admitted, unavailable: true };
  }

  // ---- Canonical reference resolution, ONCE for the whole request ----
  //
  // Firestore NORMALIZES a document path: `doc("R")`, `doc("R/")` and
  // `doc("/R")` all resolve to `runs/R`. Two distinct raw linkage values can
  // therefore collapse onto ONE canonical reference, and a map keyed on the
  // path would quietly keep whichever was written last — leaving the other
  // logical row in neither the admitted nor the denied set while the counts
  // still matched, so classification reported itself complete. That is the same
  // silent-drop this module exists to prevent.
  //
  // So the mapping from logical id to canonical reference must be INJECTIVE. It
  // is checked across the ENTIRE request rather than per chunk, because two
  // colliding values could otherwise land in different batches and escape; and
  // because that makes the answer independent of row ordering, which a per-chunk
  // check is not.
  //
  // When two distinct logical ids do collide, NEITHER is classified and the
  // operation is unavailable. Picking a winner would be a guess, and this module
  // does not guess.
  const owners = new Map<string, Set<string>>();
  for (const id of unique) {
    let path: string;
    try {
      path = adminDb.collection(collection).doc(id).path;
    } catch {
      // An id Firestore rejects as a document path cannot be classified.
      unavailable = true;
      continue;
    }
    const existing = owners.get(path);
    if (existing) existing.add(id);
    else owners.set(path, new Set([id]));
  }

  const resolved: Array<{ id: string; path: string }> = [];
  for (const [path, ids] of owners) {
    if (ids.size > 1) {
      // Ambiguous: distinct logical ids, one canonical reference.
      unavailable = true;
      continue;
    }
    resolved.push({ id: [...ids][0], path });
  }

  const chunks: Array<Array<{ id: string; path: string }>> = [];
  for (let i = 0; i < resolved.length; i += CHUNK_SIZE) chunks.push(resolved.slice(i, i + CHUNK_SIZE));

  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
    const wave = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
    await Promise.all(
      wave.map(async (chunk) => {
        try {
          // Association is keyed on the EXACT canonical reference path resolved
          // above — never the leaf `snapshot.id`, which is only the last segment
          // and can be shared by references in different parents.
          const expected = new Map(chunk.map((entry) => [entry.path, entry.id] as const));
          const snaps = await adminDb!.getAll(...chunk.map((entry) => adminDb!.collection(collection).doc(entry.id)));

          const observed = new Set<string>();
          for (const snap of snaps) {
            const path = nonEmptyString((snap as { ref?: { path?: unknown } } | null | undefined)?.ref?.path);
            const logicalId = path === null ? undefined : expected.get(path);
            if (logicalId === undefined) {
              // A result we cannot tie back to something we asked for. It admits
              // nothing, and it means the result set's integrity is not intact,
              // so this batch is not a completed classification — even if every
              // reference we DID ask for also came back.
              unavailable = true;
              continue;
            }
            observed.add(path as string);
            if (classifyCanonicalSnapshot(snap, domainOfBody) === "legacy") admitted.add(logicalId);
            else denied.add(logicalId);
          }

          // POSITIVE completeness: every requested reference must have been
          // observed. `exists: false` IS an observation — a missing canonical
          // document is an ordinary completed exclusion — but a reference that
          // never came back was never answered. Keyed on the expected-path SET,
          // so a duplicated observation cannot make up for an omitted one.
          if (observed.size !== expected.size) unavailable = true;
        } catch (err: unknown) {
          // The question could not be answered for this chunk. Every id in it
          // is excluded (fail closed) AND the caller is told classification was
          // incomplete, so a durable artifact can refuse to look authoritative.
          unavailable = true;
          // Metadata only — never a row's content, query or review data.
          logger.warn("[governance/legacyReviewReadDomain] Canonical binding read failed for a chunk; excluding those rows", {
            collection,
            chunkSize: chunk.length,
            errorMessage: err instanceof Error ? err.message : "unknown_error",
          });
        }
      })
    );
  }

  for (const id of denied) admitted.delete(id);
  return { admitted, unavailable };
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
    const linkage = teamRunRowLinkage(raw);
    if (linkage.kind === "run") runIds.push(linkage.id);
    else if (linkage.kind === "verification") verificationIds.push(linkage.id);
  }

  const [runs, verifications] = await Promise.all([
    classifyByDocument("runs", runIds, runBodyDomain),
    classifyByDocument("verifications", verificationIds, verificationBodyDomain),
  ]);

  return {
    legacyOnlyRunIds: runs.admitted,
    legacyOnlyVerificationIds: verifications.admitted,
    classificationUnavailable: runs.unavailable || verifications.unavailable,
  };
}

/**
 * The rule a row-filtering caller applies: a row is kept only when the single
 * canonical artifact it names was proven to belong to the legacy domain.
 */
export function teamRunRowIsInLegacyReadDomain(raw: unknown, domain: LegacyReadDomain): boolean {
  const linkage = teamRunRowLinkage(raw);
  if (linkage.kind === "run") return domain.legacyOnlyRunIds.has(linkage.id);
  if (linkage.kind === "verification") return domain.legacyOnlyVerificationIds.has(linkage.id);
  return false;
}
