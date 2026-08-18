/**
 * Project Read Foundation, Phase 7A — raw, unvalidated Firestore query for
 * `GET /api/user/project-runs`. Structural sibling of
 * `lib/firestore/projects.ts`'s `listActiveProjectsRaw()`: a thin I/O
 * layer only, returning unvalidated data. Per-document
 * structural/association-integrity validation is the CALLER's
 * responsibility (`lib/projects/listProjectRunsForOwner.ts`) — kept out
 * of this layer for the same reason `listActiveProjectsRaw()` keeps
 * validation out of itself (see that function's own doc comment): a
 * list query's validation policy is a caller-specific product decision,
 * not a generic Firestore-read concern. Lives in `lib/projects/` (not
 * `lib/firestore/runs.ts`) because this is Project-domain functionality
 * that happens to query the `runs` collection — the same placement
 * `associateRunWithProject.ts` and `validateRunWorkspaceBinding.ts`
 * already use for the identical reason.
 */

import "server-only";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";

export interface ListRunsByProjectScopeRawItem {
  data: Record<string, unknown>;
  id: string;
}

export type ListRunsByProjectScopeRawResult = { status: "ok"; items: ListRunsByProjectScopeRawItem[]; hasMore: boolean } | { status: "firestore_unavailable" } | { status: "read_failed" };

export async function listRunsByProjectScopeRaw(args: {
  userId: string;
  workspaceId: string;
  /** `null` queries Unfiled runs; a string queries runs assigned to that exact Project. */
  projectId: string | null;
  limit: number;
  startAfter?: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string };
}): Promise<ListRunsByProjectScopeRawResult> {
  if (!adminDb) {
    return { status: "firestore_unavailable" };
  }
  try {
    let query = adminDb
      .collection("runs")
      .where("userId", "==", args.userId)
      .where("workspaceId", "==", args.workspaceId)
      .where("projectId", "==", args.projectId)
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");

    if (args.startAfter) {
      query = query.startAfter(new Timestamp(args.startAfter.createdAtSeconds, args.startAfter.createdAtNanoseconds), args.startAfter.lastDocId);
    }

    // Peek one extra document to determine `hasMore` without a second
    // query — mirrors `listActiveProjectsRaw()`'s identical technique.
    const snap = await query.limit(args.limit + 1).get();
    const allDocs = snap.docs;
    const hasMore = allDocs.length > args.limit;
    const pageDocs = allDocs.slice(0, args.limit);

    return {
      status: "ok",
      items: pageDocs.map((d) => ({ data: d.data(), id: d.id })),
      hasMore,
    };
  } catch (err) {
    logger.warn("[projects/listRunsByProjectScopeRaw] Failed to list runs", { userId: args.userId, workspaceId: args.workspaceId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}
