/**
 * TEAM-VERIFICATION-PARITY-R5-I1 — query + fail-whole-window integrity
 * orchestration for the Team Video verification lists:
 *
 *   - `GET /api/workspaces/{W}/video-verifications`                    scope "all"
 *   - `GET /api/workspaces/{W}/video-verifications?scope=unfiled`      scope "unfiled"
 *   - `GET /api/workspaces/{W}/projects/{P}/video-verifications`       scope "project"
 *
 * Deliberately mirrors `listTeamClaimVerifications()` rather than abstracting
 * with it (R5-D0 §V): the two collections have different row validators,
 * different summary strictness and different verdict vocabularies, and a
 * little duplication is safer than reopening Production-stable Claim code.
 *
 * - No `userId`/creator/uploader/dedup-requester predicate of any kind.
 *   Workspace membership plus `research.read` (checked by the route before
 *   this runs) is the whole authorization model, so member B reads a Video
 *   member A uploaded.
 * - Scope comes ONLY from the addressed URL. The cursor carries ordering
 *   position alone.
 * - Every document in the fetched `limit + 1` window — INCLUDING the peek row
 *   used only for `hasMore` — must pass
 *   `validateTeamVideoVerificationRowShape()` against the addressed Workspace,
 *   plus the scope's own Project containment, and must yield a complete strict
 *   summary. Any failure aborts the WHOLE request with `integrity_violation`:
 *   never a partial page, never a row silently dropped, never a pagination
 *   signal derived from an unvalidated document.
 * - Scope "all" batch-validates every unique non-null `projectId` in the whole
 *   window (peek row included) in ONE `getAll()`; zero references means zero
 *   Project reads. A missing, malformed, id-mismatched or foreign-Workspace
 *   Project fails the whole request. An ARCHIVED Project is valid and readable.
 * - Scope "unfiled" reads no Project at all. Scope "project" receives the
 *   Project the route already validated exactly once and reads no Project here.
 * - `hasMore` is STRUCTURALLY derived from `nextCursor`, so the contract
 *   "`hasMore === true` implies a usable cursor" cannot be broken by a later
 *   edit without also removing the cursor (see the end of the function).
 *
 * Read-only: no write, provider execution, quota, usage charge, video counter,
 * token accounting, governance evaluation or repair/backfill of any kind.
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { isWellFormedProjectV1 } from "@/lib/projects/types";
import { validateTeamVideoVerificationRowShape } from "./teamVideoVerificationRowValidation";
import { decodeTeamVideoVerificationsCursor, encodeTeamVideoVerificationsCursor } from "./teamVideoVerificationsCursor";
import { toTeamVideoVerificationSummary, type TeamVideoVerificationProjectDto, type TeamVideoVerificationSummaryDto } from "./teamVideoVerificationSummary";

export type TeamVideoVerificationsScope = { kind: "all" } | { kind: "unfiled" } | { kind: "project"; project: TeamVideoVerificationProjectDto };

export type ListTeamVideoVerificationsResult =
  | { status: "ok"; items: TeamVideoVerificationSummaryDto[]; hasMore: boolean; nextCursor?: string }
  | { status: "invalid_cursor" }
  | { status: "integrity_violation" }
  | { status: "query_failed" };

const LOG = "[workspaces/listTeamVideoVerifications]";

export async function listTeamVideoVerifications(args: { workspaceId: string; scope: TeamVideoVerificationsScope; limit: number; cursorRaw?: string | null }): Promise<ListTeamVideoVerificationsResult> {
  if (!adminDb) {
    return { status: "query_failed" };
  }
  const db = adminDb;

  // An invalid cursor is rejected BEFORE any Firestore query is issued.
  let startAfter: { seconds: number; nanoseconds: number; lastDocId: string } | undefined;
  if (args.cursorRaw != null) {
    const decoded = decodeTeamVideoVerificationsCursor(args.cursorRaw);
    if (!decoded.ok) {
      return { status: "invalid_cursor" };
    }
    startAfter = { seconds: decoded.cursor.timestampSeconds, nanoseconds: decoded.cursor.timestampNanoseconds, lastDocId: decoded.cursor.lastDocId };
  }

  const scopeLabel = args.scope.kind;
  try {
    let query = db.collection("videoVerifications").where("workspaceId", "==", args.workspaceId);
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

    const rows: Array<{ docId: string; data: Record<string, unknown>; projectId: string | null }> = [];
    for (const doc of allDocs) {
      const data = doc.data() as Record<string, unknown>;
      const result = validateTeamVideoVerificationRowShape(data, args.workspaceId);
      if (!result.ok) {
        logger.warn(`${LOG} integrity_violation — malformed Team Video row in the fetched window (peek row included), failing whole request`, { workspaceId: args.workspaceId, scope: scopeLabel, docId: doc.id });
        return { status: "integrity_violation" };
      }
      // Defense in depth: never trust the query's own Project predicate alone.
      if (args.scope.kind === "unfiled" && result.projectId !== null) {
        logger.warn(`${LOG} integrity_violation — non-null projectId on an unfiled-scoped row`, { workspaceId: args.workspaceId, docId: doc.id });
        return { status: "integrity_violation" };
      }
      if (args.scope.kind === "project" && result.projectId !== args.scope.project.id) {
        logger.warn(`${LOG} integrity_violation — projectId mismatch on a Project-scoped row`, { workspaceId: args.workspaceId, docId: doc.id });
        return { status: "integrity_violation" };
      }
      rows.push({ docId: doc.id, data, projectId: result.projectId });
    }

    const projectLabels = new Map<string, TeamVideoVerificationProjectDto>();
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
    const summaries: TeamVideoVerificationSummaryDto[] = [];
    for (const r of rows) {
      const summary = toTeamVideoVerificationSummary({
        verificationId: r.docId,
        data: r.data,
        workspaceId: args.workspaceId,
        projectId: r.projectId,
        project: r.projectId === null ? null : projectLabels.get(r.projectId) ?? null,
      });
      if (summary === null) {
        logger.warn(`${LOG} integrity_violation — Team Video row missing or malformed summary fields`, { workspaceId: args.workspaceId, docId: r.docId });
        return { status: "integrity_violation" };
      }
      summaries.push(summary);
    }

    // Pagination. `nextCursor` is computed FIRST and `hasMore` is then derived
    // from it, so the two can never disagree: there is no code path that can
    // report another page without also handing back the cursor that reaches it
    // (which would otherwise let a client "load more" by re-fetching page 1).
    let nextCursor: string | undefined;
    if (allDocs.length > args.limit) {
      const lastScanned = allDocs[args.limit - 1];
      const lastTimestamp = (lastScanned.data() as Record<string, unknown>).timestamp;
      const encoded = encodeCursorFor(lastTimestamp, lastScanned.id);
      if (encoded === null) {
        logger.warn(`${LOG} integrity_violation — could not encode a cursor for the last scanned row`, { workspaceId: args.workspaceId, docId: lastScanned.id });
        return { status: "integrity_violation" };
      }
      nextCursor = encoded;
    }

    return { status: "ok", items: summaries.slice(0, args.limit), hasMore: nextCursor !== undefined, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  } catch (e: unknown) {
    logger.error(`${LOG} query failed`, { workspaceId: args.workspaceId, scope: scopeLabel, error: e instanceof Error ? e.message : String(e) });
    return { status: "query_failed" };
  }
}

/**
 * Strict seconds/nanoseconds extraction for the cursor position. The row
 * validator has already proven `timestamp` is a real `Timestamp`, so `null`
 * here means the window is internally inconsistent and the caller must fail
 * the whole request rather than emit a cursor that cannot resume the scan.
 */
function encodeCursorFor(timestamp: unknown, lastDocId: string): string | null {
  if (!timestamp || typeof timestamp !== "object") return null;
  const t = timestamp as { seconds?: unknown; nanoseconds?: unknown };
  if (typeof t.seconds !== "number" || !Number.isInteger(t.seconds) || t.seconds < 0) return null;
  if (typeof t.nanoseconds !== "number" || !Number.isInteger(t.nanoseconds) || t.nanoseconds < 0 || t.nanoseconds > 999_999_999) return null;
  if (typeof lastDocId !== "string" || lastDocId.length === 0) return null;
  const encoded = encodeTeamVideoVerificationsCursor({ timestampSeconds: t.seconds, timestampNanoseconds: t.nanoseconds, lastDocId });
  return typeof encoded === "string" && encoded.length > 0 ? encoded : null;
}
