/**
 * Approval Workflow, Phase 9B.6 — the ONE consolidated, read-only,
 * server-computed presentation model for the Phase 9C run-review UI:
 * `GET /api/workspaces/{workspaceId}/runs/{runId}/review-context`.
 *
 * Exists specifically so the frontend never has to combine raw
 * assignment/panel/governance state into its own independent governance
 * state machine, never has to infer "can I do X" from a role name, and
 * never has to render a raw UID. Every `viewer.can*` flag is a
 * presentation HINT only — computed here from the same pure eligibility
 * helpers (`isValidAssignmentTarget`, `isOrdinaryReviewerAuthorized`,
 * `violatesDecisionSelfReviewGuard`, `roleHasCapability`) the actual
 * mutation transactions use, but this module performs NO writes and is
 * NEVER authoritative — every mutation route reauthorizes independently,
 * regardless of what a prior GET returned (see each `can*` field's own
 * comment for the exact mutation-route condition it mirrors).
 *
 * ADMISSION MODEL (frozen per the Phase 9C.0 corrections — do not port
 * legacy "open || finalized" panel-blocking logic, and do not treat
 * assignment-only state as drain-eligible):
 *   - "normal" mode: Approval Workflow admitted (checked by the ROUTE,
 *     passed in as `approvalAdmitted`), full context returned.
 *   - "drain" mode: Approval Workflow NOT admitted, but a panel currently
 *     EXISTS for this run (any status — open/cancelled/finalized) — this
 *     mirrors `getWorkspaceReviewPanel()`'s own drain-read precedent
 *     exactly (Phase 9B.5.2). An assignment existing alone, or an
 *     unreviewed/changes_requested run with NO panel, is NEVER drain
 *     admission — those are ordinary "new work" surfaces (assignment
 *     GET/PUT/DELETE, ordinary decision, resubmit) that this phase does
 *     NOT retrofit drain behavior into (Phase 9C.0 Correction B).
 *   - Neither mode: concealed denial (`not_admitted`), identical response
 *     shape to every other Phase 9 concealment case.
 *
 * SINGLE-REVIEW / PANEL RULE (Phase 9C.0 Correction A, frozen): only an
 * OPEN panel blocks ordinary single-review presentation
 * (`canManageAssignment`/`canSubmitDecision`). A finalized or cancelled
 * panel is read-only governance evidence and does NOT suppress the
 * single-reviewer fallback after a `changes_requested` → resubmit cycle —
 * this exactly mirrors what `putWorkspaceReviewPanel()`/
 * `submitWorkspaceReviewDecision()` (9B.5.1/9B.5.2) already enforce at the
 * mutation layer; this module must never compute a presentation hint that
 * disagrees with it.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { isValidAssignmentTarget, isOrdinaryReviewerAuthorized, violatesDecisionSelfReviewGuard, type WorkspaceReviewCandidate } from "./workspaceReviewEligibility";
import { computeMembershipId } from "./membershipId";
import { validateMembershipBinding } from "./membershipBinding";
import { roleHasCapability } from "./capabilities";
import { parseGovernanceRecord, isHumanReviewStatusReviewable } from "@/lib/adaptiveSchema/governanceRecordParser";
import { isCanonicalDueAt, type AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";
import { parseAdaptiveHumanReviewPanel, type AdaptiveHumanReviewPanelV1 } from "@/lib/governance/adaptiveHumanReviewPanel";
import { aggregateAdaptiveReviewVotes } from "@/lib/governance/adaptiveReviewAggregation";
import { buildAdaptiveHumanReviewVoteId, parseAdaptiveHumanReviewVote } from "@/lib/governance/adaptiveHumanReviewVote";
import { resolveReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";
import type { GovernanceRecordV1 } from "@/lib/adaptiveSchema/governanceRecord";

// ============================================
// DTO
// ============================================

export interface ReviewContextRunInfo {
  runId: string;
  workspaceId: string;
  projectId: string | null;
  label: string;
}

export interface ReviewContextReviewInfo {
  status: GovernanceRecordV1["humanReview"]["status"];
  reviewedAt: string | null;
  comment?: string;
  conditions?: string[];
  decidedVia?: "single_reviewer" | "multi_reviewer_panel" | "multi_reviewer_owner_override";
}

export interface ReviewContextAssignmentInfo {
  assignedReviewerUserId: string;
  assignedReviewerDisplayName: string;
  revision: number;
  assignedAt: string | null;
  updatedAt: string;
  dueAt: string | null;
  state: "actionable" | "stale";
}

export interface ReviewContextPanelReviewer {
  uid: string;
  displayName: string;
}

export interface ReviewContextPanelVoteSummary {
  submittedCount: number;
  aggregationState: "waiting" | "deadlocked" | "ready";
}

export interface ReviewContextPanelInfo {
  status: "open" | "cancelled" | "finalized";
  revision: number;
  reviewers: ReviewContextPanelReviewer[];
  voteSummary: ReviewContextPanelVoteSummary | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
}

export interface ReviewContextViewerInfo {
  mode: "normal" | "drain";
  isCreator: boolean;
  /** Mirrors `putWorkspaceReviewPanel`/`deleteWorkspaceReviewPanel`'s own `reviews.manage` + `research.read` + "no open panel" condition, minus panel creation itself. */
  canManageAssignment: boolean;
  /** Mirrors `submitWorkspaceReviewDecision`'s exact condition: current canonical assignment naming the caller, `reviews.submit` + `research.read`, not creator, reviewable, no open panel. A FINALIZED or cancelled panel never forces this false — only `status === "open"` does. */
  canSubmitDecision: boolean;
  /** Mirrors `resubmitWorkspaceReview`'s creator/manager paths. Normal mode only. */
  canResubmit: boolean;
  /** Mirrors `putWorkspaceReviewPanel`'s creation branch: no current panel document at all. */
  canCreatePanel: boolean;
  /** Mirrors `putWorkspaceReviewPanel`'s reconfigure branch: current panel `status === "open"`. */
  canReconfigurePanel: boolean;
  /** Mirrors `deleteWorkspaceReviewPanel`. Drain-eligible. */
  canCancelPanel: boolean;
  /** Mirrors `submitWorkspaceReviewPanelVote`. Drain-eligible. */
  canVote: boolean;
  hasVoted: boolean;
  /** Mirrors `finalizeWorkspaceReviewPanel`'s quorum-ready condition. Drain-eligible. */
  canFinalize: boolean;
  /** Mirrors `overrideWorkspaceReviewPanel`. Drain-eligible. */
  canOverride: boolean;
}

