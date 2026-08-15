/**
 * Phase 5B — GET /api/user/workspace/runs. Backend-only: no UI reads this
 * yet. Read-only, cursor-paginated list of the authenticated caller's own
 * Personal-Workspace-bound `runs` — never `verifications`/
 * `videoVerifications`, since `workspaceId` is written only onto `runs`
 * documents (Phase 3's write scope was always `run-panel`/`createRun()`
 * only). See docs/workspaces/phase5a-workspace-ui-architecture.md for the
 * full contract this implements.
 *
 * Scope (`userId==uid AND workspaceId==personal-{uid}`) is reconstructed
 * from the authenticated session on EVERY request — never from `cursor`,
 * `limit`, or any other client-supplied value. A cursor only ever moves
 * pagination position within that fixed scope; see
 * `lib/workspaces/workspaceRunsCursor.ts`.
 *
 * Legacy runs (`workspaceId` truly absent) are structurally excluded by
 * the query's own `workspaceId==` equality filter — Firestore's `==`
 * never matches a document where the filtered field doesn't exist at all.
 * No post-query filtering decides Workspace membership.
 */

import { NextRequest, NextResponse } from "next/server";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { logger } from "@/lib/logger";
import { adminDb } from "@/lib/firebase/admin";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { createRunWorkspaceIntegrityBatch } from "@/lib/workspaces/runWorkspaceIntegrityBatch";
import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "@/lib/workspaces/workspaceRunsCursor";
import type { ModelId } from "@/lib/types";
import type { QueryType } from "@/lib/adaptiveSchema/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export type WorkspaceRunSummary = {
  id: string;
  at: string;
  question: string;
  selectedModels: ModelId[];
  status?: string;
  modelsOk?: number;
  modelsTotal?: number;
  synthesisConsensusScore?: number;
  governanceStatus?: "approved" | "needs_review" | "blocked";
  hasAdaptiveOutput?: boolean;
  adaptiveSchemaId?: QueryType;
};

function normalizeGovernanceStatus(v: unknown): "approved" | "needs_review" | "blocked" | undefined {
  if (v === "approved" || v === "needs_review" || v === "blocked") return v;
  return undefined;
}

function firestoreMillis(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis: () => number }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  return 0;
}

