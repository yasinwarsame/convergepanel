/**
 * Team Run Lists, Phase 8C-B2 — the raw query + fail-whole-page integrity
 * orchestration for `GET /api/workspaces/{W}/projects/{P}/runs`. The
 * target Project `P` is validated exactly ONCE by the route BEFORE this
 * function is ever called (existence, `ProjectV1` well-formedness,
 * embedded id match, `project.workspaceId === W`) — this module never
 * re-reads the Project document per row, or at all.
 *
 * No `userId`/creator predicate — identical authorization posture to
 * `listTeamWorkspaceRuns()`.
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "./workspaceRunsCursor";
import { firestoreSecondsNanos } from "@/lib/runs/runSummary";
import { toTeamRunSummary, type TeamRunSummaryDto } from "./teamRunSummary";
import { validateTeamRunRowShape } from "./teamRunRowValidation";

export type ListTeamProjectRunsResult =
  | { status: "ok"; items: TeamRunSummaryDto[]; hasMore: boolean; nextCursor?: string }
  | { status: "invalid_cursor" }
  | { status: "integrity_violation" }
  | { status: "query_failed" };

export async function listTeamProjectRuns(args: { workspaceId: string; projectId: string; limit: number; cursorRaw?: string | null }): Promise<ListTeamProjectRunsResult> {
  if (!adminDb) {
    return { status: "query_failed" };
  }

  let startAfter: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeWorkspaceRunsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = decoded.cursor;
  }

  try {
    let query = adminDb
      .collection("runs")
      .where("workspaceId", "==", args.workspaceId)
      .where("projectId", "==", args.projectId)
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");

    if (startAfter) {
      query = query.startAfter(new Timestamp(startAfter.createdAtSeconds, startAfter.createdAtNanoseconds), startAfter.lastDocId);
    }

    const snap = await query.limit(args.limit + 1).get();
    const allDocs = snap.docs;
    const hasMore = allDocs.length > args.limit;
    const pageDocs = allDocs.slice(0, args.limit);

    if (pageDocs.length === 0) {
      return { status: "ok", items: [], hasMore: false };
    }

    const items: TeamRunSummaryDto[] = [];
    for (const doc of pageDocs) {
      const result = validateTeamRunRowShape(doc.data(), args.workspaceId);
      if (!result.ok) {
        logger.warn("[workspaces/listTeamProjectRuns] integrity_violation — malformed run row, failing whole page", { workspaceId: args.workspaceId, projectId: args.projectId, docId: doc.id });
        return { status: "integrity_violation" };
      }
      // The target Project was already validated once by the caller —
      // per-row work here is a cheap in-memory equality check only, never
      // a second Project read.
      if (result.projectId !== args.projectId) {
        logger.warn("[workspaces/listTeamProjectRuns] integrity_violation — projectId does not exactly match the requested Project on a row returned by the Project-scoped query", { workspaceId: args.workspaceId, projectId: args.projectId, docId: doc.id });
        return { status: "integrity_violation" };
      }
      items.push(toTeamRunSummary(doc.id, doc.data(), result.userId, result.workspaceId, result.projectId));
    }

    const lastScanned = pageDocs[pageDocs.length - 1];
    const lastScannedTs = firestoreSecondsNanos(lastScanned.data().createdAt);
    const nextCursor = hasMore ? encodeWorkspaceRunsCursor({ createdAtSeconds: lastScannedTs.seconds, createdAtNanoseconds: lastScannedTs.nanoseconds, lastDocId: lastScanned.id }) : undefined;

    return { status: "ok", items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (e: unknown) {
    logger.error("[workspaces/listTeamProjectRuns] query failed", { workspaceId: args.workspaceId, projectId: args.projectId, error: e instanceof Error ? e.message : String(e) });
    return { status: "query_failed" };
  }
}
