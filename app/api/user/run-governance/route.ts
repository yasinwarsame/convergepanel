/**
 * Lightweight read of governance fields on a user's run or verification document.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Auth Identity Consistency Remediation, Step 7 — resolves via the
// shared, hardened resolver rather than this route's own duplicated
// cookie-first logic. Response shape for auth failures is unchanged.
async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/run-governance", method: "GET", failureCategory: identity.reason });
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
  const runId = (searchParams.get("runId") ?? "").trim();
  const collection = searchParams.get("collection") as "runs" | "verifications" | "videoVerifications" | null;

  if (!runId) {
    return NextResponse.json(
      { ok: false, errorCode: "validation_error", message: "runId is required." },
      { status: 400 }
    );
  }
  if (collection !== "runs" && collection !== "verifications" && collection !== "videoVerifications") {
    return NextResponse.json(
      {
        ok: false,
        errorCode: "validation_error",
        message: 'collection must be "runs", "verifications", or "videoVerifications".',
      },
      { status: 400 }
    );
  }

  try {
    const snap = await adminDb.collection(collection).doc(runId).get();

    if (!snap.exists) {
      return NextResponse.json(
        { ok: false, errorCode: "not_found", message: "Document not found." },
        { status: 404 }
      );
    }

    const data = snap.data() as Record<string, unknown>;
    const owner =
      (typeof data.userId === "string" && data.userId.trim()) ||
      (typeof data.uid === "string" && data.uid.trim()) ||
      "";
    if (owner !== uid) {
      return NextResponse.json(
        { ok: false, errorCode: "forbidden", message: "Access denied." },
        { status: 403 }
      );
    }

    // Phase 4B — Mandatory Workspace Integrity. This route also serves
    // `verifications`/`videoVerifications`, which are entirely outside the
    // Workspace program (never carry a `workspaceId`) — scoped to the
    // `runs` collection only, requester-independent, before any governance
    // field is returned.
    if (collection === "runs") {
      const integrity = await validateRunWorkspaceAssociation(data);
      if (integrity.classification === "invalid") {
        logger.warn("[user/run-governance] workspace_run_integrity_failed", { runId, reason: integrity.reason });
        return NextResponse.json(
          { ok: false, errorCode: "not_found", message: "Document not found." },
          { status: 404 }
        );
      }
    }

    const reviewedBy =
      typeof data.governanceReviewedBy === "string" && data.governanceReviewedBy.trim()
        ? data.governanceReviewedBy.trim()
        : null;

    let governanceReviewerEmail: string | null = null;
    if (reviewedBy) {
      try {
        const ru = await adminDb.collection("users").doc(reviewedBy).get();
        const em = ru.data()?.email;
        if (typeof em === "string" && em.trim()) governanceReviewerEmail = em.trim();
      } catch {
        /* optional enrichment */
      }
    }

    const reasons = Array.isArray(data.governanceReasons)
      ? (data.governanceReasons as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    const status = data.governanceStatus;
    const governanceStatus =
      status === "approved" || status === "needs_review" || status === "blocked" ? status : null;

    return NextResponse.json({
      ok: true,
      governanceStatus,
      governanceReasons: reasons,
      governanceReviewedBy: reviewedBy,
      governanceReviewerEmail,
      governanceReviewedAt:
        typeof data.governanceReviewedAt === "string" ? data.governanceReviewedAt : null,
      governanceReviewComment:
        typeof data.governanceReviewComment === "string" ? data.governanceReviewComment : null,
    });
  } catch (e: unknown) {
    logger.error("[user/run-governance] read failed", { error: (e as Error)?.message });
    return NextResponse.json(
      { ok: false, errorCode: "internal_error", message: "Could not load governance status." },
      { status: 500 }
    );
  }
}
