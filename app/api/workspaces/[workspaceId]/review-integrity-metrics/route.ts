/**
 * Order 3 — `GET /api/workspaces/{workspaceId}/review-integrity-metrics`.
 * Mirrors `GET /api/workspaces/{workspaceId}/governance-summary` exactly.
 *
 * Order (each step only after every earlier one passes):
 *   1. authenticate;
 *   2. Team Workspace admission (`resolveWorkspaceAuditAccess` — the audit
 *      route's gate, so the same concealed denials);
 *   3. `audit.read` — the ONLY capability gate (Owner/Admin governance
 *      oversight; `reviews.read` is deliberately not enough);
 *   4. release flag — concealed until 2–3 pass, so an unauthorized caller
 *      cannot observe feature state; while off, ZERO Firestore work;
 *   5. exact count() aggregation (Project listing + count queries only).
 *
 * The body is the aggregate-only allow-list DTO (`toPublicReviewIntegrityMetrics`):
 * counts and fixed scope metadata, never a reviewer, run, question or Project.
 * Irreconcilable counts are retried once and then reported unavailable.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { WORKSPACE_REVIEW_INTEGRITY_METRICS_ENABLED } from "@/lib/env";
import { resolveWorkspaceAuditAccess } from "@/lib/workspaces/resolveWorkspaceAuditAccess";
import { teamAuditAccessDeniedResponse, teamAuditInsufficientCapabilityResponse, teamAuditWorkspaceNotFoundConcealedResponse } from "@/lib/workspaces/teamAuditAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { loadReviewIntegrityMetrics } from "@/lib/governance/reviewIntegrityMetricsFirestore";
import { toPublicReviewIntegrityMetrics } from "@/lib/governance/reviewIntegrityMetrics";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/review-integrity-metrics", method: "GET", failureCategory: identity.reason });
    return identity.reason === "missing_credentials"
      ? NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 })
      : NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
  }
  const workspaceId = params.workspaceId;

  const access = await resolveWorkspaceAuditAccess({ uid: identity.uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamAuditAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("audit.read")) {
    const { status, body } = teamAuditInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  if (!WORKSPACE_REVIEW_INTEGRITY_METRICS_ENABLED || !adminDb) {
    const { status, body } = teamAuditWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  try {
    const result = await loadReviewIntegrityMetrics(adminDb, workspaceId);
    if (!result.ok && result.reason === "workspace_too_large") {
      return NextResponse.json(
        { ok: false, errorCode: "metrics_workspace_too_large", projectCeiling: result.projectCeiling, message: `Review integrity metrics are available for Workspaces with up to ${result.projectCeiling} Projects.` },
        { status: 409 }
      );
    }
    if (!result.ok) {
      logger.warn("[api/workspaces/review-integrity-metrics] counts could not be reconciled after retry", { workspaceId });
      return NextResponse.json({ ok: false, errorCode: "metrics_unavailable", message: "Review integrity metrics are temporarily unavailable. Please try again." }, { status: 503 });
    }
    return NextResponse.json({ ok: true, metrics: toPublicReviewIntegrityMetrics(result.metrics) });
  } catch (err: unknown) {
    logger.error("[api/workspaces/review-integrity-metrics] count query failed", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
}
