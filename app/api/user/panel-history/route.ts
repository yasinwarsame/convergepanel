/**
 * HTTP API route (user/panel-history): server handler, auth, and JSON responses.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import type { ClaimVerificationFirestoreDoc } from "@/lib/firestore/verifications";
import type { PanelHistoryItem } from "@/lib/user/panelHistory";
import type { ModelId } from "@/lib/types";

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

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  try {
    const auth = await verifySessionCookie(req);
    if (auth) return auth.uid;
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json(
        { ok: false, errorCode: "unauthorized", message: "Please sign in." },
        { status: 401 }
      );
    }
    const token = authHeader.split("Bearer ")[1];
    const decoded = await verifyIdToken(token);
    return decoded.uid;
  } catch (e: unknown) {
    logger.error("[user/panel-history] auth failed", { error: (e as Error)?.message });
    return NextResponse.json(
      { ok: false, errorCode: "auth_error", message: "Authentication failed." },
      { status: 401 }
    );
  }
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
    const [runsSnap, verSnap] = await Promise.all([
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
    ]);

    const merged: Array<{ sortKey: number; item: PanelHistoryItem }> = [];

    for (const d of runsSnap.docs) {
      const data = d.data();
      if (String(data.userId ?? "") !== uid) continue;
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
          message:
            "Firestore composite index required for panel history. Add indexes on (userId, createdAt desc) for runs and (userId, timestamp desc) for verifications.",
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
