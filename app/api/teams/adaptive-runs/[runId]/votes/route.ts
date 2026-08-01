/**
 * Immutable Multi-Reviewer Vote Contract and Submission, Part C
 * (docs/governance-decision-receipts-design.md §29, §30, §31). `{runId}`
 * is the real `runs/{runId}` panel run ID — `teamId`, reviewer identity,
 * `submittedAt`, the vote ID, `quorum`, reviewer count, panel mode, an
 * aggregate/final status, and actor identity are NEVER accepted from the
 * client anywhere in this route; every authoritative value is
 * server-derived, matching every other adaptive-runs route.
 *
 * PART C SCOPE ONLY: no aggregation, no quorum completion, no
 * finalization, no canonical `governanceRecord.humanReview` write.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, isTeamAdmin, memberRole } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { getAdaptiveHumanReviewPanel, getAdaptiveHumanReviewVote, submitAdaptiveHumanReviewVote } from "@/lib/firestore/runs";
import { parseSubmitAdaptiveReviewVoteRequest } from "@/lib/governance/adaptiveHumanReviewVote";
import { ELIGIBLE_PANEL_REVIEWER_ROLES } from "@/lib/governance/adaptiveHumanReviewPanel";
import { parseGovernanceRecord, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";
import type { TeamDocument } from "@/lib/governance/teamTypes";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";
import { maskEmail } from "@/lib/utils/maskEmail";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

async function resolveDisplayName(uid: string, fallbackEmail: string, callerEmail: string | undefined): Promise<string> {
  try {
    const snap = await adminDb!.collection("users").doc(uid).get();
    const name = typeof snap.data()?.name === "string" ? (snap.data()!.name as string).trim() : "";
    if (name) return name;
  } catch {
    // Fall through to the email-based fallback.
  }
  return maskEmail(fallbackEmail, callerEmail);
}

/**
 * Shared context loader — authentication, team, deterministic
 * run/team-relationship check (identical to every other adaptive-runs
 * route), and a governanceRecord parse. Deliberately does NOT gate on
 * `isTeamAdmin`: for GET, the caller must still be a team admin/owner
 * (checked separately by each handler, matching every sibling
 * read-endpoint); for POST, voting authorization is panel membership +
 * current eligibility, NOT a standalone admin gate (§C7 — "do not require
 * owner/admin merely to vote"). In THIS codebase's actual role model the
 * two happen to coincide completely (only owner/admin can ever be
 * eligible panel members), but the code should not conflate "is an admin"
 * with "may vote" even though today they're equivalent in practice.
 */
async function loadContext(req: NextRequest, runId: string) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return { errorRes: uidOrRes } as const;
  const uid = uidOrRes;

  if (!runId) return { errorRes: errorResponse(400, "bad_request", "runId required") } as const;
  if (!adminDb) return { errorRes: errorResponse(503, "firestore_unavailable", "Database unavailable.") } as const;

  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) return { errorRes: errorResponse(403, "forbidden", "Team access required") } as const;
  const team = ctx.team;

  const projectionResult = await getAdaptiveTeamRunProjection(team.id, runId);
  if (projectionResult.status === "firestore_unavailable" || projectionResult.status === "read_failed") {
    return { errorRes: errorResponse(503, "firestore_unavailable", "Could not verify review eligibility.") } as const;
  }
  if (projectionResult.status === "not_found") {
    return { errorRes: errorResponse(404, "projection_missing", "No adaptive review projection exists for this run.") } as const;
  }
  const projection = projectionResult.projection;
  const projectionValid =
    projection.adaptive === true &&
    typeof projection.teamId === "string" &&
    projection.teamId === team.id &&
    typeof projection.runId === "string" &&
    projection.runId === runId;
  if (!projectionValid) {
    logger.warn("[adaptive-runs/votes] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return { errorRes: errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.") } as const;
  }

  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return { errorRes: errorResponse(404, "not_found", "Run not found.") } as const;
  }

  const govParse = parseGovernanceRecord(runSnap.data()?.governanceRecord);
  if (!govParse.ok) {
    if (govParse.reason === "absent") {
      return { errorRes: errorResponse(404, "governance_record_absent", "This run has no governance record.") } as const;
    }
    return { errorRes: errorResponse(500, "internal_error", "This run's governance record could not be read.") } as const;
  }

  return { uid, team, callerEmail: ctx.user?.email, governanceRecord: govParse.record } as const;
}

