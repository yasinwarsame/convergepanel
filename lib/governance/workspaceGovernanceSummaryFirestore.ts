/**
 * Step 6.3 — the ONLY Firestore-touching part of the Workspace governance
 * summary. Two operations, nothing else:
 *   1. `firestoreCountExecutor` — runs one declarative `CountSpec` as an
 *      aggregation `count()`. It never calls `.get()` on an artifact query,
 *      never applies `limit`/cursors, and never writes.
 *   2. `loadCanonicalProjectIds` — reads the Workspace's Project listing and
 *      keeps only Projects passing the `getProject()` invariants (contract §4).
 *
 * The counts are taken by several independent aggregation queries, so a write
 * landing between two of them can make a derived residual negative. The pure
 * layer refuses to return such a result (`GovernanceSummaryInconsistentError`);
 * `loadWorkspaceGovernanceSummary` retries once and then reports unavailable —
 * it never returns a number it cannot reconcile.
 */
import "server-only";
import type { Firestore, Query } from "firebase-admin/firestore";
import { isWellFormedProjectV1 } from "@/lib/projects/types";
import {
  canonicalProjectIdsFromListing,
  computeWorkspaceGovernanceSummary,
  GovernanceSummaryInconsistentError,
  type CountExecutor,
  type WorkspaceGovernanceSummary,
} from "./workspaceGovernanceSummary";

export function firestoreCountExecutor(db: Firestore): CountExecutor {
  return async (spec) => {
    let q: Query = db.collection(spec.collection);
    for (const f of spec.filters) q = q.where(f.field, f.op, f.value);
    const snap = await q.count().get();
    return snap.data().count;
  };
}

export async function loadCanonicalProjectIds(db: Firestore, workspaceId: string): Promise<string[]> {
  const snap = await db.collection("projects").where("workspaceId", "==", workspaceId).get();
  return canonicalProjectIdsFromListing(
    workspaceId,
    snap.docs.map((d) => ({ id: d.id, data: d.data() })),
    isWellFormedProjectV1
  );
}

export type LoadSummaryResult = { ok: true; summary: WorkspaceGovernanceSummary } | { ok: false; reason: "inconsistent" };

export async function loadWorkspaceGovernanceSummary(db: Firestore, workspaceId: string): Promise<LoadSummaryResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const canonicalProjectIds = await loadCanonicalProjectIds(db, workspaceId);
    try {
      return { ok: true, summary: await computeWorkspaceGovernanceSummary({ workspaceId, canonicalProjectIds, count: firestoreCountExecutor(db) }) };
    } catch (err) {
      if (!(err instanceof GovernanceSummaryInconsistentError)) throw err;
    }
  }
  return { ok: false, reason: "inconsistent" };
}
