/**
 * "Projects assigned to me" (owner contract, 2026-11-02): the Project ids of the research in Workspace W that is
 * assigned to the caller.
 *
 * Research assignment is stored on the run (`runs/{id}.assigneeUid`, written by setTeamRunAssignee after a membership
 * check). It never touches the Project's own `assigneeUids`. So a Project filter that reads only `assigneeUids` cannot
 * show a Project whose only link to the caller is assigned research. This reads that second link.
 *
 * Read-only and VIEW-only: the result narrows a list the caller can already read in full (`projects.read`). It is
 * never an authorization decision. The uid is the caller's own authenticated uid, substituted by the route.
 *
 * Query shape is the one the existing research "assigned to me" view already uses (workspaceId ==, assigneeUid ==,
 * createdAt desc, documentId desc), so it runs on the existing composite index. Only `projectId` is read.
 *
 * Bounded: at most MAX_ASSIGNED_RUNS_SCANNED runs. Reaching the bound returns `too_many`; the caller fails closed
 * rather than silently showing a partial list.
 */

import "server-only";
import { FieldPath, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";

export const ASSIGNED_RUNS_PAGE_SIZE = 500;
export const MAX_ASSIGNED_RUNS_SCANNED = 5000;

export type AssignedResearchProjectIdsResult =
  | { status: "ok"; projectIds: string[] }
  | { status: "integrity_violation" }
  | { status: "too_many" }
  | { status: "read_failed" };

export async function listAssignedResearchProjectIds(args: { workspaceId: string; assigneeUid: string }): Promise<AssignedResearchProjectIdsResult> {
  if (!adminDb) return { status: "read_failed" };
  const projectIds = new Set<string>();
  let scanned = 0;
  let last: QueryDocumentSnapshot | undefined;
  try {
    for (;;) {
      let query = adminDb
        .collection("runs")
        .where("workspaceId", "==", args.workspaceId)
        .where("assigneeUid", "==", args.assigneeUid)
        .orderBy("createdAt", "desc")
        .orderBy(FieldPath.documentId(), "desc")
        .select("projectId");
      if (last) query = query.startAfter(last);
      const snap = await query.limit(ASSIGNED_RUNS_PAGE_SIZE).get();
      for (const doc of snap.docs) {
        const projectId = doc.get("projectId");
        // Unfiled research (no Project) adds no Project.
        if (projectId === null || projectId === undefined) continue;
        if (typeof projectId !== "string" || projectId.length === 0) {
          logger.warn("[projects/assignedResearchProjectIds] integrity_violation — malformed projectId on an assigned run", { workspaceId: args.workspaceId, runId: doc.id });
          return { status: "integrity_violation" };
        }
        projectIds.add(projectId);
      }
      scanned += snap.docs.length;
      if (snap.docs.length < ASSIGNED_RUNS_PAGE_SIZE) break;
      if (scanned >= MAX_ASSIGNED_RUNS_SCANNED) {
        logger.warn("[projects/assignedResearchProjectIds] assigned-run scan bound reached; failing closed", { workspaceId: args.workspaceId, scanned });
        return { status: "too_many" };
      }
      last = snap.docs[snap.docs.length - 1];
    }
  } catch (err) {
    logger.warn("[projects/assignedResearchProjectIds] read failed", { workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
  return { status: "ok", projectIds: Array.from(projectIds) };
}