function mapVoteSubmissionFailure(reason: string) {
  switch (reason) {
    case "firestore_unavailable":
      return errorResponse(503, "firestore_unavailable", "Database unavailable.");
    case "run_missing":
      return errorResponse(404, "not_found", "Run not found.");
    case "governance_record_absent":
      return errorResponse(404, "governance_record_absent", "This run has no governance record.");
    case "governance_record_malformed":
    case "unsupported_version":
      return errorResponse(500, "internal_error", "This run's governance record could not be read.");
    case "not_pending":
      return errorResponse(409, "not_pending", "This review is no longer pending — votes can only be cast while a review is pending.");
    case "panel_absent":
      return errorResponse(404, "panel_absent", "No review panel exists for this run.");
    case "panel_cancelled":
      return errorResponse(409, "panel_cancelled", "This review panel has been cancelled — votes are no longer accepted.");
    case "panel_malformed":
    case "panel_unsupported_version":
      return errorResponse(409, "adaptive_review_panel_invalid", "This run's review panel could not be read.");
    case "panel_stale":
      return errorResponse(409, "panel_stale", "This panel has changed since you last viewed it. Please refresh and try again.");
    case "reviewer_not_assigned":
      return errorResponse(403, "reviewer_not_assigned", "You are not currently assigned to review this run.");
    case "vote_conflict":
      return errorResponse(409, "vote_already_submitted", "You have already submitted a different vote for this panel revision.");
    case "vote_malformed":
      return errorResponse(500, "internal_error", "Your existing vote could not be read.");
    default:
      return errorResponse(500, "internal_error", "Could not submit your vote.");
  }
}

