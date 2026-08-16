/**
 * Projects Foundation — Phase 6B added `getProject()` (read-only). Phase
 * 6C adds the write surface: `createProject()`, `countProjectsInWorkspace()`,
 * `listActiveProjectsRaw()`, and `updateProjectFields()` (the single
 * shared native-precondition update primitive rename/archive/restore all
 * use). There is still no delete/hard-delete function anywhere in this
 * file — archive is a status transition, not a document removal.
 */

import "server-only";
import { Status } from "google-gax";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isWellFormedProjectV1, ProjectV1 } from "@/lib/projects/types";

export type GetProjectResult =
  | { status: "found"; project: ProjectV1; documentUpdateTime: Timestamp }
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
    // `snap.updateTime` is guaranteed present for an existing document
    // (verified against the installed @google-cloud/firestore types —
    // QueryDocumentSnapshot/an existing DocumentSnapshot's `updateTime`
    // is non-optional once `.exists` is true). This is Firestore's own
    // native write-time metadata, never derived from `data.updatedAt`.
    return { status: "found", project: data, documentUpdateTime: snap.updateTime as Timestamp };
  } catch {
    logger.warn("[firestore/projects] Failed to read project", { projectId });
    return { status: "read_failed" };
  }
}

export type CreateProjectResult = { status: "created"; project: ProjectV1; documentUpdateTime: Timestamp } | { status: "firestore_unavailable" } | { status: "create_failed" };

/**
 * The frozen Phase 6A.1 creation invariant: generate the document
 * reference FIRST so the embedded `id` can equal the document id from the
 * very first write, then a single `.create()` — never `.add()` (which
 * offers no path to set `id` before the id is known) and never a
 * patch-after-create `.update()` call. `.create()` over `.set()` for the
 * same fail-loud-over-silent-overwrite reason `createPersonalWorkspace()`
 * already uses, even though a fresh 20-character Firestore auto-id has no
 * realistic collision risk.
 */
export async function createProject(args: { workspaceId: string; name: string; createdByUserId: string }): Promise<CreateProjectResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const ref = adminDb.collection("projects").doc();
    const now = Timestamp.now();
    const project: ProjectV1 = {
      schemaVersion: 1,
      id: ref.id,
      workspaceId: args.workspaceId,
      name: args.name,
      status: "active",
      createdByUserId: args.createdByUserId,
      createdAt: now,
      updatedAt: now,
    };
    const writeResult = await ref.create(project);
    return { status: "created", project, documentUpdateTime: writeResult.writeTime };
  } catch (err) {
    logger.warn("[firestore/projects] Failed to create project", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "create_failed" };
  }
}

export type CountProjectsResult = { status: "ok"; count: number } | { status: "firestore_unavailable" } | { status: "count_failed" };

/** Best-effort abuse/storage guard only — NOT a hard, concurrency-safe business invariant. Counts active + archived together, deliberately: archiving never reduces document count, so counting active-only would let a create/archive loop bypass the guard indefinitely. A genuine simultaneous burst of creates can race slightly above the configured threshold; accepted, not hardened further (see Phase 6A.1's own disclosed reasoning for why a dedicated atomic-counter subsystem isn't justified for an abuse guard, not a correctness invariant). */
export async function countProjectsInWorkspace(workspaceId: string): Promise<CountProjectsResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const snap = await adminDb.collection("projects").where("workspaceId", "==", workspaceId).count().get();
    return { status: "ok", count: snap.data().count };
  } catch (err) {
    logger.warn("[firestore/projects] Failed to count projects", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "count_failed" };
  }
}

export interface ListActiveProjectsRawItem {
  data: Record<string, unknown>;
  id: string;
  updateTime: Timestamp;
}

export type ListActiveProjectsRawResult =
  | { status: "ok"; items: ListActiveProjectsRawItem[]; hasMore: boolean }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

/**
 * Raw query only — returns unvalidated Firestore data. Per-document
 * structural/association-integrity validation is the CALLER's
 * responsibility (`lib/projects/listProjectsForOwner.ts`), deliberately
 * kept out of this thin I/O layer, mirroring how `getWorkspace()` (not
 * this file's `getProject()`, which validates internally because it
 * fetches exactly one document by id) is a closer analog — actually see
 * that module's own doc comment for why single-document fetch and
 * multi-document list validation live at different layers in this
 * codebase's established convention: a list query's validation policy
 * (fail the whole page vs. omit-and-continue) is a caller-specific
 * product decision, not a generic Firestore-read concern.
 */
export async function listActiveProjectsRaw(args: {
  workspaceId: string;
  limit: number;
  startAfter?: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string };
}): Promise<ListActiveProjectsRawResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    let query = adminDb
      .collection("projects")
      .where("workspaceId", "==", args.workspaceId)
      .where("status", "==", "active")
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");

    if (args.startAfter) {
      query = query.startAfter(new Timestamp(args.startAfter.createdAtSeconds, args.startAfter.createdAtNanoseconds), args.startAfter.lastDocId);
    }

    // Peek one extra document to determine `hasMore` without a second
    // query — mirrors GET /api/user/workspace/runs's identical technique.
    const snap = await query.limit(args.limit + 1).get();
    const allDocs = snap.docs;
    const hasMore = allDocs.length > args.limit;
    const pageDocs = allDocs.slice(0, args.limit);

    return {
      status: "ok",
      items: pageDocs.map((d) => ({ data: d.data(), id: d.id, updateTime: d.updateTime })),
      hasMore,
    };
  } catch (err) {
    logger.warn("[firestore/projects] Failed to list projects", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}

export type UpdateProjectFieldsResult =
  | { status: "updated"; documentUpdateTime: Timestamp }
  | { status: "precondition_failed" }
  | { status: "not_found" }
  | { status: "firestore_unavailable" }
  | { status: "update_failed" };

/**
 * The single shared native-precondition update primitive every Phase 6C
 * mutation (rename/archive/restore) funnels through. Uses
 * `DocumentReference.update(data, {lastUpdateTime})` — Firestore's own
 * built-in optimistic-concurrency mechanism (verified against the
 * installed `@google-cloud/firestore` types, not guessed), never a
 * hand-rolled read-compare-write sequence and never `ProjectV1.updatedAt`
 * as the precondition value. A stale or concurrently-superseded
 * `expectedUpdateTime` fails this call with a real `FAILED_PRECONDITION`
 * (gRPC status 9, confirmed against `google-gax`'s own `Status` enum —
 * the same real, stable numeric constant this codebase already relies on
 * for `ALREADY_EXISTS` detection in `createPersonalWorkspace()`) — mapped
 * to `precondition_failed` here, then to `409 conflict` at the route
 * layer. Never echoes the document's current state back to the caller.
 */
export async function updateProjectFields(args: {
  projectId: string;
  data: Partial<Pick<ProjectV1, "name" | "status" | "updatedAt">>;
  expectedUpdateTime: Timestamp;
}): Promise<UpdateProjectFieldsResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    const ref = adminDb.collection("projects").doc(args.projectId);
    const writeResult = await ref.update(args.data, { lastUpdateTime: args.expectedUpdateTime });
    return { status: "updated", documentUpdateTime: writeResult.writeTime };
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === Status.FAILED_PRECONDITION || message.includes("FAILED_PRECONDITION")) {
      return { status: "precondition_failed" };
    }
    if (code === Status.NOT_FOUND || message.includes("NOT_FOUND")) {
      return { status: "not_found" };
    }
    logger.warn("[firestore/projects] Failed to update project", { projectId: args.projectId, error: message });
    return { status: "update_failed" };
  }
}
