/**
 * Part E3 — Single-Reviewer Assignment for Adaptive Human Review
 * (docs/governance-decision-receipts-design.md §28). `{runId}` is the real
 * `runs/{runId}` panel run ID — `teamId` is NEVER accepted from the client
 * anywhere in this route, matching every other adaptive-runs route in this
 * codebase (Part D/E1). Deliberately NOT the path shape suggested in the
 * prompt (`/api/teams/{teamId}/runs/{runId}/...`), which would put a
 * client-supplied `teamId` in the URL — an explicit, repeatedly-reaffirmed
 * security principle this codebase's own conventions already established.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { getRequestUid, loadUserAndTeam, memberRole, isTeamAdmin } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import {
  submitAdaptiveHumanReviewAssignment,
  getAdaptiveHumanReviewAssignment,
  createAdaptiveHumanReviewAssignmentHistory,
} from "@/lib/firestore/runs";
import { writeAdaptiveAssignmentAdminAuditEvent, AdaptiveAssignmentAdminAuditAction } from "@/lib/governance/auditLog";
import {
  ELIGIBLE_REVIEWER_ROLES,
  classifyAssignmentEventType,
  buildAdaptiveHumanReviewAssignmentHistoryEntry,
  AdaptiveHumanReviewAssignmentV1,
} from "@/lib/governance/adaptiveHumanReviewAssignment";
import type { TeamDocument } from "@/lib/governance/teamTypes";
import { maskEmail } from "@/lib/utils/maskEmail";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

const EVENT_TYPE_TO_ADMIN_AUDIT_ACTION: Record<string, AdaptiveAssignmentAdminAuditAction> = {
  assigned: "adaptive_human_review_reviewer_assigned",
  reassigned: "adaptive_human_review_reviewer_reassigned",
  unassigned: "adaptive_human_review_reviewer_unassigned",
};

/**
 * Resolves a safe display string for a team member — their `users/{uid}.name`
 * if present, otherwise their team-roster email masked via the existing
 * `maskEmail()` helper (unmasked only if it's the CALLER's own email) —
 * the identical precedent already established in `GovernanceDashboard.tsx`.
 * Never returns a raw, unmasked email for anyone other than the caller.
 */
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

async function authorizeAndLoadContext(req: NextRequest, runId: string) {
  const uidOrRes = await getRequestUid(req);
  if (uidOrRes instanceof NextResponse) return { errorRes: uidOrRes } as const;
  const uid = uidOrRes;

  if (!runId) return { errorRes: errorResponse(400, "bad_request", "runId required") } as const;
  if (!adminDb) return { errorRes: errorResponse(503, "firestore_unavailable", "Database unavailable.") } as const;

  const ctx = await loadUserAndTeam(uid);
  if (!ctx?.team) return { errorRes: errorResponse(403, "forbidden", "Team access required") } as const;
  const team = ctx.team;
  const role = memberRole(uid, team);
  if (!isTeamAdmin(role)) return { errorRes: errorResponse(403, "insufficient_role", "Admin access required") } as const;

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
    logger.warn("[adaptive-runs/assignment] Forged or malformed adaptive projection rejected", { runId, teamId: team.id });
    return { errorRes: errorResponse(404, "projection_invalid", "No valid adaptive review projection exists for this run.") } as const;
  }

  const runSnap = await adminDb.collection("runs").doc(runId).get();
  if (!runSnap.exists) {
    return { errorRes: errorResponse(404, "not_found", "Run not found.") } as const;
  }

  return { uid, team, callerEmail: ctx.user?.email } as const;
}

async function buildAssignmentResponsePayload(team: TeamDocument, assignment: AdaptiveHumanReviewAssignmentV1 | null, callerEmail: string | undefined) {
  const assignedReviewerUserId = assignment?.assignedReviewerUserId ?? null;
  let assignedReviewerDisplayName: string | null = null;
  if (assignedReviewerUserId) {
    const member = team.members.find((m) => m.uid === assignedReviewerUserId);
    assignedReviewerDisplayName = await resolveDisplayName(assignedReviewerUserId, member?.email ?? "", callerEmail);
  }

  const eligibleMembers = team.members.filter((m) => ELIGIBLE_REVIEWER_ROLES.has(m.role));
  const eligibleReviewers = await Promise.all(
    eligibleMembers.map(async (m) => ({
      userId: m.uid,
      displayName: await resolveDisplayName(m.uid, m.email, callerEmail),
    }))
  );

  return {
    assignment: {
      assignedReviewerUserId,
      assignedReviewerDisplayName,
      assignedAt: assignment?.assignedAt ?? null,
      assignedByUserId: assignment?.assignedByUserId ?? null,
      revision: assignment?.revision ?? 0,
    },
    eligibleReviewers,
  };
}

export async function GET(req: NextRequest, { params }: { params: { runId: string } }) {
  const ctx = await authorizeAndLoadContext(req, params.runId);
  if ("errorRes" in ctx) return ctx.errorRes;
  const { team, callerEmail } = ctx;

  const assignmentResult = await getAdaptiveHumanReviewAssignment(params.runId);
  if (assignmentResult.status === "firestore_unavailable" || assignmentResult.status === "read_failed") {
    return errorResponse(503, "firestore_unavailable", "Could not load assignment.");
  }
  const assignment = assignmentResult.status === "found" ? assignmentResult.assignment : null;

  const payload = await buildAssignmentResponsePayload(team, assignment, callerEmail);
  return NextResponse.json({ ok: true, ...payload });
}

