/**
 * Team Run Lists, Phase 8C-B2 — the raw query + fail-whole-page integrity
 * orchestration for `GET /api/workspaces/{W}/runs` (both the general
 * "all" mode and `?scope=unfiled`). No `userId`/creator predicate of any
 * kind — Workspace membership + `research.read` capability (checked by
 * the route, before this function is ever called) is the entire
 * authorization model; the whole point is that member B can read a run
 * created by member A.
 *
 * Fail-whole-page integrity policy (deliberately NOT the Personal
 * historical omit-and-continue pattern — see `docs/workspaces/architecture.md`
 * and the Phase 8C-B.0/8C-B.0.1 audit): any malformed or cross-boundary
 * row aborts the ENTIRE page with `integrity_violation`, never a partial
 * DTO page and never a silently-shrunk result set.
 *
 * "all" mode additionally batch-validates every unique non-null
 * `projectId` referenced by the page in exactly ONE `adminDb.getAll(...)`
 * call — never a per-row Project lookup. Zero non-null `projectId`s in
 * the page means zero Project reads. `?scope=unfiled` never reads a
 * Project at all (its rows have no Project reference by construction of
 * the query and the row validator).
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "./workspaceRunsCursor";
import { firestoreSecondsNanos } from "@/lib/runs/runSummary";
import { toTeamRunSummary, type TeamRunSummaryDto } from "./teamRunSummary";
import { validateTeamRunRowShape } from "./teamRunRowValidation";
import { isWellFormedProjectV1 } from "@/lib/projects/types";

export type TeamWorkspaceRunsScope = "all" | "unfiled";

export type ListTeamWorkspaceRunsResult =
  | { status: "ok"; items: TeamRunSummaryDto[]; hasMore: boolean; nextCursor?: string }
  | { status: "invalid_cursor" }
  | { status: "integrity_violation" }
  | { status: "query_failed" };

export async function listTeamWorkspaceRuns(args: { workspaceId: string; scope: TeamWorkspaceRunsScope; limit: number; cursorRaw?: string | null }): Promise<ListTeamWorkspaceRunsResult> {
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
    // Scope reconstructed purely from the URL's own {workspaceId} — never
    // from the cursor, which carries only ordering position.
    let query = adminDb.collection("runs").where("workspaceId", "==", args.workspaceId);
    if (args.scope === "unfiled") {
      query = query.where("projectId", "==", null);
    }
    query = query.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");

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

    const validated = pageDocs.map((doc) => ({ doc, result: validateTeamRunRowShape(doc.data(), args.workspaceId) }));

    for (const v of validated) {
      if (!v.result.ok) {
        logger.warn("[workspaces/listTeamWorkspaceRuns] integrity_violation — malformed run row, failing whole page", { workspaceId: args.workspaceId, scope: args.scope, docId: v.doc.id });
        return { status: "integrity_violation" };
      }
      // Defense in depth for scope=unfiled: the query's own `projectId==null`
      // filter should already guarantee this, but never trust that alone.
      if (args.scope === "unfiled" && v.result.projectId !== null) {
        logger.warn("[workspaces/listTeamWorkspaceRuns] integrity_violation — non-null projectId on a row returned by the unfiled-scoped query", { workspaceId: args.workspaceId, docId: v.doc.id });
        return { status: "integrity_violation" };
      }
    }

    if (args.scope === "all") {
      const uniqueProjectIds = Array.from(
        new Set(
          validated
            .map((v) => (v.result.ok ? v.result.projectId : null))
            .filter((pid): pid is string => pid !== null)
        )
      );

      if (uniqueProjectIds.length > 0) {
        const refs = uniqueProjectIds.map((pid) => adminDb!.collection("projects").doc(pid));
        const projectSnaps = await adminDb.getAll(...refs);
        const validatedProjectIds = new Set<string>();
        for (const psnap of projectSnaps) {
          if (!psnap.exists) continue;
          const pdata = psnap.data();
          if (isWellFormedProjectV1(pdata) && pdata.id === psnap.id && pdata.workspaceId === args.workspaceId) {
            validatedProjectIds.add(psnap.id);
          }
        }
        for (const pid of uniqueProjectIds) {
          if (!validatedProjectIds.has(pid)) {
            logger.warn("[workspaces/listTeamWorkspaceRuns] integrity_violation — referenced Project missing/malformed/cross-Workspace", { workspaceId: args.workspaceId, projectId: pid });
            return { status: "integrity_violation" };
          }
        }
      }
    }

    const items: TeamRunSummaryDto[] = validated.map((v) => {
      const r = v.result as Extract<typeof v.result, { ok: true }>;
      return toTeamRunSummary(v.doc.id, v.doc.data(), r.userId, r.workspaceId, r.projectId);
    });

    const lastScanned = pageDocs[pageDocs.length - 1];
    const lastScannedTs = firestoreSecondsNanos(lastScanned.data().createdAt);
    const nextCursor = hasMore ? encodeWorkspaceRunsCursor({ createdAtSeconds: lastScannedTs.seconds, createdAtNanoseconds: lastScannedTs.nanoseconds, lastDocId: lastScanned.id }) : undefined;

    return { status: "ok", items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (e: unknown) {
    logger.error("[workspaces/listTeamWorkspaceRuns] query failed", { workspaceId: args.workspaceId, scope: args.scope, error: e instanceof Error ? e.message : String(e) });
    return { status: "query_failed" };
  }
}
