/**
 * Record a governance review decision on a run or verification document.
 */

import { NextRequest, NextResponse } from "next/server";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import {
  governanceQueueNotReviewerResponse,
  governanceQueuePlanForbiddenResponse,
  resolveGovernanceVisibleUserIds,
  runOwnerVisibleInGovernance,
} from "@/lib/governance/governanceVisibleUserIds";
import { writeAuditEvent } from "@/lib/governance/auditLog";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReviewAction = "approved" | "blocked" | "changes_requested";

export async function POST(request: NextRequest) {
  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  const resolved = await resolveGovernanceRequestUser(request);
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Authentication required" } },
      { status: 401 }
    );
  }

  const vis = await resolveGovernanceVisibleUserIds(resolved.uid, resolved.email);
  if (!vis.ok) {
    if (vis.kind === "plan_required") {
      return governanceQueuePlanForbiddenResponse();
    }
    if (vis.kind === "not_reviewer") {
      return governanceQueueNotReviewerResponse();
    }
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  let body: {
    runId?: string;
    collection?: "runs" | "verifications";
    action?: ReviewAction;
    comment?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "validation_error", message: "Invalid JSON body", fields: { body: "Invalid JSON" } },
      },
      { status: 400 }
    );
  }

  const { runId, collection: coll, action, comment } = body;
  const fields: Record<string, string> = {};

  if (!runId || typeof runId !== "string" || !runId.trim()) {
    fields.runId = "Required non-empty string";
  }
  if (coll !== "runs" && coll !== "verifications") {
    fields.collection = 'Must be "runs" or "verifications"';
  }
  if (action !== "approved" && action !== "blocked" && action !== "changes_requested") {
    fields.action = "Invalid action";
  }

  if (Object.keys(fields).length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "validation_error", message: "Validation failed", fields },
      },
      { status: 400 }
    );
  }

  const collection = coll as "runs" | "verifications";
  const reviewAction = action as ReviewAction;
  const docId = (runId as string).trim();

  if (
    (reviewAction === "blocked" || reviewAction === "changes_requested") &&
    (!comment || typeof comment !== "string" || !comment.trim())
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "validation_error",
          message: "Comment is required when blocking or requesting changes",
          fields: { comment: "Comment is required when blocking or requesting changes" },
        },
      },
      { status: 400 }
    );
  }

  const finalComment =
    reviewAction === "approved"
      ? (typeof comment === "string" && comment.trim()
          ? comment.trim()
          : "Approved via governance dashboard")
      : String(comment).trim();

  const ref = adminDb.collection(collection).doc(docId);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json(
      { ok: false, error: { code: "not_found", message: "Run not found" } },
      { status: 404 }
    );
  }

  const data = snap.data() as Record<string, unknown>;
  const ownerUid = String(data.userId ?? data.uid ?? "").trim();
  if (!runOwnerVisibleInGovernance(vis.visibleUserIds, ownerUid)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "forbidden",
          message: "You don't have permission to review this run.",
        },
      },
      { status: 403 }
    );
  }

  const prevStatus =
    typeof data.governanceStatus === "string" && data.governanceStatus ? data.governanceStatus : "needs_review";

  const reviewableStatuses = new Set(["needs_review", "blocked"]);
  if (!reviewableStatuses.has(prevStatus)) {
    const message =
      prevStatus === "approved"
        ? "This run is already approved."
        : `This run cannot be reviewed in its current state (${prevStatus}).`;
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: prevStatus === "approved" ? "already_reviewed" : "invalid_status",
          message,
        },
      },
      { status: 400 }
    );
  }

  const nextGovernanceStatus = reviewAction === "changes_requested" ? "needs_review" : reviewAction;

  const patch = sanitizeForFirestore({
    governanceStatus: nextGovernanceStatus,
    governanceReviewedBy: resolved.uid,
    governanceReviewedAt: new Date().toISOString(),
    governanceReviewComment: finalComment,
  }) as DocumentData;

  await ref.set(patch, { merge: true });

  const runData = data;
  const rowOwnerUid = String(runData.userId ?? runData.uid ?? ownerUid ?? "").trim();
  let runOwnerEmail = typeof runData.userEmail === "string" ? runData.userEmail.trim() : "";
  if (runOwnerEmail && !runOwnerEmail.includes("@")) {
    runOwnerEmail = "";
  }
  if (!runOwnerEmail && rowOwnerUid) {
    try {
      const ownerDoc = await adminDb.collection("users").doc(rowOwnerUid).get();
      const od = ownerDoc.data() as Record<string, unknown> | undefined;
      const fromProfile = typeof od?.email === "string" ? od.email.trim() : "";
      runOwnerEmail =
        fromProfile && fromProfile.includes("@") ? fromProfile : rowOwnerUid;
    } catch {
      runOwnerEmail = rowOwnerUid;
    }
  }

  const uid = resolved.uid;
  const userEmail = resolved.email;
  const consensusSummary = runData.consensusSummary as Record<string, unknown> | undefined;
  const consensusFromSummary =
    consensusSummary && typeof consensusSummary.overallConsensusScore === "number"
      ? consensusSummary.overallConsensusScore
      : null;
  const consensusScore =
    typeof runData.consensusScore === "number" ? runData.consensusScore : consensusFromSummary;

  const auditNextStatus = reviewAction === "changes_requested" ? "needs_review" : reviewAction;
  let auditPrevStatus = prevStatus;
  if (auditPrevStatus === auditNextStatus && auditPrevStatus === "approved") {
    auditPrevStatus = "needs_review";
  }

  /** Single global audit row per review (governanceEvents subcollection is updated below). */
  await writeAuditEvent({
    runId: docId,
    collection,
    runType: collection === "verifications" ? "claim" : "research",
    action: reviewAction,
    byUid: uid,
    byEmail: userEmail,
    comment: finalComment || undefined,
    prevStatus: auditPrevStatus,
    nextStatus: auditNextStatus,
    runOwnerUid: rowOwnerUid,
    runOwnerEmail,
    question: String(runData.question ?? runData.claim ?? runData.query ?? "").substring(0, 200),
    consensusScore: consensusScore ?? null,
  });

  await ref.collection("governanceEvents").add(
    sanitizeForFirestore({
      action: reviewAction,
      byUid: resolved.uid,
      byEmail: resolved.email,
      at: new Date().toISOString(),
      comment: finalComment,
      prevStatus,
      nextStatus: nextGovernanceStatus,
    }) as DocumentData
  );

  return NextResponse.json({
    ok: true,
    runId: docId,
    action: reviewAction,
    prevStatus,
    newStatus: nextGovernanceStatus,
  });
}