function toSummary(id: string, data: Record<string, unknown>): WorkspaceRunSummary {
  const sortKey = firestoreMillis(data.createdAt);
  const perModel =
    (data.runDocument as { perModel?: unknown[] } | undefined)?.perModel ??
    (data.resultsCompact as { perModel?: unknown[] } | undefined)?.perModel;
  const modelsTotal = Array.isArray(perModel)
    ? perModel.length
    : Array.isArray(data.selectedModels)
      ? (data.selectedModels as unknown[]).length
      : 0;
  const modelsOk = Array.isArray(perModel)
    ? (perModel as { status?: string }[]).filter((p) => p.status === "ok").length
    : undefined;

  const synSum = data.synthesisConsensusSummary as { overallConsensusScore?: number } | undefined;
  const synthesisConsensusScore = typeof synSum?.overallConsensusScore === "number" ? synSum.overallConsensusScore : undefined;

  const adaptiveOutput = data.adaptiveOutput as { schemaId?: unknown } | undefined;
  const hasAdaptiveOutput = !!adaptiveOutput && typeof adaptiveOutput.schemaId === "string";

  return {
    id,
    at: new Date(sortKey || Date.now()).toISOString(),
    question: String(data.question ?? ""),
    selectedModels: (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[],
    status: typeof data.status === "string" ? data.status : undefined,
    modelsOk,
    modelsTotal: modelsTotal || undefined,
    synthesisConsensusScore,
    governanceStatus: normalizeGovernanceStatus(data.governanceStatus),
    ...(hasAdaptiveOutput ? { hasAdaptiveOutput, adaptiveSchemaId: adaptiveOutput!.schemaId as QueryType } : {}),
  };
}

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/workspace/runs", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!adminDb) {
    return NextResponse.json({ ok: false, errorCode: "internal_error", message: "Database unavailable." }, { status: 500 });
  }

  const idResult = getPersonalWorkspaceId(uid);
  if (!idResult.ok) {
    return NextResponse.json({ ok: false, errorCode: "workspace_invalid", message: "Unable to load your Workspace." }, { status: 400 });
  }
  const workspaceId = idResult.workspaceId;

  const { searchParams } = req.nextUrl;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));

  const rawCursor = searchParams.get("cursor");
  let startAfter: { createdAtMillis: number; lastDocId: string } | undefined;
  if (rawCursor != null) {
    const decoded = decodeWorkspaceRunsCursor(rawCursor);
    if (!decoded.ok) {
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    }
    startAfter = decoded.cursor;
  }

  try {
    // Scope is reconstructed here, from the authenticated uid alone, on
    // every request — the cursor (decoded above) supplies only ordering
    // position, never userId/workspaceId.
    let query = adminDb
      .collection("runs")
      .where("userId", "==", uid)
      .where("workspaceId", "==", workspaceId)
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");

    if (startAfter) {
      query = query.startAfter(Timestamp.fromMillis(startAfter.createdAtMillis), startAfter.lastDocId);
    }

    // Peek one extra document (`limit + 1`) purely to determine `hasMore`
    // without a second query. The peeked document's data is never
    // returned to the client and never contributes to the response
    // cursor — only documents within the `limit`-sized page window do.
    const snap = await query.limit(limit + 1).get();
    const allDocs = snap.docs;
    const hasMore = allDocs.length > limit;
    const pageDocs = allDocs.slice(0, limit);

    if (pageDocs.length === 0) {
      // Genuinely no rows in scope — either a brand-new Workspace or one
      // with zero bound runs. Not a failure.
      return NextResponse.json({ ok: true, items: [], hasMore: false });
    }

    // Phase 4B Layer A, batched — every row here shares the identical
    // (userId, workspaceId) pair by construction of the query above, so
    // this collapses to exactly one underlying Workspace lookup for the
    // entire page, and (provably, not just typically) every row either
    // ALL pass or ALL fail together, since they share one cache key.
    const validateWorkspace = createRunWorkspaceIntegrityBatch();
    const integrityResults = await Promise.all(pageDocs.map((d) => validateWorkspace(d.data())));

    const items: WorkspaceRunSummary[] = [];
    let invalidCount = 0;
    for (let i = 0; i < pageDocs.length; i++) {
      const integrity = integrityResults[i];
      if (integrity.classification === "invalid") {
        invalidCount++;
        logger.warn("[user/workspace/runs] workspace_run_integrity_failed", { runId: pageDocs[i].id, reason: integrity.reason });
        continue;
      }
      items.push(toSummary(pageDocs[i].id, pageDocs[i].data()));
    }

    if (invalidCount === pageDocs.length) {
      // Every row in the page window failed together — per the shared
      // single-Workspace-lookup invariant above, this means the caller's
      // Personal Workspace itself is currently unresolvable, not that
      // these specific runs are individually corrupt. Returning
      // items:[] here would misleadingly read as "this Workspace is
      // empty" when it isn't — fail the whole request instead so the
      // client can distinguish "empty" from "temporarily broken."
      logger.warn("[user/workspace/runs] shared_workspace_lookup_failed", { pageSize: pageDocs.length });
      return NextResponse.json(
        { ok: false, errorCode: "workspace_unavailable", message: "Couldn't load your Workspace right now. Please try again." },
        { status: 503 }
      );
    }

    // Cursor advances from the LAST document actually scanned within the
    // page window (`pageDocs`), regardless of whether that document was
    // individually valid or omitted — never from the last VALID item
    // returned. Using the last valid item instead would let an
    // omitted-invalid row sitting at the page boundary be re-scanned on
    // every subsequent page request, forever.
    const lastScanned = pageDocs[pageDocs.length - 1];
    const nextCursor = hasMore
      ? encodeWorkspaceRunsCursor({ createdAtMillis: firestoreMillis(lastScanned.data().createdAt), lastDocId: lastScanned.id })
      : undefined;

    return NextResponse.json({
      ok: true,
      items,
      hasMore,
      ...(nextCursor ? { nextCursor } : {}),
    });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    logger.error("[user/workspace/runs] query failed", { error: msg });
    if (msg.includes("index") || msg.includes("FAILED_PRECONDITION")) {
      return NextResponse.json(
        { ok: false, errorCode: "index_required", message: "Unable to load your Workspace right now. Please try again." },
        { status: 503 }
      );
    }
    return NextResponse.json({ ok: false, errorCode: "internal_error", message: "Could not load your Workspace." }, { status: 500 });
  }
}
