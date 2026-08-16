/**
 * Project Foundation, Phase 6C — `GET /api/user/projects`'s full
 * orchestration: resolve the caller's own Personal Workspace, run the raw
 * scoped query, then validate every returned document.
 *
 * Deliberately stricter than `GET /api/user/workspace/runs`'s own list
 * validation (which OMITS an individually-invalid row and continues
 * pagination — appropriate there because a single corrupted run among
 * many shouldn't block a user from seeing the rest of their history).
 * Phase 6A.2 chose the opposite policy for Projects: ANY malformed
 * document, embedded-id mismatch, workspace mismatch, or unexpected
 * status returned by the caller-scoped query fails the WHOLE page
 * closed, never silently omits-and-continues. A query that's supposed to
 * be scoped to exactly the caller's own active Projects returning
 * something that violates that scope is itself the structural problem
 * worth surfacing loudly — silently dropping it could conceal real
 * integrity corruption and would distort the cursor (a caller could
 * never tell whether "fewer items than expected" meant "that's genuinely
 * all of them" or "one was silently hidden").
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import { isWellFormedProjectV1, ProjectV1 } from "./types";
import { listActiveProjectsRaw } from "@/lib/firestore/projects";
import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import { logger } from "@/lib/logger";
import { decodeProjectsCursor, encodeProjectsCursor } from "./projectsCursor";

export interface ListedProject {
  project: ProjectV1;
  documentUpdateTime: Timestamp;
}

export type ListProjectsForOwnerResult =
  | { status: "ok"; items: ListedProject[]; hasMore: boolean; nextCursor?: string }
  | { status: "invalid_cursor" }
  | { status: "integrity_violation" }
  // Every non-"found" outcome resolvePersonalWorkspaceForOwner() can
  // really return, spelled out explicitly (never a derived/computed
  // type) to match this codebase's established discriminated-union
  // style — see resolveProjectForOwner.ts for the identical pattern.
  | { status: "workspaces_disabled" }
  | { status: "invalid_uid" }
  | { status: "not_found" }
  | { status: "malformed" }
  | { status: "wrong_owner" }
  | { status: "wrong_type" }
  | { status: "lookup_failed" };

export async function listProjectsForOwner(args: { uid: string; limit: number; cursorRaw?: string | null }): Promise<ListProjectsForOwnerResult> {
  const workspaceResult = await resolvePersonalWorkspaceForOwner(args.uid);
  if (workspaceResult.status !== "found") {
    return workspaceResult;
  }
  const workspaceId = workspaceResult.workspace.id;

  let startAfter: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeProjectsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = decoded.cursor;
  }

  const rawResult = await listActiveProjectsRaw({ workspaceId, limit: args.limit, startAfter });
  if (rawResult.status !== "ok") {
    return { status: "lookup_failed" };
  }

  const items: ListedProject[] = [];
  for (const doc of rawResult.items) {
    if (!isWellFormedProjectV1(doc.data)) {
      logger.warn("[projects/list] Integrity violation — malformed Project returned by caller-scoped query", { workspaceId, docId: doc.id });
      return { status: "integrity_violation" };
    }
    if (doc.data.id !== doc.id) {
      logger.warn("[projects/list] Integrity violation — embedded id mismatch on a document returned by caller-scoped query", { workspaceId, docId: doc.id, embeddedId: doc.data.id });
      return { status: "integrity_violation" };
    }
    if (doc.data.workspaceId !== workspaceId) {
      logger.warn("[projects/list] Integrity violation — workspaceId mismatch on a document returned by caller-scoped query", { workspaceId, docId: doc.id });
      return { status: "integrity_violation" };
    }
    if (doc.data.status !== "active") {
      logger.warn("[projects/list] Integrity violation — non-active status on a document returned by the active-only query", { workspaceId, docId: doc.id, status: doc.data.status });
      return { status: "integrity_violation" };
    }
    items.push({ project: doc.data, documentUpdateTime: doc.updateTime });
  }

  let nextCursor: string | undefined;
  if (rawResult.hasMore && items.length > 0) {
    const last = items[items.length - 1].project;
    nextCursor = encodeProjectsCursor({
      createdAtSeconds: last.createdAt.seconds,
      createdAtNanoseconds: last.createdAt.nanoseconds,
      lastDocId: last.id,
    });
  }

  return { status: "ok", items, hasMore: rawResult.hasMore, ...(nextCursor ? { nextCursor } : {}) };
}
