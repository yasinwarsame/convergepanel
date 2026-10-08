/**
 * Step 6.3 — the ONLY Firestore-touching part of the Workspace governance
 * summary. Two operations, nothing else:
 *   1. `firestoreCountExecutor` — runs one declarative `CountSpec` as an
 *      aggregation `count()`. It never calls `.get()` on an artifact query,
 *      never applies `limit`/cursors, and never writes.
 *   2. `loadCanonicalProjectIds` — reads the Workspace's Project listing and
 *      keeps only Projects passing the `getProject()` invariants (contract §4).
 *
 * v1 Workspace-size ceiling (owner decision 6_3_V1_PROJECT_CEILING_APPROVED_30_RAW_WORKSPACE_PROJECTS):
 * a preflight `projects where workspaceId == W` count() runs FIRST. Above
 * WORKSPACE_PROJECT_CEILING raw Project documents the summary stops with
 * `workspace_too_large` — no Project listing, no artifact count. The listing
 * itself reads at most CEILING + 1 documents, so a Project created between the
 * preflight and the listing is detected (and also reported too-large) instead
 * of widening the read.
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

/** v1: at most this many RAW Project documents per Workspace (matches Firestore's 30-value `in` limit). */
export const WORKSPACE_PROJECT_CEILING = 30;

export async function countWorkspaceProjects(db: Firestore, workspaceId: string): Promise<number> {
  const snap = await db.collection("projects").where("workspaceId", "==", workspaceId).count().get();
  return snap.data().count;
}

/** Returns null when the listing exceeds the ceiling (bounded read of CEILING + 1 documents). */
export async function loadCanonicalProjectIds(db: Firestore, workspaceId: string): Promise<string[] | null> {
  const snap = await db.collection("projects").where("workspaceId", "==", workspaceId).limit(WORKSPACE_PROJECT_CEILING + 1).get();
  if (snap.docs.length > WORKSPACE_PROJECT_CEILING) return null;
  return canonicalProjectIdsFromListing(
    workspaceId,
    snap.docs.map((d) => ({ id: d.id, data: d.data() })),
    isWellFormedProjectV1
  );
}

export type LoadSummaryResult =
  | { ok: true; summary: WorkspaceGovernanceSummary }
  | { ok: false; reason: "inconsistent" }
  | { ok: false; reason: "workspace_too_large"; projectCeiling: number };

export async function loadWorkspaceGovernanceSummary(db: Firestore, workspaceId: string): Promise<LoadSummaryResult> {
  const tooLarge = { ok: false as const, reason: "workspace_too_large" as const, projectCeiling: WORKSPACE_PROJECT_CEILING };
  if ((await countWorkspaceProjects(db, workspaceId)) > WORKSPACE_PROJECT_CEILING) return tooLarge;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const canonicalProjectIds = await loadCanonicalProjectIds(db, workspaceId);
    if (canonicalProjectIds === null) return tooLarge;
    try {
      return { ok: true, summary: await computeWorkspaceGovernanceSummary({ workspaceId, canonicalProjectIds, count: firestoreCountExecutor(db) }) };
    } catch (err) {
      if (!(err instanceof GovernanceSummaryInconsistentError)) throw err;
    }
  }
  return { ok: false, reason: "inconsistent" };
}