export async function POST(req: NextRequest, { params }: { params: { runId: string } }) {
  const ctx = await loadContext(req, params.runId);
  if ("errorRes" in ctx) return ctx.errorRes;
  const { uid, team, governanceRecord } = ctx;

  if (!isHumanReviewStatusReviewable((governanceRecord as GovernanceRecordV1).humanReview.status)) {
    return errorResponse(409, "not_pending", "This review is no longer pending — votes can only be cast while a review is pending.");
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "Invalid JSON.");
  }
  const parsed = parseSubmitAdaptiveReviewVoteRequest(rawBody);
  if (!parsed.ok) {
    return errorResponse(400, "validation_error", `Invalid vote request: ${parsed.reason}`);
  }
  const { panelRevision, status, comment, conditions } = parsed.value;

  // Friendly, non-authoritative pre-checks — the transaction re-validates
  // all of this fresh and is the sole authoritative source of truth.
  const panelResult = await getAdaptiveHumanReviewPanel(params.runId, team.id);
  if (panelResult.status === "firestore_unavailable" || panelResult.status === "read_failed") {
    return errorResponse(503, "firestore_unavailable", "Could not verify review panel status.");
  }
  if (panelResult.status === "absent") {
    return errorResponse(404, "panel_absent", "No review panel exists for this run.");
  }
  if (panelResult.status === "malformed" || panelResult.status === "unsupported_version") {
    return errorResponse(409, "adaptive_review_panel_invalid", "This run's review panel could not be read.");
  }
  const panel = panelResult.panel;
  if (panel.status !== "open") {
    return errorResponse(409, "panel_cancelled", "This review panel has been cancelled — votes are no longer accepted.");
  }
  if (panel.revision !== panelRevision) {
    return errorResponse(409, "panel_stale", "This panel has changed since you last viewed it. Please refresh and try again.");
  }
  if (!panel.reviewerUserIds.includes(uid)) {
    return errorResponse(403, "reviewer_not_assigned", "You are not currently assigned to review this run.");
  }
  const role = memberRole(uid, team as TeamDocument);
  if (!role || !ELIGIBLE_PANEL_REVIEWER_ROLES.has(role)) {
    return errorResponse(403, "reviewer_not_assigned", "You are not currently assigned to review this run.");
  }

  const result = await submitAdaptiveHumanReviewVote({
    runId: params.runId,
    teamId: team.id,
    reviewerUserId: uid,
    panelRevision,
    status,
    comment,
    conditions,
  });

  if (!result.ok) {
    return mapVoteSubmissionFailure(result.reason);
  }

  const vote = result.vote;
  return NextResponse.json({
    ok: true,
    version: 1,
    submissionStatus: result.submissionStatus,
    vote: {
      status: vote.status,
      submittedAt: vote.submittedAt,
      commentPresent: vote.commentPresent,
      conditionsCount: vote.conditionsCount,
      comment: vote.comment,
      conditions: vote.conditions,
    },
  });
}

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  const ctx = await loadContext(req, params.runId);
  if ("errorRes" in ctx) return ctx.errorRes;
  const { uid, team, callerEmail } = ctx;

  const role = memberRole(uid, team as TeamDocument);
  if (!isTeamAdmin(role)) {
    return errorResponse(403, "insufficient_role", "Admin access required");
  }

  const panelResult = await getAdaptiveHumanReviewPanel(params.runId, team.id);
  if (panelResult.status === "firestore_unavailable" || panelResult.status === "read_failed") {
    return errorResponse(503, "firestore_unavailable", "Could not load review panel.");
  }
  if (panelResult.status === "absent") {
    return errorResponse(404, "panel_absent", "No review panel exists for this run.");
  }
  if (panelResult.status === "malformed" || panelResult.status === "unsupported_version") {
    return errorResponse(409, "adaptive_review_panel_invalid", "This run's review panel could not be read.");
  }
  const panel = panelResult.panel;

  const voteEntries = await Promise.all(
    panel.reviewerUserIds.map(async (reviewerId) => {
      const voteResult = await getAdaptiveHumanReviewVote(params.runId, panel.revision, reviewerId, team.id);
      if (voteResult.status !== "found") {
        if (voteResult.status === "malformed" || voteResult.status === "unsupported_version") {
          logger.warn("[adaptive-runs/votes] Skipping unreadable stored vote", { runId: params.runId, teamId: team.id });
        }
        return null;
      }
      const vote = voteResult.vote;
      const isCurrentUser = vote.reviewerUserId === uid;
      const member = (team as TeamDocument).members.find((m) => m.uid === reviewerId);
      const reviewerDisplayName = await resolveDisplayName(reviewerId, member?.email ?? "", callerEmail);
      return {
        reviewerUserId: vote.reviewerUserId,
        reviewerDisplayName,
        status: vote.status,
        submittedAt: vote.submittedAt,
        isCurrentUser,
        commentPresent: vote.commentPresent,
        conditionsCount: vote.conditionsCount,
        // Privacy (§C14, a deliberate narrowing from the original §29.14
        // design — see docs/governance-decision-receipts-design.md §31.13):
        // full comment/conditions text is visible ONLY to the vote's own
        // author in Part C, never to any other viewer, including an
        // owner/admin who is not that reviewer.
        comment: isCurrentUser ? vote.comment : undefined,
        conditions: isCurrentUser ? vote.conditions : undefined,
      };
    })
  );
  const votes = voteEntries.filter((v): v is NonNullable<typeof v> => v !== null);

  return NextResponse.json({
    ok: true,
    version: 1,
    panelRevision: panel.revision,
    panelStatus: panel.status,
    reviewerCount: panel.reviewerUserIds.length,
    submittedCount: votes.length,
    votes,
  });
}
