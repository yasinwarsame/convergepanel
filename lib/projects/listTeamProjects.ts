/**
 * Team Project Backend, Phase 8C-A — `GET /api/workspaces/{W}/projects`'s
 * full read-side orchestration. Read-only; does NOT use
 * `authorizeTeamWorkspaceMutationInTransaction()` — Workspace access for a
 * read is resolved by the caller (the route) via `resolveWorkspaceAccess()`
 * before this function is ever called (Section 6: reads do not require
 * transaction-time authorization).
 *
 * Reuses `listActiveProjectsRaw()` (`lib/firestore/projects.ts`)
 * completely unmodified — that function already takes `workspaceId` as a
 * plain parameter with no Personal-specific derivation, so it is safe to
 * call with a Team `workspaceId` exactly as-is. The query authorization
 * boundary is `workspaceId == W` alone — never `userId ==`/`createdByUserId
 * ==` (Section 7).
 *
 * Integrity policy mirrors `listProjectsForOwner()`'s (Personal) frozen
 * Phase 6A.2 choice exactly: ANY malformed document, embedded-id mismatch,
 * workspace mismatch, or unexpected status returned by the Workspace-scoped
 * query fails the WHOLE page closed, never silently omits-and-continues
 * (Section 8 — "do not silently adopt a malformed foreign Project").
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import { isWellFormedProjectV1, ProjectV1 } from "./types";
import { listActiveProjectsRaw } from "@/lib/firestore/projects";
import { logger } from "@/lib/logger";
import { decodeProjectsCursor, encodeProjectsCursor } from "./projectsCursor";

export interface ListedTeamProject {
  project: ProjectV1;
  documentUpdateTime: Timestamp;
}

export type ListTeamProjectsResult = { status: "ok"; items: ListedTeamProject[]; hasMore: boolean; nextCursor?: string } | { status: "invalid_cursor" } | { status: "integrity_violation" } | { status: "lookup_failed" };

export async function listTeamProjects(args: { workspaceId: string; limit: number; cursorRaw?: string | null; status: "active" | "archived" }): Promise<ListTeamProjectsResult> {
  let startAfter: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeProjectsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = decoded.cursor;
  }

  const rawResult = await listActiveProjectsRaw({ workspaceId: args.workspaceId, limit: args.limit, startAfter, status: args.status });
  if (rawResult.status !== "ok") {
    return { status: "lookup_failed" };
  }

  const items: ListedTeamProject[] = [];
  for (const doc of rawResult.items) {
    if (!isWellFormedProjectV1(doc.data)) {
      logger.warn("[projects/listTeam] Integrity violation — malformed Project returned by Workspace-scoped query", { workspaceId: args.workspaceId, docId: doc.id });
      return { status: "integrity_violation" };
    }
    if (doc.data.id !== doc.id) {
      logger.warn("[projects/listTeam] Integrity violation — embedded id mismatch on a document returned by Workspace-scoped query", { workspaceId: args.workspaceId, docId: doc.id, embeddedId: doc.data.id });
      return { status: "integrity_violation" };
    }
    if (doc.data.workspaceId !== args.workspaceId) {
      logger.warn("[projects/listTeam] Integrity violation — workspaceId mismatch on a document returned by Workspace-scoped query", { workspaceId: args.workspaceId, docId: doc.id });
      return { status: "integrity_violation" };
    }
    if (doc.data.status !== args.status) {
      logger.warn("[projects/listTeam] Integrity violation — unexpected status on a document returned by the status-scoped query", { workspaceId: args.workspaceId, docId: doc.id, requestedStatus: args.status, actualStatus: doc.data.status });
      return { status: "integrity_violation" };
    }
    items.push({ project: doc.data, documentUpdateTime: doc.updateTime });
  }

  let nextCursor: string | undefined;
  if (rawResult.hasMore && items.length > 0) {
    const last = items[items.length - 1].project;
    nextCursor = encodeProjectsCursor({ createdAtSeconds: last.createdAt.seconds, createdAtNanoseconds: last.createdAt.nanoseconds, lastDocId: last.id });
  }

  return { status: "ok", items, hasMore: rawResult.hasMore, ...(nextCursor ? { nextCursor } : {}) };
}
