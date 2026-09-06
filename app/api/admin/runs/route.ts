/**
 * Admin runs list: research runs, claim verifications, and video verifications (merged, sorted).
 */

import { NextRequest, NextResponse } from "next/server";
import type { QuerySnapshot } from "firebase-admin/firestore";
import { requireAdminPortalAccess } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { createRunWorkspaceIntegrityBatch } from "@/lib/workspaces/runWorkspaceIntegrityBatch";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RUN_FIELDS = [
  "userId",
  "userEmail",
  "question",
  "query",
  "createdAt",
  "consensusScore",
  "consensusSummary",
  "governanceStatus",
  "governanceReviewedBy",
  "governanceReviewedAt",
  "governanceReviewComment",
  // Phase 4B — required so Layer-A integrity validation can see whether
  // this row actually carries a Workspace association at all; omitting it
  // from the projection would make every row look "legacy" regardless of
  // its real, persisted state.
  "workspaceId",
] as const;

const VER_FIELDS = [
  "userId",
  "uid",
  "userEmail",
  "claim",
  "question",
  "createdAt",
  "timestamp",
  "verifiedAt",
  "consensusScore",
  "verdict",
  "governanceStatus",
  "governanceReviewedBy",
  "governanceReviewedAt",
  "governanceReviewComment",
  "type",
] as const;

const VIDEO_FIELDS = [
  "userId",
  "userEmail",
  "fileName",
  "type",
  "timestamp",
  "createdAt",
  "consensusScore",
  "verdict",
  "governanceStatus",
  "governanceReviewedBy",
  "governanceReviewedAt",
  "governanceReviewComment",
  "metadata",
] as const;

export type AdminRunListRow = {
  runId: string;
  collection: "runs" | "verifications" | "videoVerifications";
  runType: "research" | "claim" | "video";
  question: string;
  userEmail: string;
  userId: string;
  consensusScore: number | null;
  /** Claim or video authenticity verdict when present. */
  verdict: string | null;
  governanceStatus: string | null;
  governanceReviewedBy: string | null;
  createdAt: string;
};

