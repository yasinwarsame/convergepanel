/**
 * Admin run detail, governance override, and delete (research or claim verification).
 */

import { NextRequest, NextResponse } from "next/server";
import type { DocumentData } from "firebase-admin/firestore";
import { requireAdminApiAccess } from "@/lib/firebase/auth-helpers";
import { adminDb } from "@/lib/firebase/admin";
import { writeAuditEvent } from "@/lib/governance/auditLog";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CollectionName = "runs" | "verifications" | "videoVerifications";

function parseCollection(sp: URLSearchParams): CollectionName | null {
  const c = sp.get("collection");
  return c === "runs" || c === "verifications" || c === "videoVerifications" ? c : null;
}

function auditQuestionFromDoc(collection: CollectionName, prev: Record<string, unknown>): string {
  if (collection === "videoVerifications") {
    const meta = prev.metadata as Record<string, unknown> | undefined;
    const dur =
      meta && typeof meta.duration === "number" && Number.isFinite(meta.duration)
        ? `${Math.round(meta.duration)}s`
        : "unknown";
    const w = meta && typeof meta.width === "number" ? meta.width : "?";
    const h = meta && typeof meta.height === "number" ? meta.height : "?";
    const fn =
      typeof prev.fileName === "string" && prev.fileName.trim() ? prev.fileName.trim() : "Uploaded video";
    return `Video: ${fn} (${dur}, ${w}x${h})`.slice(0, 200);
  }
  return String(prev.question ?? prev.claim ?? prev.query ?? "").slice(0, 200);
}

function auditRunType(collection: CollectionName): string {
  if (collection === "videoVerifications") return "video";
  if (collection === "verifications") return "claim";
  return "research";
}

export async function GET(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  const auth = await requireAdminApiAccess(request);
  if (!auth) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!adminDb) return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 500 });

  const collection = parseCollection(request.nextUrl.searchParams);
  if (!collection) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Query param collection is required: "runs", "verifications", or "videoVerifications"',
      },
      { status: 400 }
    );
  }

  const { runId } = params;
  const doc = await adminDb.collection(collection).doc(runId).get();
  if (!doc.exists) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const docData = doc.data() as Record<string, unknown>;

  // Phase 4B — Mandatory Workspace Integrity. The existing admin bypass
  // grants broad READ access with no ownership scoping at all, but that is
  // an existing Layer-B grant, not an exemption from Layer A: an admin
  // route is not a documented forensic/corruption-inspection capability
  // (no such capability exists in this codebase today), so it gets the
  // same integrity gate as every other canonical-run disclosure route.
  // Scoped to "runs" only — verifications/videoVerifications never carry
  // a workspaceId.
  if (collection === "runs") {
    const integrity = await validateRunWorkspaceAssociation(docData);
    if (integrity.classification === "invalid") {
      logger.warn("[admin/runs/[runId]] workspace_run_integrity_failed", { runId, reason: integrity.reason });
      return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
    }
  }

  return NextResponse.json({ ok: true, data: docData, collection, runId });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  const auth = await requireAdminApiAccess(request);
  if (!auth) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!adminDb) return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 500 });

  const { runId } = params;
  let body: {
    action?: string;
    status?: string;
    comment?: string;
    collection?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action !== "set_governance_status") {
    return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
  }
  const collection = body.collection as CollectionName;
  if (collection !== "runs" && collection !== "verifications" && collection !== "videoVerifications") {
    return NextResponse.json({ ok: false, error: "Invalid collection" }, { status: 400 });
  }
  const status = body.status;
  if (status !== "approved" && status !== "needs_review" && status !== "blocked") {
    return NextResponse.json({ ok: false, error: "Invalid status" }, { status: 400 });
  }
  const comment =
    typeof body.comment === "string" && body.comment.trim()
      ? body.comment.trim()
      : "Admin governance override";

  const ref = adminDb.collection(collection).doc(runId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  const prev = snap.data() as Record<string, unknown>;
  const prevStatus = typeof prev.governanceStatus === "string" ? prev.governanceStatus : null;

  await ref.set(
    sanitizeForFirestore({
      governanceStatus: status,
      governanceReviewedBy: auth.uid,
      governanceReviewedAt: new Date().toISOString(),
      governanceReviewComment: comment,
    }) as DocumentData,
    { merge: true }
  );

  const question = auditQuestionFromDoc(collection, prev);
  await writeAuditEvent({
    action: "admin_override",
    runId,
    collection,
    runType: auditRunType(collection),
    byUid: auth.uid,
    byEmail: auth.email,
    comment,
    prevStatus: prevStatus ?? undefined,
    nextStatus: status,
    runOwnerUid: String(prev.userId ?? prev.uid ?? ""),
    runOwnerEmail: typeof prev.userEmail === "string" ? prev.userEmail : "",
    question,
    consensusScore: typeof prev.consensusScore === "number" ? prev.consensusScore : null,
  });

  return NextResponse.json({ ok: true, runId, collection, governanceStatus: status });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  const auth = await requireAdminApiAccess(request);
  if (!auth) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!adminDb) return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 500 });

  const collection = parseCollection(request.nextUrl.searchParams);
  if (!collection) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Query param collection is required: "runs", "verifications", or "videoVerifications"',
      },
      { status: 400 }
    );
  }

  let body: { confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body with { confirm: true } required" }, { status: 400 });
  }
  if (body.confirm !== true) {
    return NextResponse.json({ ok: false, error: "confirm: true required" }, { status: 400 });
  }

  const { runId } = params;
  const ref = adminDb.collection(collection).doc(runId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  const prev = snap.data() as Record<string, unknown>;
  const question = auditQuestionFromDoc(collection, prev);

  await writeAuditEvent({
    action: "admin_deleted",
    runId,
    collection,
    runType: auditRunType(collection),
    byUid: auth.uid,
    byEmail: auth.email,
    runOwnerUid: String(prev.userId ?? prev.uid ?? ""),
    runOwnerEmail: typeof prev.userEmail === "string" ? prev.userEmail : "",
    question,
    prevStatus: typeof prev.governanceStatus === "string" ? prev.governanceStatus : undefined,
  });

  await ref.delete();

  return NextResponse.json({ ok: true, deleted: runId });
}