export interface ReviewContextDto {
  run: ReviewContextRunInfo;
  review: ReviewContextReviewInfo;
  assignment: ReviewContextAssignmentInfo | null;
  panel: ReviewContextPanelInfo | null;
  viewer: ReviewContextViewerInfo;
}

export type GetReviewContextResult =
  | { status: "ok"; context: ReviewContextDto }
  | { status: "run_not_found" }
  | { status: "not_admitted" }
  | { status: "firestore_unavailable" }
  | { status: "read_failed" };

const MAX_RUN_LABEL_LENGTH = 200;
function truncateRunLabel(s: string): string {
  const t = s.trim();
  return t.length <= MAX_RUN_LABEL_LENGTH ? t : `${t.slice(0, MAX_RUN_LABEL_LENGTH)}…`;
}

/**
 * Plain, non-transactional, read-only. Team Workspace access and
 * `research.read`/`reviews.read` are the CALLER's (route's) responsibility
 * — established BEFORE this is invoked, exactly mirroring
 * `getWorkspaceReviewPanel()`'s own division of labor. `approvalAdmitted`
 * is resolved by the route via `resolveApprovalWorkflowAdmission()` and
 * passed in, never decided here.
 */
export async function getReviewContext(args: { workspaceId: string; runId: string; uid: string; callerCandidate: WorkspaceReviewCandidate; approvalAdmitted: boolean }): Promise<GetReviewContextResult> {
  if (!adminDb) return { status: "firestore_unavailable" };
  const db = adminDb;
  try {
    const runRef = db.collection("runs").doc(args.runId);
    const runSnap = await runRef.get();
    if (!runSnap.exists) return { status: "run_not_found" };
    const runData = runSnap.data() as Record<string, unknown>;
    const target = resolveWorkspaceReviewTarget({
      requestedWorkspaceId: args.workspaceId,
      hasWorkspaceIdField: "workspaceId" in runData,
      workspaceIdValue: runData.workspaceId,
      userId: runData.userId,
      hasProjectIdField: "projectId" in runData,
      projectIdValue: runData.projectId,
    });
    if (target.kind !== "valid_workspace_review_target") return { status: "run_not_found" };

    const govParse = parseGovernanceRecord(runData.governanceRecord);
    if (!govParse.ok) return { status: "run_not_found" };
    const record = govParse.record;

    const [assignmentSnap, panelSnap] = await Promise.all([
      runRef.collection("humanReviewAssignment").doc("current").get(),
      runRef.collection("humanReviewPanel").doc("current").get(),
    ]);

    const panelParse = parseAdaptiveHumanReviewPanel(panelSnap.exists ? panelSnap.data() : undefined, { expectedRunId: args.runId });
    const panel: AdaptiveHumanReviewPanelV1 | null = panelParse.status === "valid" ? panelParse.panel : null;

    // ---- Admission decision (Correction A/B): drain only via an
    // EXISTING PANEL, never via assignment-only state. ----
    if (!args.approvalAdmitted && panel === null) return { status: "not_admitted" };
    const mode: "normal" | "drain" = args.approvalAdmitted ? "normal" : "drain";

    const rawAssignment = assignmentSnap.exists ? (assignmentSnap.data() as AdaptiveHumanReviewAssignmentV1) : null;
    const hasActiveAssignment = !!rawAssignment && typeof rawAssignment.assignedReviewerUserId === "string" && rawAssignment.assignedReviewerUserId.length > 0;

    // ---- Batch-resolve every identity this response needs, in one pass. ----
    const identityUids: string[] = [];
    if (hasActiveAssignment) identityUids.push(rawAssignment!.assignedReviewerUserId as string);
    if (panel) identityUids.push(...panel.reviewerUserIds);
    const nameByUid = identityUids.length > 0 ? await resolveReviewerDisplayNames(identityUids, new Map(), undefined, REVIEWER_UNAVAILABLE_LABEL) : new Map<string, string>();

    // ---- Assignment presentation + eligibility ----
    let assignmentInfo: ReviewContextAssignmentInfo | null = null;
    let assigneeEligible = false;
    if (hasActiveAssignment) {
      const assignedUid = rawAssignment!.assignedReviewerUserId as string;
      const membershipId = computeMembershipId(args.workspaceId, assignedUid);
      const membershipSnap = await db.collection("workspaceMemberships").doc(membershipId).get();
      const assigneeCandidate: WorkspaceReviewCandidate | null = membershipSnap.exists
        ? (() => {
            const m = validateMembershipBinding(membershipSnap.data(), { workspaceId: args.workspaceId, uid: assignedUid });
            return m ? { uid: m.uid, workspaceId: m.workspaceId, role: m.role, status: m.status } : null;
          })()
        : null;
      const eligibility = isValidAssignmentTarget({ candidate: assigneeCandidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid });
      assigneeEligible = eligibility.eligible;
      const dueAt = typeof rawAssignment!.dueAt === "string" && isCanonicalDueAt(rawAssignment!.dueAt) ? rawAssignment!.dueAt : null;
      assignmentInfo = {
        assignedReviewerUserId: assignedUid,
        assignedReviewerDisplayName: nameByUid.get(assignedUid) ?? REVIEWER_UNAVAILABLE_LABEL,
        revision: rawAssignment!.revision,
        assignedAt: rawAssignment!.assignedAt ?? null,
        updatedAt: rawAssignment!.updatedAt,
        dueAt,
        state: assigneeEligible ? "actionable" : "stale",
      };
    }

    // ---- Panel presentation + vote summary ----
    let panelInfo: ReviewContextPanelInfo | null = null;
    let hasVoted = false;
    let aggregationState: "waiting" | "deadlocked" | "ready" | null = null;
    if (panel) {
      let voteSummary: ReviewContextPanelVoteSummary | null = null;
      if (panel.status === "open") {
        const voteRefs = panel.reviewerUserIds.map((reviewerUid) => runRef.collection("humanReviewVotes").doc(buildAdaptiveHumanReviewVoteId(panel.revision, reviewerUid)));
        const voteSnaps = voteRefs.length > 0 ? await db.getAll(...voteRefs) : [];
        const votes = [];
        for (const snap of voteSnaps) {
          if (!snap.exists) continue;
          const parsed = parseAdaptiveHumanReviewVote(snap.data(), { expectedRunId: args.runId, expectedPanelRevision: panel.revision });
          if (parsed.status === "valid") {
            votes.push(parsed.vote);
            if (parsed.vote.reviewerUserId === args.uid) hasVoted = true;
          }
        }
        const aggregate = aggregateAdaptiveReviewVotes({ panel, votes });
        if (aggregate.status === "waiting" || aggregate.status === "deadlocked" || aggregate.status === "ready") {
          aggregationState = aggregate.status;
          voteSummary = { submittedCount: aggregate.submittedCount, aggregationState: aggregate.status };
        }
      }
      panelInfo = {
        status: panel.status,
        revision: panel.revision,
        reviewers: panel.reviewerUserIds.map((uid) => ({ uid, displayName: nameByUid.get(uid) ?? REVIEWER_UNAVAILABLE_LABEL })),
        voteSummary,
        createdAt: panel.createdAt,
        updatedAt: panel.updatedAt,
        finalizedAt: panel.finalizedAt ?? null,
      };
    }

    // ---- Viewer action flags — pure, from already-loaded state. ----
    const isCreator = args.uid === target.creatorUid;
    const canManageReviews = roleHasCapability(args.callerCandidate.role, "reviews.manage") && roleHasCapability(args.callerCandidate.role, "research.read");
    const canOverrideCapability = roleHasCapability(args.callerCandidate.role, "reviews.override") && roleHasCapability(args.callerCandidate.role, "research.read");
    const panelOpen = panel?.status === "open";
    const reviewable = isHumanReviewStatusReviewable(record.humanReview.status);

    const hasCanonicalAssignment = hasActiveAssignment && assignmentInfo!.assignedReviewerUserId === args.uid;
    const ordinaryAuth = isOrdinaryReviewerAuthorized({ reviewer: args.callerCandidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid, hasCanonicalAssignment });
    const selfReview = violatesDecisionSelfReviewGuard(args.uid, target.creatorUid);

    let canManageAssignment = mode === "normal" && canManageReviews && !panelOpen;
    let canSubmitDecision = !panelOpen && reviewable && ordinaryAuth.authorized && !selfReview;
    let canResubmit = mode === "normal" && record.humanReview.status === "changes_requested" && ((isCreator && roleHasCapability(args.callerCandidate.role, "research.read")) || canManageReviews);
    let canCreatePanel = mode === "normal" && canManageReviews && reviewable && !hasActiveAssignment && panel === null;
    let canReconfigurePanel = mode === "normal" && canManageReviews && panelOpen && !hasActiveAssignment;
    let canCancelPanel = panelOpen && canManageReviews;
    let canVote =
      panelOpen &&
      !hasVoted &&
      !selfReview &&
      !!panel &&
      panel.reviewerUserIds.includes(args.uid) &&
      isValidAssignmentTarget({ candidate: args.callerCandidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid }).eligible;
    let canFinalize = panelOpen && canManageReviews && aggregationState === "ready";
    let canOverride = panelOpen && canOverrideCapability && reviewable;

    // Drain mode: no NEW work, ever — mirrors every mutation route's own
    // Approval-admission gate (create/reconfigure/assignment/decision/
    // resubmit all require normal admission at the mutation layer itself).
    if (mode === "drain") {
      canManageAssignment = false;
      canSubmitDecision = false;
      canResubmit = false;
      canCreatePanel = false;
      canReconfigurePanel = false;
    }

    const context: ReviewContextDto = {
      run: { runId: args.runId, workspaceId: target.workspaceId, projectId: target.projectId, label: truncateRunLabel(typeof runData.question === "string" ? runData.question : "") },
      review: {
        status: record.humanReview.status,
        reviewedAt: record.humanReview.reviewedAt ?? null,
        ...(record.humanReview.comment !== undefined ? { comment: record.humanReview.comment } : {}),
        ...(record.humanReview.conditions !== undefined ? { conditions: record.humanReview.conditions } : {}),
        ...(record.humanReview.decidedVia !== undefined ? { decidedVia: record.humanReview.decidedVia } : {}),
      },
      assignment: assignmentInfo,
      panel: panelInfo,
      viewer: {
        mode,
        isCreator,
        canManageAssignment,
        canSubmitDecision,
        canResubmit,
        canCreatePanel,
        canReconfigurePanel,
        canCancelPanel,
        canVote,
        hasVoted,
        canFinalize,
        canOverride,
      },
    };

    return { status: "ok", context };
  } catch (err) {
    logger.warn("[workspaces/reviewContext] getReviewContext failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { status: "read_failed" };
  }
}