function firestoreMillis(value: unknown): number {
  if (
    value &&
    typeof value === "object" &&
    "toMillis" in value &&
    typeof (value as { toMillis: () => number }).toMillis === "function"
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return 0;
}

function consensusFromData(data: Record<string, unknown>): number | null {
  if (typeof data.consensusScore === "number" && Number.isFinite(data.consensusScore)) {
    return data.consensusScore;
  }
  const cs = data.consensusSummary;
  if (
    cs &&
    typeof cs === "object" &&
    typeof (cs as { overallConsensusScore?: unknown }).overallConsensusScore === "number"
  ) {
    return (cs as { overallConsensusScore: number }).overallConsensusScore;
  }
  return null;
}

function isClaimVerification(data: Record<string, unknown>): boolean {
  const t = data.type;
  return t === "claim_verification" || t === undefined || t === null;
}

function isVideoVerification(data: Record<string, unknown>): boolean {
  return data.type === "video_verification";
}

function matchesGovernanceStatusFilter(statusParam: string | null, governanceStatus: string | null): boolean {
  if (!statusParam || statusParam === "all") return true;
  if (statusParam === "none") {
    return governanceStatus == null || governanceStatus === "";
  }
  return (governanceStatus ?? "").toLowerCase() === statusParam;
}

type Merged = AdminRunListRow & { sortMs: number };

async function fetchVerificationsSnapshot(perCol: number): Promise<QuerySnapshot> {
  if (!adminDb) throw new Error("no db");
  try {
    return await adminDb
      .collection("verifications")
      .orderBy("timestamp", "desc")
      .limit(perCol)
      .select(...VER_FIELDS)
      .get();
  } catch {
    try {
      return await adminDb
        .collection("verifications")
        .orderBy("createdAt", "desc")
        .limit(perCol)
        .select(...VER_FIELDS)
        .get();
    } catch {
      return await adminDb.collection("verifications").limit(perCol).select(...VER_FIELDS).get();
    }
  }
}

async function fetchVideoSnapshot(perCol: number): Promise<QuerySnapshot> {
  if (!adminDb) throw new Error("no db");
  try {
    return await adminDb
      .collection("videoVerifications")
      .orderBy("timestamp", "desc")
      .limit(perCol)
      .select(...VIDEO_FIELDS)
      .get();
  } catch (e) {
    console.warn("[admin/runs] videoVerifications orderBy(timestamp) failed, falling back:", e);
    return await adminDb.collection("videoVerifications").limit(perCol).select(...VIDEO_FIELDS).get();
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminPortalAccess(request);
  if (!auth) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!adminDb) {
    return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 500 });
  }

  const { searchParams } = request.nextUrl;
  const type = searchParams.get("type") ?? "all";
  if (!["all", "research", "claim", "video"].includes(type)) {
    return NextResponse.json({ ok: false, error: "Invalid type" }, { status: 400 });
  }
  const limitRaw = parseInt(searchParams.get("limit") ?? "25", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 25;
  const offsetRaw = parseInt(searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  const userIdFilter = (searchParams.get("userId") ?? "").trim();
  const statusRaw = searchParams.get("status");
  const statusFilter =
    statusRaw != null && statusRaw !== "" && statusRaw !== "all" ? statusRaw.trim().toLowerCase() : null;

  const perCol = Math.min(400, Math.max(offset + limit + 80, 60));
  const merged: Merged[] = [];

  const needRuns = type === "all" || type === "research";
  const needClaims = type === "all" || type === "claim";
  const needVideo = type === "all" || type === "video";

  try {
    const [runsSnap, verSnap, vidSnap] = await Promise.all([
      needRuns
        ? adminDb
            .collection("runs")
            .orderBy("createdAt", "desc")
            .limit(perCol)
            .select(...RUN_FIELDS)
            .get()
        : Promise.resolve(null),
      needClaims ? fetchVerificationsSnapshot(perCol) : Promise.resolve(null),
      needVideo ? fetchVideoSnapshot(perCol) : Promise.resolve(null),
    ]);

    if (runsSnap) {
      // First pass: apply the existing filters exactly as before (search,
      // userId, governance status) — Phase 4B does not broaden or narrow
      // these. Only rows surviving them are candidates for the list.
      const candidates: Array<{ docId: string; data: Record<string, unknown>; userId: string; q: string; gs: string | null }> = [];
      for (const doc of runsSnap.docs) {
        const data = doc.data() as Record<string, unknown>;
        const userId = String(data.userId ?? "");
        const q = String(data.question ?? data.query ?? "");
        if (userIdFilter && userId !== userIdFilter) continue;
        if (search && !q.toLowerCase().includes(search)) continue;
        const gs = data.governanceStatus != null ? String(data.governanceStatus) : null;
        if (!matchesGovernanceStatusFilter(statusFilter, gs)) continue;
        candidates.push({ docId: doc.id, data, userId, q, gs });
      }

      // Phase 4B — Mandatory Workspace Integrity. The admin bypass is an
      // existing Layer-B grant (no ownership scoping), not an exemption
      // from Layer A — a corrupted Workspace-bound run must not be
      // disclosed here merely because the requester is an admin. Batched
      // per distinct owner (see runWorkspaceIntegrityBatch.ts), never one
      // lookup per row.
      const validateWorkspace = createRunWorkspaceIntegrityBatch();
      const integrityResults = await Promise.all(candidates.map((c) => validateWorkspace(c.data)));

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const integrity = integrityResults[i];
        if (integrity.classification === "invalid") {
          logger.warn("[admin/runs] workspace_run_integrity_failed", { runId: c.docId, reason: integrity.reason });
          continue;
        }
        const ms = firestoreMillis(c.data.createdAt);
        merged.push({
          sortMs: ms || 0,
          runId: c.docId,
          collection: "runs",
          runType: "research",
          question: c.q.slice(0, 5000),
          userEmail: typeof c.data.userEmail === "string" ? c.data.userEmail : "",
          userId: c.userId,
          consensusScore: consensusFromData(c.data),
          verdict: null,
          governanceStatus: c.gs,
          governanceReviewedBy:
            typeof c.data.governanceReviewedBy === "string" ? c.data.governanceReviewedBy : null,
          createdAt: ms ? new Date(ms).toISOString() : new Date().toISOString(),
        });
      }
    }

    if (verSnap) {
      for (const doc of verSnap.docs) {
        const data = doc.data() as Record<string, unknown>;
        if (!isClaimVerification(data)) continue;
        const userId = String(data.userId ?? data.uid ?? "");
        const claim = String(data.claim ?? data.question ?? "");
        if (userIdFilter && userId !== userIdFilter) continue;
        if (search && !claim.toLowerCase().includes(search)) continue;
        const gs = data.governanceStatus != null ? String(data.governanceStatus) : null;
        if (!matchesGovernanceStatusFilter(statusFilter, gs)) continue;
        const ms =
          firestoreMillis(data.timestamp) ||
          firestoreMillis(data.createdAt) ||
          firestoreMillis(data.verifiedAt);
        const verdictRaw = data.verdict;
        merged.push({
          sortMs: ms || 0,
          runId: doc.id,
          collection: "verifications",
          runType: "claim",
          question: claim.slice(0, 5000),
          userEmail: typeof data.userEmail === "string" ? data.userEmail : "",
          userId,
          consensusScore: consensusFromData(data),
          verdict: verdictRaw != null ? String(verdictRaw) : null,
          governanceStatus: gs,
          governanceReviewedBy:
            typeof data.governanceReviewedBy === "string" ? data.governanceReviewedBy : null,
          createdAt: ms ? new Date(ms).toISOString() : new Date().toISOString(),
        });
      }
    }

    if (vidSnap) {
      for (const doc of vidSnap.docs) {
        const data = doc.data() as Record<string, unknown>;
        if (!isVideoVerification(data)) continue;
        const userId = String(data.userId ?? "");
        const fn =
          typeof data.fileName === "string" && data.fileName.trim()
            ? data.fileName.trim()
            : "Uploaded video";
        const qVideo = `Video: ${fn}`;
        if (userIdFilter && userId !== userIdFilter) continue;
        if (search && !qVideo.toLowerCase().includes(search)) continue;
        const gs = data.governanceStatus != null ? String(data.governanceStatus) : null;
        if (!matchesGovernanceStatusFilter(statusFilter, gs)) continue;
        const ms = firestoreMillis(data.timestamp) || firestoreMillis(data.createdAt);
        const verdictRaw = data.verdict;
        merged.push({
          sortMs: ms || 0,
          runId: doc.id,
          collection: "videoVerifications",
          runType: "video",
          question: qVideo.slice(0, 5000),
          userEmail: typeof data.userEmail === "string" ? data.userEmail : "",
          userId,
          consensusScore: consensusFromData(data),
          verdict: verdictRaw != null ? String(verdictRaw) : null,
          governanceStatus: gs,
          governanceReviewedBy:
            typeof data.governanceReviewedBy === "string" ? data.governanceReviewedBy : null,
          createdAt: ms ? new Date(ms).toISOString() : new Date().toISOString(),
        });
      }
    }

    merged.sort((a, b) => b.sortMs - a.sortMs);

    const emailUids = new Set<string>();
    for (const row of merged) {
      const em = row.userEmail.trim();
      if ((!em || !em.includes("@")) && row.userId) emailUids.add(row.userId);
    }
    if (emailUids.size > 0) {
      const db = adminDb;
      const uids = [...emailUids];
      const emailMap: Record<string, string> = {};
      const chunkSize = 10;
      for (let i = 0; i < uids.length; i += chunkSize) {
        const chunk = uids.slice(i, i + chunkSize);
        const snaps = await db.getAll(...chunk.map((u) => db.collection("users").doc(u)));
        for (let j = 0; j < chunk.length; j++) {
          const d = snaps[j].data() as Record<string, unknown> | undefined;
          const mail = typeof d?.email === "string" ? d.email : "";
          emailMap[chunk[j]] = mail.includes("@") ? mail : chunk[j];
        }
      }
      for (const row of merged) {
        if ((!row.userEmail || !row.userEmail.includes("@")) && row.userId) {
          row.userEmail = emailMap[row.userId] || row.userId;
        }
      }
    }

    const total = merged.length;
    const page = merged.slice(offset, offset + limit).map(({ sortMs: _s, ...rest }) => rest);

    return NextResponse.json({ ok: true, runs: page, total });
  } catch (e) {
    console.error("[admin/runs] GET failed", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Query failed" },
      { status: 500 }
    );
  }
}
