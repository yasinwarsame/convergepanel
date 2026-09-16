import "server-only";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { getAdaptiveTeamRunProjection } from "@/lib/firestore/teamRuns";
import { getAdaptiveHumanReviewAssignment } from "@/lib/firestore/runs";
import { logger } from "@/lib/logger";
import type { RunReadReviewRouting } from "./runReadPayload";

/**
 * Team Research Parity, Phase R1 — the read-only `reviewRouting` resolver
 * extracted verbatim from `GET /api/user/runs/[runId]` so both research read
 * routes derive it identically.
 *
 * `reviewRouting` distinguishes "still awaiting a reviewer" from "no review
 * was ever configured for this run" (see reportStatus.ts). It is resolved
 * from the RUN OWNER's team/assignment context, never the viewer's — it
 * describes the run's own review-routing state, identical no matter who is
 * looking. "not_configured" is returned ONLY when the absence of review
 * routing is positively confirmed; every failure, malformed/forged
 * projection, or thrown error resolves to "unknown" (fails closed toward
 * "still needs attention"). This function is read-only: it never creates or
 * mutates a teamRuns projection and never touches governanceRecord.
 *
 * Log message strings are preserved verbatim from the original route so
 * existing observability contracts are unchanged.
 */
export async function resolveRunReviewRouting(args: { runId: string; ownerUid: string; requestId?: string }): Promise<RunReadReviewRouting> {
  const { runId, ownerUid: owner, requestId } = args;
  try {
    const teamCtx = await loadUserAndTeam(owner);
    if (!teamCtx?.team) {
      // Reviewer Assignment Propagation — a personal (non-team) run can
      // still have a real, canonical humanReviewAssignment. A genuine read
      // failure degrades to "unknown" (fails closed), never "not_configured".
      const assignmentResult = await getAdaptiveHumanReviewAssignment(runId);
      if (assignmentResult.status === "found" && assignmentResult.assignment.assignedReviewerUserId) {
        return "in_queue";
      }
      if (assignmentResult.status === "unassigned") {
        return "not_configured";
      }
      logger.warn("[user/runs] Personal reviewer-assignment lookup failed during history reload", {
        runId,
        errorCategory: assignmentResult.status,
      });
      return "unknown";
    }
    const projectionResult = await getAdaptiveTeamRunProjection(teamCtx.team.id, runId);
    if (projectionResult.status === "not_found") {
      return "not_configured";
    }
    if (projectionResult.status === "found") {
      const projection = projectionResult.projection;
      const projectionValid =
        projection.projectionVersion === 1 &&
        projection.adaptive === true &&
        typeof projection.teamId === "string" &&
        projection.teamId === teamCtx.team.id &&
        typeof projection.runId === "string" &&
        projection.runId === runId;
      if (projectionValid) {
        return "in_queue";
      }
      logger.warn("[user/runs] Malformed or forged adaptive team-run projection during history reload", {
        runId,
        teamId: teamCtx.team.id,
        errorCategory: "malformed_projection",
        requestId,
      });
      return "unknown";
    }
    // "firestore_unavailable" / "read_failed" — a genuine, unresolved
    // lookup failure, not a confirmed absence of review config.
    logger.warn("[user/runs] Adaptive team-run projection lookup failed during history reload", {
      runId,
      teamId: teamCtx.team.id,
      errorCategory: projectionResult.status,
      requestId,
    });
    return "unknown";
  } catch (err: unknown) {
    logger.warn("[user/runs] reviewRouting resolution threw during history reload", {
      runId,
      errorCategory: "unresolved_lookup_error",
      errorMessage: err instanceof Error ? err.message : "unknown_error",
      requestId,
    });
    return "unknown";
  }
}
