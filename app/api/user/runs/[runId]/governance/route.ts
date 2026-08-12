/**
 * Review & Governance report completion — a dedicated, decoupled-failure-
 * domain endpoint returning presentation-safe governance DETAIL (reviewer
 * identity, assignment, peer-review panel/quorum/vote progress) for a
 * run's owner. The primary run response
 * (`GET /api/user/runs/[runId]`) intentionally stays compact
 * (status/conditions/decidedVia only, "never reviewer name or comment
 * text") — this route is the deliberate, disclosed place that widens that
 * to include resolved reviewer IDENTITY (never comment/justification
 * text, which stays hidden everywhere).
 *
 * Auth mirrors `app/api/user/runs/[runId]/route.ts` exactly: same
 * `resolveRequestIdentity()` → owner-equality check against
 * `runs/{runId}.userId`. This is deliberately NOT the `isTeamAdmin` gate
 * `app/api/teams/adaptive-runs/[runId]/**` routes use — a run owner reading
 * their OWN report's governance detail is a separate authorization domain
 * from team governance management, and this route never allows mutation.
 *
 * Reads are bounded and read-only: the run document, plus (Milestone-2
 * only) `humanReviewAssignment/current`, `humanReviewPanel/current`, and
 * — only when an open/finalized panel exists — each reviewer's vote
 * (≤`MAX_ADAPTIVE_PANEL_REVIEWERS`). Never reads `teamRuns` — routing
 * stays exactly as already resolved by `/api/user/runs/[runId]`; this
 * endpoint only ever ADDS identity/assignment/panel/vote detail from
 * canonical sources, never re-derives status from a projection.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { adminDb } from "@/lib/firebase/admin";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";
import { buildReviewGovernanceViewModel } from "@/lib/adaptiveSchema/reviewGovernanceViewModel";
import { getAdaptiveHumanReviewAssignment, getAdaptiveHumanReviewPanel, getAdaptiveHumanReviewVote } from "@/lib/firestore/runs";
import type { AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import type { AdaptiveHumanReviewPanelV1 } from "@/lib/governance/adaptiveHumanReviewPanel";
import type { AdaptiveHumanReviewVoteV1 } from "@/lib/governance/adaptiveHumanReviewVote";
import { resolveReviewerDisplayName } from "@/lib/governance/reviewerIdentity";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_LEGACY_GOVERNANCE_STATUSES = new Set(["approved", "needs_review", "blocked"]);

async function getUid(req: NextRequest): Promise<string | NextResponse> {
  const identity = await resolveRequestIdentity(req);
  if (identity.status === "authenticated") return identity.uid;
  logIdentityResolutionFailure({ route: "GET /api/user/runs/[runId]/governance", method: "GET", failureCategory: identity.reason });
  if (identity.reason === "missing_credentials") {
    return NextResponse.json({ ok: false, errorCode: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  return NextResponse.json({ ok: false, errorCode: "auth_error", message: "Authentication failed." }, { status: 401 });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export async function GET(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const uidOrRes = await getUid(req);
  if (uidOrRes instanceof NextResponse) return uidOrRes;
  const uid = uidOrRes;

  const { runId } = await context.params;
  if (!runId?.trim() || !adminDb) {
    return NextResponse.json({ ok: false, errorCode: "not_found", message: "Run not found." }, { status: 404 });
  }

  const snap = await adminDb.collection("runs").doc(runId).get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, errorCode: "not_found", message: "Run not found." }, { status: 404 });
  }

  const data = snap.data() as Record<string, unknown>;
  const owner = String(data.userId ?? "");
  if (owner !== uid) {
    return NextResponse.json({ ok: false, errorCode: "forbidden", message: "You do not have access to this run." }, { status: 403 });
  }

  const govParse = parseGovernanceRecord(data.governanceRecord);
  if (!govParse.ok && govParse.reason !== "absent") {
    // A genuinely corrupted/unsupported Milestone-2 record is a real data
    // problem, not "no review configured" — surfacing it as not_configured
    // would make a false claim. The client renders this as "unavailable",
    // per the same discipline as a fetch failure (never flashed as
    // not_configured).
    logger.warn("[user/runs/governance] Unreadable governanceRecord", { runId, reason: govParse.reason });
    return NextResponse.json({ ok: false, errorCode: "governance_data_invalid", message: "Review information unavailable." }, { status: 500 });
  }

  const rawLegacyStatus = data.governanceStatus;
  const legacy =
    !govParse.ok && typeof rawLegacyStatus === "string" && VALID_LEGACY_GOVERNANCE_STATUSES.has(rawLegacyStatus)
      ? {
          status: rawLegacyStatus as "approved" | "needs_review" | "blocked",
          reasons: isStringArray(data.governanceReasons) ? data.governanceReasons : [],
          reviewedByUid: typeof data.governanceReviewedBy === "string" && data.governanceReviewedBy ? data.governanceReviewedBy : null,
          reviewedAt: typeof data.governanceReviewedAt === "string" && data.governanceReviewedAt ? data.governanceReviewedAt : null,
        }
      : null;

  let assignment: AdaptiveHumanReviewAssignmentV1 | null = null;
  let panel: AdaptiveHumanReviewPanelV1 | null = null;
  let votes: AdaptiveHumanReviewVoteV1[] = [];

  if (govParse.ok) {
    const [assignmentResult, panelResult] = await Promise.all([getAdaptiveHumanReviewAssignment(runId), getAdaptiveHumanReviewPanel(runId)]);

    if (assignmentResult.status === "found") {
      assignment = assignmentResult.assignment;
    } else if (assignmentResult.status === "read_failed" || assignmentResult.status === "firestore_unavailable") {
      logger.warn("[user/runs/governance] Assignment read failed; degrading to no-assignment", { runId, status: assignmentResult.status });
    }

    if (panelResult.status === "found") {
      panel = panelResult.panel;
      if (panel.status !== "cancelled") {
        const voteRevision = panel.status === "open" ? panel.revision : panel.revision - 1;
        const voteResults = await Promise.all(
          panel.reviewerUserIds.map((reviewerId) => getAdaptiveHumanReviewVote(runId, voteRevision, reviewerId))
        );
        votes = voteResults.filter((r): r is { status: "found"; vote: AdaptiveHumanReviewVoteV1 } => r.status === "found").map((r) => r.vote);
      }
    } else if (
      panelResult.status === "read_failed" ||
      panelResult.status === "firestore_unavailable" ||
      panelResult.status === "malformed" ||
      panelResult.status === "unsupported_version"
    ) {
      logger.warn("[user/runs/governance] Panel read failed; degrading to no-panel", { runId, status: panelResult.status });
    }
  }

  // The run owner (this endpoint's only caller) has no team-admin context
  // by default — sourced here purely to give resolveReviewerDisplayName a
  // roster of member emails for its masked-email fallback, never to gate
  // authorization (the owner check above already did that) and never to
  // change family classification.
  const teamCtx = await loadUserAndTeam(uid).catch(() => null);
  const callerEmail = teamCtx?.user?.email;
  const emailByUid = new Map((teamCtx?.team?.members ?? []).map((m) => [m.uid, m.email] as const));

  const resolveDisplayName = (reviewerUid: string) => resolveReviewerDisplayName(reviewerUid, emailByUid.get(reviewerUid), callerEmail);

  const governance = await buildReviewGovernanceViewModel({
    governanceRecord: govParse.ok ? govParse.record : null,
    legacy,
    assignment,
    panel,
    votes,
    resolveDisplayName,
  });

  return NextResponse.json({ ok: true, governance });
}
