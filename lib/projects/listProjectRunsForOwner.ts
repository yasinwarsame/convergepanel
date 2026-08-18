/**
 * Project Read Foundation, Phase 7A — `GET /api/user/project-runs`'s full
 * orchestration: resolve the caller's own Personal Workspace, resolve the
 * target Project (project scope only — `resolveProjectForOwner()` finds
 * an archived Project exactly like an active one; archiving a Project
 * never detaches its existing run associations), run the caller-scoped
 * `runs` query via `listRunsByProjectScopeRaw()`, then validate every
 * returned document.
 *
 * Integrity policy deliberately matches `listProjectsForOwner.ts`'s
 * fail-whole-page-closed choice, NOT `GET /api/user/workspace/runs`'s
 * omit-and-continue choice: a query that's supposed to be scoped to
 * exactly this Project (or exactly Unfiled) returning something that
 * violates that scope is itself the structural problem worth surfacing
 * loudly. The completed Phase 6D normalization means "Unfiled" is now a
 * simple, enforced invariant (`projectId === null`, never merely
 * "missing") — this module treats any row that doesn't exactly match that
 * invariant as corruption, never silently reinterprets it as compatible.
 */

import "server-only";
import type { Timestamp } from "firebase-admin/firestore";
import { logger } from "@/lib/logger";
import { resolvePersonalWorkspaceForOwner, type ResolvePersonalWorkspaceForOwnerResult } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import { resolveProjectForOwner, type ResolveProjectForOwnerResult } from "./resolveProjectForOwner";
import type { ProjectV1 } from "./types";
import { classifyProjectIdFieldState } from "./runProjectNormalizationEligibility";
import { decodeProjectRunsCursor, encodeProjectRunsCursor } from "./projectRunsCursor";
import { toProjectRunSummary, firestoreSecondsNanos, type ProjectRunSummary } from "./projectRunSummary";
import { listRunsByProjectScopeRaw } from "./listRunsByProjectScopeRaw";

export type ProjectRunsScope = { type: "project"; projectId: string } | { type: "unfiled" };

export type ListProjectRunsForOwnerResult =
  | {
      status: "ok";
      items: ProjectRunSummary[];
      hasMore: boolean;
      nextCursor?: string;
      /** Present only for project scope — the authorized Project's own display metadata, so Phase 7 can render a direct Project page without a separate detail GET (Phase 6's frozen "no Project detail endpoint" decision). */
      projectMeta?: { project: ProjectV1; documentUpdateTime: Timestamp };
    }
  | { status: "invalid_cursor" }
  | { status: "integrity_violation" }
  | { status: "query_failed" }
  | { status: "workspace_failure"; workspaceStatus: Exclude<ResolvePersonalWorkspaceForOwnerResult["status"], "found"> }
  | { status: "project_failure"; projectStatus: Exclude<ResolveProjectForOwnerResult["status"], "found"> };

export async function listProjectRunsForOwner(args: { uid: string; scope: ProjectRunsScope; limit: number; cursorRaw?: string | null }): Promise<ListProjectRunsForOwnerResult> {
  const workspaceResult = await resolvePersonalWorkspaceForOwner(args.uid);
  if (workspaceResult.status !== "found") {
    return { status: "workspace_failure", workspaceStatus: workspaceResult.status };
  }
  const workspaceId = workspaceResult.workspace.id;

  let projectMeta: { project: ProjectV1; documentUpdateTime: Timestamp } | undefined;
  if (args.scope.type === "project") {
    const projectResult = await resolveProjectForOwner(args.uid, args.scope.projectId);
    if (projectResult.status !== "found") {
      return { status: "project_failure", projectStatus: projectResult.status };
    }
    // Deliberately NOT gated on project.status — an archived Project's
    // existing run associations remain fully readable; only NEW
    // assignment into an archived Project is rejected (that's the
    // association mutation route's concern, not this read).
    projectMeta = { project: projectResult.project, documentUpdateTime: projectResult.documentUpdateTime };
  }

  let startAfter: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeProjectRunsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = decoded.cursor;
  }

  const rawResult = await listRunsByProjectScopeRaw({
    userId: args.uid,
    workspaceId,
    projectId: args.scope.type === "project" ? args.scope.projectId : null,
    limit: args.limit,
    startAfter,
  });
  if (rawResult.status !== "ok") {
    return { status: "query_failed" };
  }

  const items: ProjectRunSummary[] = [];
  for (const doc of rawResult.items) {
    const data = doc.data;

    if (data.userId !== args.uid) {
      logger.warn("[projects/listProjectRuns] Integrity violation — userId mismatch on a row returned by caller-scoped query", { uid: args.uid, docId: doc.id });
      return { status: "integrity_violation" };
    }
    if (data.workspaceId !== workspaceId) {
      logger.warn("[projects/listProjectRuns] Integrity violation — workspaceId mismatch on a row returned by caller-scoped query", { workspaceId, docId: doc.id });
      return { status: "integrity_violation" };
    }

    const hasProjectIdField = Object.prototype.hasOwnProperty.call(data, "projectId");
    const fieldState = classifyProjectIdFieldState({ hasProjectIdField, projectIdValue: data.projectId });

    let resolvedProjectId: string | null;
    if (args.scope.type === "project") {
      if (fieldState !== "assigned" || data.projectId !== args.scope.projectId) {
        logger.warn("[projects/listProjectRuns] Integrity violation — projectId does not exactly match the requested Project on a row returned by caller-scoped query", { docId: doc.id, fieldState });
        return { status: "integrity_violation" };
      }
      resolvedProjectId = args.scope.projectId;
    } else {
      if (fieldState !== "null") {
        // Never reinterprets "absent"/"malformed" as compatible with
        // Unfiled — the Phase 6D normalization invariant means a
        // genuinely Unfiled run's projectId field is always present
        // and exactly `null`, never merely missing.
        logger.warn("[projects/listProjectRuns] Integrity violation — non-null projectId field state on a row returned by the Unfiled-scoped query", { docId: doc.id, fieldState });
        return { status: "integrity_violation" };
      }
      resolvedProjectId = null;
    }

    items.push(toProjectRunSummary(doc.id, data, resolvedProjectId));
  }

  let nextCursor: string | undefined;
  if (rawResult.hasMore && rawResult.items.length > 0) {
    const lastScanned = rawResult.items[rawResult.items.length - 1];
    const lastScannedTs = firestoreSecondsNanos(lastScanned.data.createdAt);
    nextCursor = encodeProjectRunsCursor({ createdAtSeconds: lastScannedTs.seconds, createdAtNanoseconds: lastScannedTs.nanoseconds, lastDocId: lastScanned.id });
  }

  return { status: "ok", items, hasMore: rawResult.hasMore, ...(nextCursor ? { nextCursor } : {}), ...(projectMeta ? { projectMeta } : {}) };
}
