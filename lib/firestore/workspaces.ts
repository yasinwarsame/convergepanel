/**
 * Workspace Compatibility Foundation — Firestore access for the
 * `workspaces/{id}` collection, mirroring the established discriminated-
 * result pattern (`getAdaptiveHumanReviewAssignment` in this file's
 * sibling `runs.ts`): plain, non-transactional operations that never
 * throw and never blind-cast Firestore data.
 *
 * `getWorkspace()` is Phase 1 — read-only. `createPersonalWorkspace()` is
 * Phase 2's one narrow addition: a semantic, single-purpose write, never a
 * generic `createWorkspace(data)`. There is still no update/delete
 * function anywhere in this file, and still no way to create a `type:
 * "team"` workspace or a Personal Workspace for anyone other than the
 * caller-supplied uid.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isWellFormedWorkspaceV1, WorkspaceV1 } from "@/lib/workspaces/types";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

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

export type CreatePersonalWorkspaceResult =
  | { status: "created"; workspace: WorkspaceV1 }
  | { status: "already_exists" }
  | { status: "invalid_uid" }
  | { status: "firestore_unavailable" }
  | { status: "create_failed" };

/**
 * The one write primitive Phase 2 adds. Uses `.create()` — exactly the
 * `ALREADY_EXISTS`-is-idempotent-success pattern already established by
 * `createAdaptiveHumanReviewHistory()`/`createAdaptiveHumanReviewAssignmentHistory()`
 * above — never `.set()`, which would silently overwrite a conflicting
 * document instead of surfacing the conflict. `ALREADY_EXISTS` is
 * reported as its own distinct, expected outcome, not folded into
 * `create_failed`: the calling service (`ensurePersonalWorkspace`)
 * decides what to do about it — this function's only job is the create
 * attempt itself, never validating what was already there.
 *
 * Never accepts a caller-supplied id, type, ownerUserId, or timestamp —
 * every field is derived here, server-side, from `uid` alone.
 */
export async function createPersonalWorkspace(uid: string): Promise<CreatePersonalWorkspaceResult> {
  const idResult = getPersonalWorkspaceId(uid);
  if (!idResult.ok) {
    return { status: "invalid_uid" };
  }
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }

  const now = Timestamp.now();
  const workspace: WorkspaceV1 = {
    schemaVersion: 1,
    id: idResult.workspaceId,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: uid,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await adminDb.collection("workspaces").doc(idResult.workspaceId).create(workspace);
    return { status: "created", workspace };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    logger.warn("[firestore/workspaces] Failed to create personal workspace", { workspaceId: idResult.workspaceId });
    return { status: "create_failed" };
  }
}
