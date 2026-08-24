/**
 * Approval Workflow, Phase 9B.4 — `GET /api/workspaces/{workspaceId}/review-queue`.
 * The first public Phase 9 route. Read-only: no assignment, decision,
 * panel, override, or resubmission mutation exists on this route or
 * anywhere behind it. Adaptive Deep Research only — Claim/Video human
 * review is untouched (those live in entirely separate Firestore
 * collections this route never queries).
 *
 * Two independent, BOTH-required admission gates, checked in this order
 * (cheapest/most-restrictive first, mirroring every other Workspace
 * route's own "rollout gate before any Firestore access" convention):
 *   1. Approval Workflow admission (`resolveApprovalWorkflowAdmission()`)
 *      — pure, zero I/O. This flag can NEVER grant or widen Team
 *      Workspace access; it only gates this route's own existence.
 *   2. Team Workspace access (`resolveTeamRunWorkspaceAccess()`, reused
 *      verbatim from the sibling `GET /api/workspaces/{workspaceId}/runs`
 *      route) — the authoritative membership/capability check. Requires
 *      BOTH `research.read` AND `reviews.read` (this route additionally
 *      requires `reviews.read` beyond what the sibling runs route checks,
 *      since this is review-specific content).
 *
 * A caller failing EITHER gate gets the SAME concealed 404
 * (`teamRunWorkspaceNotFoundConcealedResponse()`) — never a distinguishable
 * response revealing which gate failed, matching Phase 9B.1's carried-forward
 * concealment discipline (§47 of the Phase 9B.4 spec).
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { APPROVAL_WORKFLOW_ENABLED, APPROVAL_WORKFLOW_CANARY_UIDS } from "@/lib/env";
import { resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";
import { resolveTeamRunWorkspaceAccess } from "@/lib/workspaces/resolveTeamRunWorkspaceAccess";
import { teamRunAccessDeniedResponse, teamRunWorkspaceNotFoundConcealedResponse, teamRunInsufficientCapabilityResponse } from "@/lib/workspaces/teamRunAccessResponse";
import { internalErrorResponse } from "@/lib/workspaces/teamWorkspaceErrorResponse";
import { decodeReviewQueueCursor, type ReviewQueueView } from "@/lib/workspaces/reviewQueueCursor";
import { getReviewQueue } from "@/lib/workspaces/reviewQueue";
import type { WorkspaceReviewCandidate } from "@/lib/workspaces/workspaceReviewEligibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const VALID_VIEWS: ReadonlySet<string> = new Set<ReviewQueueView>(["assigned_to_me", "needs_review", "changes_requested", "overdue", "recently_approved"]);

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/workspaces/[workspaceId]/review-queue", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

type ProjectFilterParseResult = { ok: true; projectFilter: string | null | undefined } | { ok: false };

/** `projectId=<id>` and `scope=unfiled` are mutually exclusive; neither present means no filter (workspace-wide) — deliberately a THIRD, valid state this route supports that the single-Project `GET /api/user/project-runs` precedent does not need. */
function parseProjectFilter(searchParams: URLSearchParams): ProjectFilterParseResult {
  const projectId = searchParams.get("projectId");
  const scopeParam = searchParams.get("scope");
  if (projectId !== null && scopeParam !== null) return { ok: false };
  if (projectId !== null) {
    if (projectId.length === 0) return { ok: false };
    return { ok: true, projectFilter: projectId };
  }
  if (scopeParam !== null) {
    if (scopeParam !== "unfiled") return { ok: false };
    return { ok: true, projectFilter: null };
  }
  return { ok: true, projectFilter: undefined };
}

export async function GET(req: NextRequest, { params }: { params: { workspaceId: string } }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;
  const workspaceId = params.workspaceId;

  // ---- Gate 1: Approval Workflow admission — pure, zero I/O, checked
  // before any Firestore access at all. ----
  const admission = resolveApprovalWorkflowAdmission({ uid, globalEnabled: APPROVAL_WORKFLOW_ENABLED, canaryUidsRaw: APPROVAL_WORKFLOW_CANARY_UIDS });
  if (!admission.admitted) {
    const { status, body } = teamRunWorkspaceNotFoundConcealedResponse();
    return NextResponse.json(body, { status });
  }

  // ---- Gate 2: Team Workspace access — the authoritative membership/
  // capability check, reused verbatim from the sibling runs route. ----
  const access = await resolveTeamRunWorkspaceAccess({ uid, workspaceId });
  if (!access.granted) {
    const { status, body } = teamRunAccessDeniedResponse(access.reason);
    return NextResponse.json(body, { status });
  }
  if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) {
    const { status, body } = teamRunInsufficientCapabilityResponse();
    return NextResponse.json(body, { status });
  }

  const { searchParams } = req.nextUrl;

  const viewRaw = searchParams.get("view");
  if (viewRaw === null || !VALID_VIEWS.has(viewRaw)) {
    return NextResponse.json({ ok: false, errorCode: "invalid_view", message: "Specify a valid view." }, { status: 400 });
  }
  const view = viewRaw as ReviewQueueView;

  const projectFilterResult = parseProjectFilter(searchParams);
  if (!projectFilterResult.ok) {
    return NextResponse.json({ ok: false, errorCode: "invalid_project_filter", message: "Specify either projectId or scope=unfiled, not both." }, { status: 400 });
  }
  const projectFilter = projectFilterResult.projectFilter;

  const limitRaw = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = parseInt(limitRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return NextResponse.json({ ok: false, errorCode: "invalid_limit", message: `limit must be an integer between 1 and ${MAX_LIMIT}.` }, { status: 400 });
    }
    limit = parsed;
  }

  const cursorRaw = searchParams.get("cursor");
  let cursor = null;
  if (cursorRaw !== null) {
    const decoded = decodeReviewQueueCursor(cursorRaw);
    if (!decoded.ok) {
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    }
    // A cursor issued for a different view, or a different Project
    // filter, is never silently honored — reject outright rather than
    // reinterpreting it against a different query shape (§26).
    if (decoded.cursor.view !== view || decoded.cursor.projectFilter !== projectFilter) {
      return NextResponse.json({ ok: false, errorCode: "invalid_cursor", message: "This page link is no longer valid." }, { status: 400 });
    }
    cursor = decoded.cursor;
  }

  const callerCandidate: WorkspaceReviewCandidate = { uid, workspaceId, role: access.membership.role, status: access.membership.status };

  const result = await getReviewQueue({ view, workspaceId, uid, callerCandidate, projectFilter, limit, cursor });
  switch (result.status) {
    case "ok":
      return NextResponse.json({ ok: true, items: result.items, hasMore: result.hasMore, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
    case "query_failed": {
      const { status, body } = internalErrorResponse();
      return NextResponse.json(body, { status });
    }
  }
}
