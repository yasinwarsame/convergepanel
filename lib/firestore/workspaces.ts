/**
 * Workspace Compatibility Foundation, Phase 1 — Firestore read access for
 * the new `workspaces/{id}` collection, mirroring the established
 * discriminated-result pattern (`getAdaptiveHumanReviewAssignment` above in
 * this file's sibling `runs.ts`): a plain, non-transactional read that
 * never throws and never blind-casts Firestore data.
 *
 * Deliberately READ-ONLY. Phase 1 has no `createWorkspace`/
 * `provisionPersonalWorkspace` function anywhere in the codebase — the
 * capability to write a workspace document does not exist yet, not merely
 * "exists but unused." Provisioning is Phase 2's scope.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isWellFormedWorkspaceV1, WorkspaceV1 } from "@/lib/workspaces/types";

export type GetWorkspaceResult =
  | { status: "found"; workspace: WorkspaceV1 }
  | { status: "not_found" }
  | { status: "malformed" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

export async function getWorkspace(workspaceId: string): Promise<GetWorkspaceResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const snap = await adminDb.collection("workspaces").doc(workspaceId).get();
    if (!snap.exists) {
      return { status: "not_found" };
    }
    const data = snap.data();
    if (!isWellFormedWorkspaceV1(data)) {
      // Distinct from not_found: a document exists at this id, but its
      // shape can't be trusted. Never blind-cast and return it as "found".
      logger.warn("[firestore/workspaces] Malformed workspace document", { workspaceId });
      return { status: "malformed" };
    }
    if (data.id !== workspaceId) {
      // The document's own `id` field (redundant-by-design, mirroring
      // TeamDocument's `id` convention for self-describing documents) must
      // match the Firestore document id it was actually fetched at. This
      // invariant is enforced HERE, at the point of read — not left for
      // every future caller to re-derive — so a mismatch can never be
      // silently accepted as "found" by any caller, present or future.
      logger.warn("[firestore/workspaces] Workspace document id mismatch", { workspaceId, documentBodyId: data.id });
      return { status: "malformed" };
    }
    return { status: "found", workspace: data };
  } catch {
    logger.warn("[firestore/workspaces] Failed to read workspace", { workspaceId });
    return { status: "read_failed" };
  }
}
