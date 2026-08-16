/**
 * Projects Foundation, Phase 6B — read-only. `getProject()` is the only
 * function in this file; there is no create/update/delete function here
 * yet (Project creation, per Phase 6A.1's frozen invariant, belongs to
 * Phase 6C and must generate its own `Firestore.doc()` reference first so
 * `id === document id` holds from the initial write — see
 * docs/workspaces/architecture.md).
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isWellFormedProjectV1, ProjectV1 } from "@/lib/projects/types";

export type GetProjectResult =
  | { status: "found"; project: ProjectV1 }
  | { status: "not_found" }
  | { status: "malformed" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

export async function getProject(projectId: string): Promise<GetProjectResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const snap = await adminDb.collection("projects").doc(projectId).get();
    if (!snap.exists) {
      return { status: "not_found" };
    }
    const data = snap.data();
    if (!isWellFormedProjectV1(data)) {
      // Distinct from not_found: a document exists at this id, but its
      // shape can't be trusted. Never blind-cast and return it as "found".
      logger.warn("[firestore/projects] Malformed project document", { projectId });
      return { status: "malformed" };
    }
    if (data.id !== projectId) {
      // The document's own `id` field must match the Firestore document
      // id it was actually fetched at — enforced HERE, at the point of
      // read, mirroring `getWorkspace()`'s identical invariant, so no
      // future caller can accidentally accept a mismatched embedded id.
      logger.warn("[firestore/projects] Project document id mismatch", { projectId, documentBodyId: data.id });
      return { status: "malformed" };
    }
    return { status: "found", project: data };
  } catch {
    logger.warn("[firestore/projects] Failed to read project", { projectId });
    return { status: "read_failed" };
  }
}
