/**
 * Order 3 — the ONLY Firestore-touching part of Review Integrity Metrics v1.
 * It reuses the Step 6.3 primitives unchanged: the aggregation `count()`
 * executor, the raw-Project preflight count, the bounded Project listing and
 * the 30-Project ceiling. No artifact `.get()`, `limit` on artifacts, cursor,
 * listener or write exists on this path.
 *
 * The counts are independent queries, so a write landing between two of them
 * can make the arithmetic irreconcilable. The pure layer refuses such a
 * result; this adapter retries the WHOLE computation (Project listing
 * included) once and then reports `inconsistent` — it never returns a number
 * it cannot reconcile, and claims no cross-query snapshot.
 *
 * Envelope at the ceiling: 1 preflight + per attempt (1 listing + 70 counts),
 * so at most 143 Firestore operations with the retry.
 */
import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { countWorkspaceProjects, firestoreCountExecutor, loadCanonicalProjectIds, WORKSPACE_PROJECT_CEILING } from "./workspaceGovernanceSummaryFirestore";
import { computeReviewIntegrityMetrics, ReviewIntegrityInconsistentError, type ReviewIntegrityMetricsV1 } from "./reviewIntegrityMetrics";

export type LoadReviewIntegrityMetricsResult =
  | { ok: true; metrics: ReviewIntegrityMetricsV1 }
  | { ok: false; reason: "inconsistent" }
  | { ok: false; reason: "workspace_too_large"; projectCeiling: number };

export async function loadReviewIntegrityMetrics(db: Firestore, workspaceId: string): Promise<LoadReviewIntegrityMetricsResult> {
  const tooLarge = { ok: false as const, reason: "workspace_too_large" as const, projectCeiling: WORKSPACE_PROJECT_CEILING };
  if ((await countWorkspaceProjects(db, workspaceId)) > WORKSPACE_PROJECT_CEILING) return tooLarge;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const canonicalProjectIds = await loadCanonicalProjectIds(db, workspaceId);
    if (canonicalProjectIds === null) return tooLarge;
    try {
      return { ok: true, metrics: await computeReviewIntegrityMetrics({ workspaceId, canonicalProjectIds, count: firestoreCountExecutor(db) }) };
    } catch (err) {
      if (!(err instanceof ReviewIntegrityInconsistentError)) throw err;
    }
  }
  return { ok: false, reason: "inconsistent" };
}
