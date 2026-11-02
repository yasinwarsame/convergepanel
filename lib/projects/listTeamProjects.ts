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
import { adminDb } from "@/lib/firebase/admin";
import { listAssignedResearchProjectIds } from "./assignedResearchProjectIds";

export interface ListedTeamProject {
  project: ProjectV1;
  documentUpdateTime: Timestamp;
}

export type ListTeamProjectsResult = { status: "ok"; items: ListedTeamProject[]; hasMore: boolean; nextCursor?: string } | { status: "invalid_cursor" } | { status: "integrity_violation" } | { status: "lookup_failed" };

/**
 * "Projects assigned to me" union bound. A Team Workspace holds at most 200 Projects (the create route's cap), so the
 * directly assigned set is read in one bounded query. Anything at or past this bound fails closed.
 */
export const MAX_ASSIGNED_PROJECTS_SCANNED = 500;

export async function listTeamProjects(args: {
  workspaceId: string;
  limit: number;
  cursorRaw?: string | null;
  status: "active" | "archived";
  assigneeUid?: string;
  /**
   * Owner contract (2026-11-02): with `assigneeUid`, also include Projects that contain research assigned to that same
   * uid. The route sets this only when the caller is currently an eligible research assignee (D4). View-only.
   */
  includeAssignedResearch?: boolean;
}): Promise<ListTeamProjectsResult> {
  if (args.assigneeUid !== undefined && args.includeAssignedResearch === true) {
    return listProjectsAssignedOrWithAssignedResearch({ ...args, assigneeUid: args.assigneeUid });
  }
  let startAfter: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeProjectsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = decoded.cursor;
  }

  const rawResult = await listActiveProjectsRaw({ workspaceId: args.workspaceId, limit: args.limit, startAfter, status: args.status, assigneeUid: args.assigneeUid });
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

/** The integrity checks every listed Project passes, whichever link put it on the list. */
function checkListedProject(data: unknown, docId: string, workspaceId: string): { ok: true; project: ProjectV1 } | { ok: false; problem: string } {
  if (!isWellFormedProjectV1(data)) return { ok: false, problem: "malformed Project" };
  if (data.id !== docId) return { ok: false, problem: "embedded id mismatch" };
  if (data.workspaceId !== workspaceId) return { ok: false, problem: "workspaceId mismatch" };
  return { ok: true, project: data };
}

/** createdAt DESC, documentId DESC — the order of the Workspace-scoped query and of its cursor. */
function compareListOrder(a: ProjectV1, b: ProjectV1): number {
  if (a.createdAt.seconds !== b.createdAt.seconds) return b.createdAt.seconds - a.createdAt.seconds;
  if (a.createdAt.nanoseconds !== b.createdAt.nanoseconds) return b.createdAt.nanoseconds - a.createdAt.nanoseconds;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * "Projects assigned to me" = Projects directly assigned to the uid (`assigneeUids`) UNION Projects containing research
 * assigned to the uid (`runs.assigneeUid`), in the requested status, each listed once, in the same order and cursor
 * format as every other page of this list.
 *
 * Both sets are bounded (a Workspace holds at most 200 Projects), so the union is built in full and paged in memory.
 * Integrity policy is the list's own: any malformed, mismatched or missing Project fails the whole page. A Project in
 * the other status (e.g. archived while research in it is still assigned) is simply not in this status's list.
 */
async function listProjectsAssignedOrWithAssignedResearch(args: { workspaceId: string; limit: number; cursorRaw?: string | null; status: "active" | "archived"; assigneeUid: string }): Promise<ListTeamProjectsResult> {
  let startAfter: ProjectV1 | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeProjectsCursor(args.cursorRaw);
    if (!decoded.ok) return { status: "invalid_cursor" };
    const c = decoded.cursor;
    // Only the ordering fields are compared.
    startAfter = { id: c.lastDocId, createdAt: { seconds: c.createdAtSeconds, nanoseconds: c.createdAtNanoseconds } } as unknown as ProjectV1;
  }

  const direct = await listActiveProjectsRaw({ workspaceId: args.workspaceId, limit: MAX_ASSIGNED_PROJECTS_SCANNED, status: args.status, assigneeUid: args.assigneeUid });
  if (direct.status !== "ok") return { status: "lookup_failed" };
  if (direct.hasMore) {
    logger.warn("[projects/listTeam] assigned-Project scan bound reached; failing closed", { workspaceId: args.workspaceId });
    return { status: "lookup_failed" };
  }

  const byId = new Map<string, ListedTeamProject>();
  for (const doc of direct.items) {
    const checked = checkListedProject(doc.data, doc.id, args.workspaceId);
    if (!checked.ok || checked.project.status !== args.status) {
      logger.warn("[projects/listTeam] Integrity violation on a directly assigned Project", { workspaceId: args.workspaceId, docId: doc.id, problem: checked.ok ? "unexpected status" : checked.problem });
      return { status: "integrity_violation" };
    }
    byId.set(doc.id, { project: checked.project, documentUpdateTime: doc.updateTime });
  }

  const research = await listAssignedResearchProjectIds({ workspaceId: args.workspaceId, assigneeUid: args.assigneeUid });
  if (research.status === "integrity_violation") return { status: "integrity_violation" };
  if (research.status !== "ok") return { status: "lookup_failed" };

  const toFetch = research.projectIds.filter((id) => !byId.has(id));
  if (toFetch.length > 0) {
    if (!adminDb) return { status: "lookup_failed" };
    let snaps;
    try {
      snaps = await adminDb.getAll(...toFetch.map((id) => adminDb!.collection("projects").doc(id)));
    } catch (err) {
      logger.warn("[projects/listTeam] Failed to read Projects containing assigned research", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
      return { status: "lookup_failed" };
    }
    for (const snap of snaps) {
      const checked = snap.exists ? checkListedProject(snap.data(), snap.id, args.workspaceId) : ({ ok: false, problem: "missing Project" } as const);
      if (!checked.ok) {
        logger.warn("[projects/listTeam] Integrity violation on a Project referenced by assigned research", { workspaceId: args.workspaceId, docId: snap.id, problem: checked.problem });
        return { status: "integrity_violation" };
      }
      if (checked.project.status !== args.status) continue;
      byId.set(snap.id, { project: checked.project, documentUpdateTime: snap.updateTime as Timestamp });
    }
  }

  const ordered = Array.from(byId.values()).sort((a, b) => compareListOrder(a.project, b.project));
  const remaining = startAfter ? ordered.filter((item) => compareListOrder(startAfter!, item.project) < 0) : ordered;
  const items = remaining.slice(0, args.limit);
  const hasMore = remaining.length > args.limit;
  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const last = items[items.length - 1].project;
    nextCursor = encodeProjectsCursor({ createdAtSeconds: last.createdAt.seconds, createdAtNanoseconds: last.createdAt.nanoseconds, lastDocId: last.id });
  }
  return { status: "ok", items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
}
