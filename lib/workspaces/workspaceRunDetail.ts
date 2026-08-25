/**
 * Approval Workflow, Phase 9C.1-R1C — the minimal, READ-ONLY presentation
 * model backing `/workspace/reviews/[runId]`, the new permanent
 * Workspace-native run-detail route. Fixes the second R1-confirmed
 * defect: queue rows previously navigated to `/reviews/{runId}`
 * (`PersonalReviewDetail`, which only ever accepts
 * `viewerRole === "personal_reviewer"` — a value the Workspace-bound API
 * branch can never return — so every legitimate Workspace-run access
 * rendered as "You don't have access to this review"). This module is
 * entirely independent of that Personal auth path and of the legacy
 * `/team/reviews/{runId}` (`/api/teams/adaptive-runs/...`) namespace —
 * Workspace-native authorization only, exactly mirroring the pattern
 * every other Phase 9 read/mutation module already uses.
 *
 * CANONICAL WORKSPACE SOURCE (Phase 9C.1-R1C, frozen): unlike every other
 * Phase 9 route, this one has no `{workspaceId}` route param — the run
 * itself supplies canonical Workspace context. The run's own
 * `workspaceId` field is read, then fed BACK into
 * `resolveWorkspaceReviewTarget()` as the "requested" scope — this proves
 * the field is well-formed and genuinely Team-bound (via
 * `classifyRunWorkspaceBindingShape()`) without trusting it blindly; the
 * function's own `requestedWorkspaceId !== binding.workspaceId` guard is
 * therefore always trivially satisfied by construction, and
 * `target.workspaceId` becomes the one value ever passed to
 * `resolveTeamRunWorkspaceAccess()`. No `?workspace=` query parameter is
 * ever consulted or needed here, even for a uid with multiple active
 * Team Workspace memberships — this route is unambiguous by design.
 *
 * SCOPE (Phase 9C.1, still read-only): this is intentionally NOT
 * `getReviewContext()` — no assignment/panel/`viewer.can*` data, no OCC
 * tokens, no governance mutation preparation of any kind. It exists only
 * to be a valid destination with genuine research content, Workspace
 * name, Project context, and (best-effort) current review status. 9C.2+
 * will layer the real review UI onto this same route.
 */

import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { resolveTeamRunWorkspaceAccess } from "./resolveTeamRunWorkspaceAccess";
import { getProject } from "@/lib/firestore/projects";
import { parseGovernanceRecord, type HumanReviewStatus } from "@/lib/adaptiveSchema/governanceRecordParser";
import { parseAdaptiveHumanReviewPanel } from "@/lib/governance/adaptiveHumanReviewPanel";

const MAX_RUN_LABEL_LENGTH = 200;

function truncateRunLabel(s: string): string {
  const t = s.trim();
  return t.length <= MAX_RUN_LABEL_LENGTH ? t : `${t.slice(0, MAX_RUN_LABEL_LENGTH)}…`;
}

function createdAtToIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === "string") return value;
  return null;
}

export interface WorkspaceRunDetailInfo {
  runId: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  runLabel: string;
  /** `null` only when the run has no parseable `governanceRecord` yet — never fabricated. */
  reviewStatus: HumanReviewStatus | null;
  createdAt: string | null;
  reviewedAt: string | null;
}

export type GetWorkspaceRunDetailResult = { status: "ok"; detail: WorkspaceRunDetailInfo } | { status: "not_found" } | { status: "read_failed" };

/**
 * `approvalAdmitted` alone is NOT sufficient for admission (Phase 9C.4):
 * this route now mirrors `getReviewContext()`'s own drain-admission rule
 * exactly — Team Workspace access is established FIRST (never queried
 * before that, matching `review-context/route.ts`'s documented ordering),
 * and if Approval Workflow is not admitted, a run with an existing,
 * validly-parsed panel (any status) is STILL admitted (drain-eligible),
 * because Phase 9C.4 adds real drain-mode mutation controls to this same
 * route via `WorkspaceRunReviewSection`. An assignment existing alone, or
 * an unreviewed run with no panel, is never drain-admission — identical to
 * `getReviewContext()` (Phase 9C.0 Correction A/B) — this is the exact
 * same rule re-evaluated here, not a second authorization implementation
 * (no new Firestore read beyond the same `humanReviewPanel/current`
 * document `getReviewContext` itself reads). Every denial path — run
 * missing, not Team-Workspace-bound, wrong Workspace, malformed, neither
 * normal nor drain admitted, Team Workspace access denied, missing
 * `research.read` or `reviews.read` — returns the SAME `"not_found"`,
 * matching every other Phase 9 concealment convention (§38: never a
 * message that reveals a valid run exists).
 */
export async function getWorkspaceRunDetail(args: { runId: string; uid: string; approvalAdmitted: boolean }): Promise<GetWorkspaceRunDetailResult> {
  if (!adminDb) return { status: "read_failed" };
  const db = adminDb;

  try {
    const runRef = db.collection("runs").doc(args.runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return { status: "not_found" };
    const runData = runSnap.data() as Record<string, unknown>;

    const target = resolveWorkspaceReviewTarget({
      requestedWorkspaceId: typeof runData.workspaceId === "string" ? runData.workspaceId : "",
      hasWorkspaceIdField: "workspaceId" in runData,
      workspaceIdValue: runData.workspaceId,
      userId: runData.userId,
      hasProjectIdField: "projectId" in runData,
      projectIdValue: runData.projectId,
    });
    if (target.kind !== "valid_workspace_review_target") return { status: "not_found" };

    // Team Workspace access FIRST — see module doc comment.
    const access = await resolveTeamRunWorkspaceAccess({ uid: args.uid, workspaceId: target.workspaceId });
    if (!access.granted) return { status: "not_found" };
    if (!access.capabilities.includes("research.read") || !access.capabilities.includes("reviews.read")) return { status: "not_found" };

    if (!args.approvalAdmitted) {
      const panelSnap = await runRef.collection("humanReviewPanel").doc("current").get();
      const panelParse = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, { expectedRunId: args.runId });
      const drainEligible = panelParse.status === "valid";
      if (!drainEligible) return { status: "not_found" };
    }

    let projectName: string | null = null;
    if (target.projectId) {
      const projectResult = await getProject(target.projectId);
      if (projectResult.status === "found") projectName = projectResult.project.name;
    }

    let reviewStatus: HumanReviewStatus | null = null;
    let reviewedAt: string | null = null;
    const govParse = parseGovernanceRecord(runData.governanceRecord);
    if (govParse.ok) {
      reviewStatus = govParse.record.humanReview.status;
      reviewedAt = govParse.record.humanReview.reviewedAt ?? null;
    }

    return {
      status: "ok",
      detail: {
        runId: args.runId,
        workspaceId: target.workspaceId,
        workspaceName: access.workspace.name,
        projectId: target.projectId,
        projectName,
        runLabel: truncateRunLabel(typeof runData.question === "string" ? runData.question : ""),
        reviewStatus,
        createdAt: createdAtToIso(runData.createdAt),
        reviewedAt,
      },
    };
  } catch (err) {
    logger.warn("[workspaces/workspaceRunDetail] read failed", { runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}
