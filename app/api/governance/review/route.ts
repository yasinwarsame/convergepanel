/**
 * Record a governance review decision on a run or verification document.
 */

import { NextRequest, NextResponse } from "next/server";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import {
  governanceQueuePlanForbiddenResponse,
  resolveGovernanceVisibleUserIds,
  runOwnerVisibleInGovernance,
} from "@/lib/governance/governanceVisibleUserIds";
import { writeAuditEvent } from "@/lib/governance/auditLog";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";

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
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  let body: {
    runId?: string;
    collection?: "runs" | "verifications" | "videoVerifications";
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
  if (coll !== "runs" && coll !== "verifications" && coll !== "videoVerifications") {
    fields.collection = 'Must be "runs", "verifications", or "videoVerifications"';
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

  const collection = coll as "runs" | "verifications" | "videoVerifications";
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

  // Phase 4B — Mandatory Workspace Integrity, requester-independent, before
  // this decision mutates governance state or its response discloses any
  // run content. Scoped to "runs" only — verifications/videoVerifications
  // never carry a workspaceId.
  if (collection === "runs") {
    const integrity = await validateRunWorkspaceAssociation(data);
    if (integrity.classification === "invalid") {
      logger.warn("[governance/review] workspace_run_integrity_failed", { runId: docId, reason: integrity.reason });
      return NextResponse.json(
        { ok: false, error: { code: "not_found", message: "Run not found" } },
        { status: 404 }
      );
    }
  }

  const prevStatus =
    typeof data.governanceStatus === "string" && data.governanceStatus ? data.governanceStatus : "needs_review";

  const nextGovernanceStatus = reviewAction === "changes_requested" ? "needs_review" : reviewAction;

  if (
    (reviewAction === "approved" || reviewAction === "blocked") &&
    prevStatus === reviewAction
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "already_reviewed",
          message: `This run is already ${reviewAction}.`,
        },
      },
      { status: 400 }
    );
  }

  if (nextGovernanceStatus === prevStatus) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "already_reviewed",
          message:
            prevStatus === "needs_review"
              ? "This run is already awaiting review."
              : `No status change (${prevStatus}).`,
        },
      },
      { status: 400 }
    );
  }

  if (prevStatus === "blocked" && reviewAction === "approved") {
    console.log(`[governance/review] Override: ${resolved.uid} approving previously blocked run ${docId}`);
  }

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
  if (!runOwnerEmail || !runOwnerEmail.includes("@")) {
    runOwnerEmail = "";
    if (rowOwnerUid) {
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

  /** Single global audit row per review (governanceEvents subcollection is updated below). */
  const auditQuestion =
    collection === "videoVerifications"
      ? (() => {
          const meta = runData.metadata as Record<string, unknown> | undefined;
          const dur =
            meta && typeof meta.duration === "number" && Number.isFinite(meta.duration)
              ? `${Math.round(meta.duration)}s`
              : "unknown";
          const w = meta && typeof meta.width === "number" ? meta.width : "?";
          const h = meta && typeof meta.height === "number" ? meta.height : "?";
          const fn =
            typeof runData.fileName === "string" && runData.fileName.trim()
              ? runData.fileName.trim()
              : "Uploaded video";
          return `Video: ${fn} (${dur}, ${w}x${h})`.substring(0, 200);
        })()
      : String(runData.question ?? runData.claim ?? runData.query ?? "").substring(0, 200);

  await writeAuditEvent({
    runId: docId,
    collection,
    runType:
      collection === "videoVerifications" ? "video" : collection === "verifications" ? "claim" : "research",
    action: reviewAction,
    byUid: uid,
    byEmail: userEmail,
    comment: finalComment || undefined,
    prevStatus,
    nextStatus: auditNextStatus,
    runOwnerUid: rowOwnerUid,
    runOwnerEmail,
    question: auditQuestion,
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
