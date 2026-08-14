/**
 * HTTP API route (user/panel-history): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import type { PanelHistoryItem, PanelHistoryResearchItem } from "@/lib/user/panelHistory";
import type { ModelId } from "@/lib/types";
import { createRunWorkspaceIntegrityBatch } from "@/lib/workspaces/runWorkspaceIntegrityBatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 30;
/** Max docs pulled per collection before merge (cap total merged list). */
const FETCH_CAP = 120;

function normalizeGovernanceStatus(
  v: unknown
): "approved" | "needs_review" | "blocked" | undefined {
  if (v === "approved" || v === "needs_review" || v === "blocked") return v;
  return undefined;
}

function firestoreMillis(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis: () => number }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  return 0;
}

// Auth Identity Consistency Remediation, Step 7 — resolves via the
// shared, hardened resolver rather than this route's own duplicated
// cookie-first logic. Response shape for auth failures is unchanged.
async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/panel-history", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json(
      { ok: false, errorCode: "unauthorized", message: "Please sign in." },
      { status: 401 }
    );
  }
  return NextResponse.json(
    { ok: false, errorCode: "auth_error", message: "Authentication failed." },
    { status: 401 }
  );
}

export async function GET(req: NextRequest) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  if (!adminDb) {
    return NextResponse.json(
      { ok: false, errorCode: "internal_error", message: "Database unavailable." },
      { status: 500 }
    );
  }

  const { searchParams } = req.nextUrl;
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(searchParams.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT)
  );

  try {
    const [runsSnap, verSnap, videoSnap] = await Promise.all([
      adminDb
        .collection("runs")
        .where("userId", "==", uid)
        .orderBy("createdAt", "desc")
        .limit(FETCH_CAP)
        .get(),
      adminDb
        .collection("verifications")
        .where("userId", "==", uid)
        .orderBy("timestamp", "desc")
        .limit(FETCH_CAP)
        .get(),
      adminDb
        .collection("videoVerifications")
        .where("userId", "==", uid)
        .orderBy("timestamp", "desc")
        .limit(FETCH_CAP)
        .get(),
    ]);

    const merged: Array<{ sortKey: number; item: PanelHistoryItem }> = [];

    // Phase 4B — Mandatory Workspace Integrity for the owner-scoped `runs`
    // rows in this list. Every surviving row here has `userId === uid` (the
    // authenticated caller), so every bound row shares the SAME
    // deterministic Workspace — the batch validator collapses this to
    // exactly one Firestore read for the entire page, not one per row.
    // Legacy rows (workspaceId truly absent) never trigger a read at all.
    const validateWorkspace = createRunWorkspaceIntegrityBatch();
    const ownedRunDocs = runsSnap.docs.filter((d) => String(d.data().userId ?? "") === uid);
    const integrityResults = await Promise.all(
      ownedRunDocs.map((d) => validateWorkspace(uid, d.data()))
    );

    for (let i = 0; i < ownedRunDocs.length; i++) {
      const d = ownedRunDocs[i];
      const integrity = integrityResults[i];
      if (integrity.classification === "invalid") {
        logger.warn("[user/panel-history] workspace_run_integrity_failed", { runId: d.id, reason: integrity.reason });
        continue;
      }
      const data = d.data();
      const sortKey = firestoreMillis(data.createdAt);
      const perModel =
        data.runDocument?.perModel ??
        (data.resultsCompact as { perModel?: unknown[] } | undefined)?.perModel;
      const modelsTotal = Array.isArray(perModel)
        ? perModel.length
        : Array.isArray(data.selectedModels)
          ? data.selectedModels.length
          : 0;
      const modelsOk = Array.isArray(perModel)
        ? perModel.filter((p: { status?: string }) => p.status === "ok").length
        : undefined;

      const synSum = data.synthesisConsensusSummary as { overallConsensusScore?: number } | undefined;
      const synthesisConsensusScore =
        typeof synSum?.overallConsensusScore === "number" ? synSum.overallConsensusScore : undefined;

      // Query-Routing Redesign, Phase 1 — summary-only: read just the
      // discriminator field off the persisted envelope, never the full
      // result/meta. Absent (not false) when no envelope exists at all.
      const adaptiveOutput = data.adaptiveOutput as { schemaId?: unknown } | undefined;
      const hasAdaptiveOutput = !!adaptiveOutput && typeof adaptiveOutput.schemaId === "string";
      const adaptiveSchemaId = hasAdaptiveOutput ? (adaptiveOutput!.schemaId as PanelHistoryResearchItem["adaptiveSchemaId"]) : undefined;

      merged.push({
        sortKey,
        item: {
          type: "research",
          id: d.id,
          at: new Date(sortKey || Date.now()).toISOString(),
          question: String(data.question ?? ""),
          selectedModels: (Array.isArray(data.selectedModels) ? data.selectedModels : []) as ModelId[],
          status: typeof data.status === "string" ? data.status : undefined,
          modelsOk,
          modelsTotal: modelsTotal || undefined,
          synthesisConsensusScore,
          governanceStatus: normalizeGovernanceStatus(data.governanceStatus),
          ...(hasAdaptiveOutput ? { hasAdaptiveOutput, adaptiveSchemaId } : {}),
        },
      });
    }

    for (const d of verSnap.docs) {
      const data = d.data() as Partial<ClaimVerificationFirestoreDoc>;
      if (String(data.userId ?? "") !== uid) continue;
      if (data.type != null && data.type !== "claim_verification") continue;
      const sortKey = firestoreMillis(data.timestamp);
      merged.push({
        sortKey,
        item: {
          type: "verification",
          id: d.id,
          at: new Date(sortKey || Date.now()).toISOString(),
          claim: String(data.claim ?? ""),
          verdict: String(data.verdict ?? "unverifiable"),
          consensusScore: typeof data.consensusScore === "number" ? data.consensusScore : 0,
          governanceStatus: normalizeGovernanceStatus(data.governanceStatus),
        },
      });
    }

    for (const d of videoSnap.docs) {
      const data = d.data();
      if (String(data.userId ?? "") !== uid) continue;
      if (data.type != null && data.type !== "video_verification") continue;
      const sortKey = firestoreMillis(data.timestamp);
      const meta = data.metadata as { duration?: number } | undefined;
      const durationSec =
        meta && typeof meta.duration === "number" && Number.isFinite(meta.duration) ? meta.duration : 0;
      merged.push({
        sortKey,
        item: {
          type: "video_verification",
          id: d.id,
          at: new Date(sortKey || Date.now()).toISOString(),
          fileName: typeof data.fileName === "string" ? data.fileName : "Uploaded video",
          durationSeconds: durationSec,
          verdict: String(data.verdict ?? "inconclusive"),
          consensusScore: typeof data.consensusScore === "number" ? data.consensusScore : 0,
          governanceStatus: normalizeGovernanceStatus(data.governanceStatus),
        },
      });
    }

    merged.sort((a, b) => b.sortKey - a.sortKey);

    const total = merged.length;
    const start = (page - 1) * limit;
    const items = merged.slice(start, start + limit).map((m) => m.item);
    const hasMore = start + items.length < total;

    return NextResponse.json({
      ok: true,
      items,
      page,
      limit,
      total,
      hasMore,
    });
  } catch (e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    logger.error("[user/panel-history] query failed", { error: msg });
    if (msg.includes("index") || msg.includes("FAILED_PRECONDITION")) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "index_required",
          message: "Unable to load activity history. Please try again.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { ok: false, errorCode: "internal_error", message: "Could not load history." },
      { status: 500 }
    );
  }
}