async function handleMutation(req: NextRequest, runId: string, mode: "put" | "delete") {
  const ctx = await authorizeAndLoadContext(req, runId);
  if ("errorRes" in ctx) return ctx.errorRes;
  const { uid, team, callerEmail } = ctx;

  let newReviewerUserId: string | null = null;
  let expectedRevision = 0;
  if (mode === "put") {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return errorResponse(400, "bad_request", "Invalid JSON.");
    }
    const body = (rawBody ?? {}) as { assignedReviewerUserId?: unknown; expectedRevision?: unknown };
    if (typeof body.assignedReviewerUserId !== "string" || !body.assignedReviewerUserId.trim()) {
      return errorResponse(400, "validation_error", "assignedReviewerUserId is required.");
    }
    newReviewerUserId = body.assignedReviewerUserId;
    if (body.expectedRevision !== undefined) {
      if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
        return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
      }
      expectedRevision = body.expectedRevision;
    }

    // Reviewer eligibility (§E3 objective 4): must be a CURRENT team member
    // with a role that can actually pass isTeamAdmin() at submission time —
    // assigning anyone else would create an assignment that could never be
    // fulfilled, since assignment never grants permission on its own.
    const targetMember = team.members.find((m) => m.uid === newReviewerUserId);
    if (!targetMember) {
      return errorResponse(400, "validation_error", "The proposed reviewer is not a member of this team.");
    }
    if (!ELIGIBLE_REVIEWER_ROLES.has(targetMember.role)) {
      return errorResponse(400, "validation_error", "The proposed reviewer does not have the permission required to review.");
    }
  } else {
    // DELETE — expectedRevision may still be supplied via a JSON body for
    // symmetry with PUT's own optimistic-concurrency mechanism.
    try {
      const rawBody = await req.json();
      const body = (rawBody ?? {}) as { expectedRevision?: unknown };
      if (body.expectedRevision !== undefined) {
        if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
          return errorResponse(400, "validation_error", "expectedRevision must be a non-negative integer.");
        }
        expectedRevision = body.expectedRevision;
      }
    } catch {
      // A body-less DELETE is valid — expectedRevision simply defaults to 0.
    }
  }

  const result = await submitAdaptiveHumanReviewAssignment({
    runId,
    teamId: team.id,
    newReviewerUserId,
    actorUserId: uid,
    expectedRevision,
  });

  if (!result.ok) {
    switch (result.reason) {
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
        return errorResponse(409, "not_pending", "This review is no longer pending — assignment can only change while a review is pending.");
      case "stale_revision":
        return errorResponse(409, "stale_revision", "This assignment changed since you last viewed it. Please refresh and try again.");
      default:
        return errorResponse(500, "internal_error", "Could not update the assignment.");
    }
  }

  const { assignment, previousReviewerUserId } = result;
  const eventType = classifyAssignmentEventType(previousReviewerUserId, assignment.assignedReviewerUserId);

  let historyStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const historyEntry = buildAdaptiveHumanReviewAssignmentHistoryEntry({
      teamId: team.id,
      runId,
      previousReviewerUserId,
      newReviewerUserId: assignment.assignedReviewerUserId,
      assignmentRevision: assignment.revision,
      changedAt: assignment.updatedAt,
      changedByUserId: uid,
    });
    const historyResult = await createAdaptiveHumanReviewAssignmentHistory(runId, historyEntry);
    historyStatus = historyResult.status;
    if (historyStatus === "failed") {
      logger.warn("[adaptive-runs/assignment] Assignment-history write did not save after a successful canonical assignment", { runId, teamId: team.id });
    }
  } catch {
    logger.warn("[adaptive-runs/assignment] Assignment-history write threw after a successful canonical assignment", { runId, teamId: team.id });
  }

  let auditStatus: "recorded" | "already_exists" | "failed" = "failed";
  try {
    const auditResult = await writeAdaptiveAssignmentAdminAuditEvent({
      action: EVENT_TYPE_TO_ADMIN_AUDIT_ACTION[eventType],
      actorUid: uid,
      teamId: team.id,
      runId,
      previousReviewerUserId,
      newReviewerUserId: assignment.assignedReviewerUserId,
      assignmentRevision: assignment.revision,
      at: assignment.updatedAt,
    });
    auditStatus = auditResult.status;
    if (auditStatus === "failed") {
      logger.warn("[adaptive-runs/assignment] Admin audit write did not save after a successful canonical assignment", { runId, teamId: team.id });
    }
  } catch {
    logger.warn("[adaptive-runs/assignment] Admin audit write threw after a successful canonical assignment", { runId, teamId: team.id });
  }

  const payload = await buildAssignmentResponsePayload(team, assignment, callerEmail);
  return NextResponse.json({ ok: true, ...payload, historyStatus, auditStatus });
}

export async function PUT(req: NextRequest, { params }: { params: { runId: string } }) {
  return handleMutation(req, params.runId, "put");
}

export async function DELETE(req: NextRequest, { params }: { params: { runId: string } }) {
  return handleMutation(req, params.runId, "delete");
}
