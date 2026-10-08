/**
 * Step 6.3 — `GET /api/workspaces/{workspaceId}/governance-summary`.
 * Contract: docs/governance-workspace-summary-contract.md.
 *
 * Order (each step only after every earlier one passes):
 *   1. authenticate;
 *   2. Team Workspace admission (`resolveWorkspaceAuditAccess`, the same gate
 *      as the audit-events route, so the same concealed denials);
 *   3. `audit.read` — the ONLY capability gate (contract §2, D3);
 *   4. release flag — concealed until 2–3 pass, so an unauthorized caller
 *      cannot observe feature state;
 *   5. exact count() aggregation (the only Firestore work: the Project listing
 *      plus count queries — no artifact read, limit, scan or write).
 *
 * A summary whose counts cannot be reconciled (a write landed between queries)
 * is retried once and then reported unavailable — never returned.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { WORKSPACE_GOVERNANCE_SUMMARY_ENABLED } from "@/lib/env";
import { resolveWorkspaceAuditAccess } from "@/lib/workspaces/resolveWorkspaceAuditAccess";
import { teamAuditAccessDeniedResponse, teamAuditInsufficientCapabilityResponse, teamAuditWorkspaceNotFoundConcealedResponse } from "@/lib/workspaces/teamAuditAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { loadWorkspaceGovernanceSummary } from "@/lib/governance/workspaceGovernanceSummaryFirestore";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const identity = await resolveRequestIdentity(req);
  if (identity.status !== "authenticated") {
    logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/governance-summary", method: "GET", failureCategory: identity.reason });
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

  if (!WORKSPACE_GOVERNANCE_SUMMARY_ENABLED || !adminDb) {
    const { status, body } = teamAuditWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  try {
    const result = await loadWorkspaceGovernanceSummary(adminDb, workspaceId);
    if (!result.ok && result.reason === "workspace_too_large") {
      return NextResponse.json(
        { ok: false, errorCode: "summary_workspace_too_large", projectCeiling: result.projectCeiling, message: `The governance summary is available for Workspaces with up to ${result.projectCeiling} Projects.` },
        { status: 409 }
      );
    }
    if (!result.ok) {
      logger.warn("[api/workspaces/governance-summary] counts could not be reconciled after retry", { workspaceId });
      return NextResponse.json({ ok: false, errorCode: "summary_unavailable", message: "The governance summary is temporarily unavailable. Please try again." }, { status: 503 });
    }
    return NextResponse.json({ ok: true, summary: result.summary });
  } catch (err: unknown) {
    logger.error("[api/workspaces/governance-summary] count query failed", { workspaceId, error: err instanceof Error ? err.message : String(err) });
    const { status, body } = internalErrorResponse();
    return NextResponse.json(body, { status });
  }
}
