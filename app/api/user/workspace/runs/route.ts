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
 *
 * Independent-review correction: the caller's Personal Workspace is now
 * validated via `resolvePersonalWorkspaceForOwner()` — the SAME
 * prerequisite helper `GET /api/user/workspace` uses — BEFORE the runs
 * query ever executes. The runs query itself only ever inspects the
 * `runs` collection's own field values, so a missing/malformed Workspace
 * that also happens to have zero bound runs would otherwise be
 * indistinguishable from a genuinely empty, healthy Workspace — the
 * query alone cannot tell those two cases apart. Failure is now detected
 * by an explicit reason from the prerequisite check, never inferred from
 * how many rows passed integrity.
 */

import { NextRequest, NextResponse } from "next/server";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { logger } from "@/lib/logger";
import { adminDb } from "@/lib/firebase/admin";
import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";
import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";
import { personalWorkspaceErrorResponse } from "@/lib/workspaces/personalWorkspaceErrorResponse";
import { createRunWorkspaceIntegrityBatch } from "@/lib/workspaces/runWorkspaceIntegrityBatch";
import { decodeWorkspaceRunsCursor, encodeWorkspaceRunsCursor } from "@/lib/workspaces/workspaceRunsCursor";
import { firestoreSecondsNanos, toRunSummaryBase, type RunSummaryBase } from "@/lib/runs/runSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Phase 7C: now a type alias for the shared `RunSummaryBase` (see `lib/runs/runSummary.ts`) — field shape and every consumer's import path (`@/app/api/user/workspace/runs/route`) are unchanged. */
export type WorkspaceRunSummary = RunSummaryBase;

const toSummary = toRunSummaryBase;

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

  // Prerequisite: validate the caller's own Personal Workspace BEFORE
  // querying runs at all — the same helper GET /api/user/workspace uses,
  // and the same sanitized error mapping, so both endpoints report a
  // missing/malformed/wrong-owner/wrong-type/lookup-failed/disabled
  // Workspace identically. This is what makes "valid Workspace, zero
  // bound runs" distinguishable from "broken Workspace, zero bound
  // runs" — the runs query below cannot tell those apart on its own.
  const workspaceResult = await resolvePersonalWorkspaceForOwner(uid);
  if (workspaceResult.status !== "found") {
    const { status, body } = personalWorkspaceErrorResponse(workspaceResult.status);
    return NextResponse.json(body, { status });
  }

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
  let startAfter: { createdAtSeconds: number; createdAtNanoseconds: number; lastDocId: string } | undefined;
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
      query = query.startAfter(new Timestamp(startAfter.createdAtSeconds, startAfter.createdAtNanoseconds), startAfter.lastDocId);
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
      // The Workspace prerequisite above already confirmed this is a
      // valid, healthy Personal Workspace — so zero matching runs here
      // is genuinely an empty Workspace, not an unresolvable one.
      return NextResponse.json({ ok: true, items: [], hasMore: false });
    }

    // Phase 4B Layer A, batched, kept as defense in depth even though the
    // prerequisite check above already confirmed the shared Workspace is
    // valid — this does not convert "Workspace is valid" into "every run
    // row is automatically valid": each row's own userId/workspaceId
    // relation is still independently checked. Every row here shares the
    // identical (userId, workspaceId) pair by construction of the query,
    // so this collapses to at most one additional Workspace lookup for
    // the whole page (a second lookup relative to the prerequisite check
    // above, since the batch validator has no way to reuse that earlier
    // result — accepted as the cost of not modifying the shared,
    // unmodified Phase 4B primitive).
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
      // Should be unreachable in normal operation now that the
      // prerequisite check above already confirmed the Workspace is
      // valid — kept as a fail-closed safety net for a race where the
      // Workspace becomes invalid between the prerequisite check and
      // this query. items:[] here would misleadingly read as "this
      // Workspace is empty" when it isn't, so the whole request fails
      // retryable instead.
      logger.warn("[user/workspace/runs] shared_workspace_lookup_failed_after_prerequisite_passed", { pageSize: pageDocs.length });
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
    const lastScannedTs = firestoreSecondsNanos(lastScanned.data().createdAt);
    const nextCursor = hasMore
      ? encodeWorkspaceRunsCursor({ createdAtSeconds: lastScannedTs.seconds, createdAtNanoseconds: lastScannedTs.nanoseconds, lastDocId: lastScanned.id })
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
