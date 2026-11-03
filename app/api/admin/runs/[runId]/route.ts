/**
 * Phase FIRST-ADMIN-C4 — SYSTEM_ADMIN required.
 *
 * Resolved on 2026-09-07 by the FIRST_ADMIN_ENROLLMENT_BLOCKER_DECISION:
 * ADMIN_PORTAL is the lower operational/read tier and is not a route to
 * destructive, governance-changing or billing-changing actions. See
 * docs/operations/admin-authority-tiers.md.
 *
 * TRANSPORT NOTE: the SYSTEM_ADMIN guards are bearer-only in practice
 * (`verifyAdminToken` passes the `__session` value to `verifyIdToken`, which
 * always rejects a Firebase session cookie). The portal guard this replaces
 * accepted either, so this route is now bearer-only. The admin UI calls it via
 * `authedFetch`, which always sends an `Authorization: Bearer` header.
 */
/**
 * Admin run detail, governance override, and delete (research or claim verification).
 */

import { NextRequest, NextResponse } from "next/server";
import type { DocumentData } from "firebase-admin/firestore";
import { requireAdminPortalAccess, requireSystemAdminAccess } from "@/lib/firebase/auth-helpers";
import { resolveLiveAuthIdentity } from "@/lib/admin/verifiedAdminIdentity";

/**
 * Phase FIRST-ADMIN-C4 — audit attribution for the SYSTEM_ADMIN handlers.
 *
 * `requireSystemAdminAccess` returns `{uid, isAdmin}`: the claim is the
 * authority, and an address plays no part in granting it. The audit record
 * still wants a human-readable actor, so it is read from the live Auth record
 * here — descriptive only, never an input to the authorization decision, and
 * empty when the lookup fails rather than blocking the operation.
 *
 * Phase FIRST-ADMIN-C5 — ATTRIBUTION IS NEVER LOST. `byUid` is written from the
 * verified claim on every audit record and is the authoritative actor
 * identifier; this address is a human-readable convenience beside it. A
 * transient Auth outage therefore degrades the audit record's readability, not
 * its attribution. It is deliberately NOT sourced from the token: the
 * SYSTEM_ADMIN guard returns no email, and plumbing one through a shared guard
 * to populate a descriptive field would put an unverified address into an audit
 * trail.
 */
async function auditActorEmail(uid: string): Promise<string> {
  const live = await resolveLiveAuthIdentity(uid);
  return live.status === "resolved" ? live.email : "";
}
import { adminDb } from "@/lib/firebase/admin";
import { writeAuditEvent } from "@/lib/governance/auditLog";
import { createGovernanceAuditRowInTx } from "@/lib/governance/governanceAuditRow";
import { isResearchWriteRefusedError, runResearchWrite } from "@/lib/firestore/researchDeletionBarrier";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";
import { deleteResearchRun, getUnfinishedResearchDeletion } from "@/lib/firestore/researchDeletion";

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
  const auth = await requireAdminPortalAccess(request);
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
  // Phase FIRST-ADMIN-C4: governance-status mutation on another user's run.
  const auth = await requireSystemAdminAccess(request);
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
  const statusPatch = (): DocumentData =>
    sanitizeForFirestore({
      governanceStatus: status,
      governanceReviewedBy: auth.uid,
      governanceReviewedAt: new Date().toISOString(),
      governanceReviewComment: comment,
    }) as DocumentData;
  const overrideAudit = (prev: Record<string, unknown>, byEmail: unknown) => {
    const prevStatus = typeof prev.governanceStatus === "string" ? prev.governanceStatus : null;
    return {
      action: "admin_override",
      runId,
      collection,
      runType: auditRunType(collection),
      byUid: auth.uid,
      byEmail,
      comment,
      prevStatus: prevStatus ?? undefined,
      nextStatus: status,
      runOwnerUid: String(prev.userId ?? prev.uid ?? ""),
      runOwnerEmail: typeof prev.userEmail === "string" ? prev.userEmail : "",
      question: auditQuestionFromDoc(collection, prev),
      consensusScore: typeof prev.consensusScore === "number" ? prev.consensusScore : null,
    };
  };

  if (collection === "runs") {
    // Research deletion integrity: the override and its audit row (question, comment) are written in one transaction
    // guarded by the deletion barrier, from the run as read inside it. A deleted or deleting run is Not found.
    const db = adminDb;
    const byEmail = await auditActorEmail(auth.uid);
    try {
      await runResearchWrite(db, runId, (tx, run) => {
        tx.set(ref, statusPatch(), { merge: true });
        createGovernanceAuditRowInTx(tx, db, overrideAudit(run.data() as Record<string, unknown>, byEmail));
      });
    } catch (err) {
      if (isResearchWriteRefusedError(err)) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
      throw err;
    }
    return NextResponse.json({ ok: true, runId, collection, governanceStatus: status });
  }

  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  const prev = snap.data() as Record<string, unknown>;

  await ref.set(statusPatch(), { merge: true });

  await writeAuditEvent(overrideAudit(prev, await auditActorEmail(auth.uid)));

  return NextResponse.json({ ok: true, runId, collection, governanceStatus: status });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { runId: string } }
) {
  // Phase FIRST-ADMIN-C4: permanent cross-user deletion.
  const auth = await requireSystemAdminAccess(request);
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
    // Order A / S1 (review M-1): a research deletion that failed after the run document was removed is RESUMED by runId.
    if (collection === "runs" && (await getUnfinishedResearchDeletion(runId))) {
      const resumed = await deleteResearchRun({ runId, actorUid: auth.uid, reason: "admin_delete" });
      if (resumed.status !== "deleted") {
        return NextResponse.json({ ok: false, error: "deletion_incomplete", message: "The research was not fully deleted. Nothing is reported as deleted; retry the deletion.", runId }, { status: 500 });
      }
      return NextResponse.json({ ok: true, deleted: runId, resumed: true });
    }
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
    byEmail: await auditActorEmail(auth.uid),
    runOwnerUid: String(prev.userId ?? prev.uid ?? ""),
    runOwnerEmail: typeof prev.userEmail === "string" ? prev.userEmail : "",
    question,
    prevStatus: typeof prev.governanceStatus === "string" ? prev.governanceStatus : undefined,
  });

  // Order A / S1: research ("runs") is deleted by the durable workflow — the whole run subtree (incl. report-review
  // snapshots, cycles and events, and export records) plus research text copied into audit/projection records — and is
  // reported as deleted ONLY after verification. An incomplete deletion is a 500 and can be retried safely.
  if (collection === "runs") {
    const result = await deleteResearchRun({ runId, actorUid: auth.uid, reason: "admin_delete" });
    if (result.status !== "deleted") {
      return NextResponse.json({ ok: false, error: "deletion_incomplete", message: "The research was not fully deleted. Nothing is reported as deleted; retry the deletion.", runId }, { status: 500 });
    }
    return NextResponse.json({ ok: true, deleted: runId });
  }

  await ref.delete();

  return NextResponse.json({ ok: true, deleted: runId });
}
