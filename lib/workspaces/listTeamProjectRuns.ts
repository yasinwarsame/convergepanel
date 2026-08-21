/**
 * Team Run Lists, Phase 8C-B2 — the raw query + fail-WHOLE-FETCHED-WINDOW
 * integrity orchestration for `GET /api/workspaces/{W}/projects/{P}/runs`.
 * The target Project `P` is validated exactly ONCE by the route BEFORE
 * this function is ever called (existence, `ProjectV1` well-formedness,
 * embedded id match, `project.workspaceId === W`) — this module never
 * re-reads the Project document per row, or at all.
 *
 * Every document in the fetched `limit + 1` query window — including the
 * peeked, never-emitted row used only to compute `hasMore` — is validated
 * before any pagination metadata, DTO, or cursor is derived (Phase
 * 8C-B2.1/8C-B2.2 correction: the original implementation validated only
 * the emitted page slice, letting a corrupt peek row silently influence
 * `hasMore` without ever surfacing as `integrity_violation`).
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

    if (allDocs.length === 0) {
      return { status: "ok", items: [], hasMore: false };
    }

    // Validate EVERY fetched document — including the peek row at index
    // `args.limit`, which is never emitted but IS used to compute
    // `hasMore` below (Phase 8C-B2.2 correction).
    const validated = allDocs.map((doc) => ({ doc, result: validateTeamRunRowShape(doc.data(), args.workspaceId) }));

    for (const v of validated) {
      if (!v.result.ok) {
        logger.warn("[workspaces/listTeamProjectRuns] integrity_violation — malformed run row in the fetched window (peek row included), failing whole request", { workspaceId: args.workspaceId, projectId: args.projectId, docId: v.doc.id });
        return { status: "integrity_violation" };
      }
      // The target Project was already validated once by the caller —
      // per-row work here is a cheap in-memory equality check only, never
      // a second Project read.
      if (v.result.projectId !== args.projectId) {
        logger.warn("[workspaces/listTeamProjectRuns] integrity_violation — projectId does not exactly match the requested Project on a row in the fetched window (peek row included)", { workspaceId: args.workspaceId, projectId: args.projectId, docId: v.doc.id });
        return { status: "integrity_violation" };
      }
    }

    // Only now — after the ENTIRE fetched window has passed validation —
    // may pagination metadata, DTOs, and the cursor be derived.
    const hasMore = allDocs.length > args.limit;
    const pageDocs = allDocs.slice(0, args.limit);
    const pageValidated = validated.slice(0, args.limit);

    const items: TeamRunSummaryDto[] = pageValidated.map((v) => {
      const r = v.result as Extract<typeof v.result, { ok: true }>;
      return toTeamRunSummary(v.doc.id, v.doc.data(), r.userId, r.workspaceId, r.projectId);
    });

    const lastScanned = pageDocs[pageDocs.length - 1];
    const lastScannedTs = firestoreSecondsNanos(lastScanned.data().createdAt);
    const nextCursor = hasMore ? encodeWorkspaceRunsCursor({ createdAtSeconds: lastScannedTs.seconds, createdAtNanoseconds: lastScannedTs.nanoseconds, lastDocId: lastScanned.id }) : undefined;

    return { status: "ok", items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (e: unknown) {
    logger.error("[workspaces/listTeamProjectRuns] query failed", { workspaceId: args.workspaceId, projectId: args.projectId, error: e instanceof Error ? e.message : String(e) });
    return { status: "query_failed" };
  }
}
