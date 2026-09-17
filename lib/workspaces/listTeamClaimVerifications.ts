/**
 * TEAM-VERIFICATION-PARITY-R3 — query + fail-whole-window integrity
 * orchestration for the Team Claim verification lists:
 *
 *   - `GET /api/workspaces/{W}/verifications`                    scope "all"
 *   - `GET /api/workspaces/{W}/verifications?scope=unfiled`      scope "unfiled"
 *   - `GET /api/workspaces/{W}/projects/{P}/verifications`       scope "project"
 *
 * Mirrors `listTeamWorkspaceRuns()` deliberately:
 *
 * - No `userId`/creator predicate of any kind. Workspace membership plus
 *   `research.read` (checked by the route before this runs) is the whole
 *   authorization model, so member B reads a verification member A created.
 * - Scope comes ONLY from the addressed URL. The cursor carries ordering
 *   position alone.
 * - Every document in the fetched `limit + 1` window, including the peek row
 *   used only for `hasMore`, must pass `validateTeamClaimVerificationRowShape()`
 *   against the addressed Workspace, plus the scope's Project containment, and
 *   yield a usable summary. Any failure aborts the WHOLE request with
 *   `integrity_violation`: never a partial page, never a pagination signal
 *   derived from an unvalidated document.
 * - Scope "all" batch-validates every unique non-null `projectId` in the whole
 *   window (peek row included) in one `getAll()`; zero references means zero
 *   Project reads. A missing, malformed, id-mismatched or foreign-Workspace
 *   Project fails the whole request. The validated Projects supply each
 *   item's public label with no further reads.
 * - Scope "unfiled" reads no Project. Scope "project" receives the Project the
 *   route already validated exactly once and reads no Project here.
 *
 * Read-only: no write, execution, quota, governance or repair of any kind.
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { firestoreSecondsNanos } from "@/lib/runs/runSummary";
import { isWellFormedProjectV1 } from "@/lib/projects/types";
import { validateTeamClaimVerificationRowShape } from "./teamClaimVerificationRowValidation";
import { decodeTeamClaimVerificationsCursor, encodeTeamClaimVerificationsCursor } from "./teamClaimVerificationsCursor";
import { toTeamClaimVerificationSummary, type TeamClaimVerificationProjectDto, type TeamClaimVerificationSummaryDto } from "./teamClaimVerificationSummary";

export type TeamClaimVerificationsScope = { kind: "all" } | { kind: "unfiled" } | { kind: "project"; project: TeamClaimVerificationProjectDto };

export type ListTeamClaimVerificationsResult =
  | { status: "ok"; items: TeamClaimVerificationSummaryDto[]; hasMore: boolean; nextCursor?: string }
  | { status: "invalid_cursor" }
  | { status: "integrity_violation" }
  | { status: "query_failed" };

const LOG = "[workspaces/listTeamClaimVerifications]";

export async function listTeamClaimVerifications(args: { workspaceId: string; scope: TeamClaimVerificationsScope; limit: number; cursorRaw?: string | null }): Promise<ListTeamClaimVerificationsResult> {
  if (!adminDb) {
    return { status: "query_failed" };
  }
  const db = adminDb;

  let startAfter: { seconds: number; nanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeTeamClaimVerificationsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = { seconds: decoded.cursor.timestampSeconds, nanoseconds: decoded.cursor.timestampNanoseconds, lastDocId: decoded.cursor.lastDocId };
  }

  const scopeLabel = args.scope.kind;
  try {
    let query = db.collection("verifications").where("workspaceId", "==", args.workspaceId);
    if (args.scope.kind === "unfiled") {
      query = query.where("projectId", "==", null);
    } else if (args.scope.kind === "project") {
      query = query.where("projectId", "==", args.scope.project.id);
    }
    query = query.orderBy("timestamp", "desc").orderBy(FieldPath.documentId(), "desc");
    if (startAfter) {
      query = query.startAfter(new Timestamp(startAfter.seconds, startAfter.nanoseconds), startAfter.lastDocId);
    }

    const snap = await query.limit(args.limit + 1).get();
    const allDocs = snap.docs;
    if (allDocs.length === 0) {
      return { status: "ok", items: [], hasMore: false };
    }

    const validated = allDocs.map((doc) => ({ doc, data: doc.data() as Record<string, unknown>, result: validateTeamClaimVerificationRowShape(doc.data() as Record<string, unknown>, args.workspaceId) }));

    const rows: Array<{ docId: string; data: Record<string, unknown>; projectId: string | null }> = [];
    for (const v of validated) {
      if (!v.result.ok) {
        logger.warn(`${LOG} integrity_violation — malformed Team Claim row in the fetched window (peek row included), failing whole request`, { workspaceId: args.workspaceId, scope: scopeLabel, docId: v.doc.id });
        return { status: "integrity_violation" };
      }
      // Defense in depth: never trust the query's own Project predicate alone.
      if (args.scope.kind === "unfiled" && v.result.projectId !== null) {
        logger.warn(`${LOG} integrity_violation — non-null projectId on an unfiled-scoped row`, { workspaceId: args.workspaceId, docId: v.doc.id });
        return { status: "integrity_violation" };
      }
      if (args.scope.kind === "project" && v.result.projectId !== args.scope.project.id) {
        logger.warn(`${LOG} integrity_violation — projectId mismatch on a Project-scoped row`, { workspaceId: args.workspaceId, docId: v.doc.id });
        return { status: "integrity_violation" };
      }
      rows.push({ docId: v.doc.id, data: v.data, projectId: v.result.projectId });
    }

    const projectLabels = new Map<string, TeamClaimVerificationProjectDto>();
    if (args.scope.kind === "project") {
      projectLabels.set(args.scope.project.id, args.scope.project);
    } else if (args.scope.kind === "all") {
      const uniqueProjectIds = Array.from(new Set(rows.map((r) => r.projectId).filter((pid): pid is string => pid !== null)));
      if (uniqueProjectIds.length > 0) {
        const projectSnaps = await db.getAll(...uniqueProjectIds.map((pid) => db.collection("projects").doc(pid)));
        for (const psnap of projectSnaps) {
          if (!psnap.exists) continue;
          const pdata = psnap.data();
          if (isWellFormedProjectV1(pdata) && pdata.id === psnap.id && pdata.workspaceId === args.workspaceId) {
            projectLabels.set(psnap.id, { id: pdata.id, name: pdata.name, status: pdata.status });
          }
        }
        for (const pid of uniqueProjectIds) {
          if (!projectLabels.has(pid)) {
            logger.warn(`${LOG} integrity_violation — referenced Project missing/malformed/cross-Workspace (fetched window, peek row included)`, { workspaceId: args.workspaceId, projectId: pid });
            return { status: "integrity_violation" };
          }
        }
      }
    }

    // Every summary in the window must be buildable before anything is emitted.
    const summaries: TeamClaimVerificationSummaryDto[] = [];
    for (const r of rows) {
      const summary = toTeamClaimVerificationSummary({
        verificationId: r.docId,
        data: r.data,
        workspaceId: args.workspaceId,
        projectId: r.projectId,
        project: r.projectId === null ? null : projectLabels.get(r.projectId) ?? null,
      });
      if (summary === null) {
        logger.warn(`${LOG} integrity_violation — Team Claim row missing summary fields`, { workspaceId: args.workspaceId, docId: r.docId });
        return { status: "integrity_violation" };
      }
      summaries.push(summary);
    }

    const hasMore = allDocs.length > args.limit;
    const items = summaries.slice(0, args.limit);
    const lastScanned = allDocs[Math.min(args.limit, allDocs.length) - 1];
    const lastTs = firestoreSecondsNanos((lastScanned.data() as Record<string, unknown>).timestamp);
    const nextCursor = hasMore ? encodeTeamClaimVerificationsCursor({ timestampSeconds: lastTs.seconds, timestampNanoseconds: lastTs.nanoseconds, lastDocId: lastScanned.id }) : undefined;

    return { status: "ok", items, hasMore, ...(nextCursor ? { nextCursor } : {}) };
  } catch (e: unknown) {
    logger.error(`${LOG} query failed`, { workspaceId: args.workspaceId, scope: scopeLabel, error: e instanceof Error ? e.message : String(e) });
    return { status: "query_failed" };
  }
}
