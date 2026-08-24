/**
 * Approval Workflow, Phase 9B.6 — run-qualified, manager-only eligible
 * reviewer candidates for assignment/panel selectors:
 * `GET /api/workspaces/{workspaceId}/runs/{runId}/reviewer-candidates`.
 *
 * Deliberately NOT a general Workspace member directory (Phase 9C.0
 * Correction C) — returns only members who are CURRENTLY eligible to be
 * an ordinary/panel reviewer for THIS specific run, using the exact same
 * `isValidAssignmentTarget()` pure eligibility function every mutation
 * route already uses (active membership, `research.read`, `reviews.submit`,
 * not the canonical creator, same Workspace) — no separate eligibility
 * logic invented here. Backend mutation routes remain independently
 * authoritative regardless of what this list returns.
 *
 * Bounded read: `workspaceMemberships` has no documented product-level
 * membership-count cap, and no pagination mechanism exists for it today —
 * this module imposes its own defensive `MAX_CANDIDATES_SCANNED` limit on
 * the query itself (a plain two-equality-clause query, `workspaceId ==`
 * AND `status ==`, which Firestore's automatic indexing already supports
 * without a new composite index) rather than performing an unbounded
 * collection scan. A Workspace exceeding this bound needs a real
 * paginated selector in a later phase — out of scope here.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { logger } from "@/lib/logger";
import { resolveWorkspaceReviewTarget } from "./resolveWorkspaceReviewTarget";
import { isValidAssignmentTarget, type WorkspaceReviewCandidate } from "./workspaceReviewEligibility";
import { validateMembershipBinding } from "./membershipBinding";
import { resolveReviewerDisplayNames, REVIEWER_UNAVAILABLE_LABEL } from "@/lib/governance/reviewerIdentity";

const MAX_CANDIDATES_SCANNED = 200;

export interface ReviewerCandidateDto {
  uid: string;
  displayName: string;
}

export type GetReviewerCandidatesResult = { status: "ok"; reviewers: ReviewerCandidateDto[] } | { status: "run_not_found" } | { status: "query_failed" };

export async function getReviewerCandidates(args: { workspaceId: string; runId: string }): Promise<GetReviewerCandidatesResult> {
  if (!adminDb) return { status: "query_failed" };
  const db = adminDb;
  try {
    const runSnap = await db.collection("runs").doc(args.runId).get();
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

    const snap = await db.collection("workspaceMemberships").where("workspaceId", "==", args.workspaceId).where("status", "==", "active").limit(MAX_CANDIDATES_SCANNED).get();

    const eligibleUids: string[] = [];
    for (const doc of snap.docs) {
      const raw = doc.data() as Record<string, unknown>;
      // Discovered via query, not a known-uid lookup — the raw `uid` field
      // is untrusted input here. `validateMembershipBinding` still
      // performs the check that matters: the document's own id must be
      // self-consistent with its own embedded (workspaceId, uid) fields,
      // exactly like every other confused-deputy-resistant membership read
      // in this codebase.
      const membership = typeof raw.uid === "string" ? validateMembershipBinding(raw, { workspaceId: args.workspaceId, uid: raw.uid }) : null;
      if (!membership) continue;
      const candidate: WorkspaceReviewCandidate = { uid: membership.uid, workspaceId: membership.workspaceId, role: membership.role, status: membership.status };
      const eligibility = isValidAssignmentTarget({ candidate, runWorkspaceId: args.workspaceId, creatorUid: target.creatorUid });
      if (eligibility.eligible) eligibleUids.push(membership.uid);
    }

    const nameByUid = eligibleUids.length > 0 ? await resolveReviewerDisplayNames(eligibleUids, new Map(), undefined, REVIEWER_UNAVAILABLE_LABEL) : new Map<string, string>();
    const reviewers = eligibleUids
      .map((uid) => ({ uid, displayName: nameByUid.get(uid) ?? REVIEWER_UNAVAILABLE_LABEL }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.uid.localeCompare(b.uid));

    return { status: "ok", reviewers };
  } catch (err) {
    logger.warn("[workspaces/reviewerCandidates] getReviewerCandidates failed", { workspaceId: args.workspaceId, runId: args.runId, error: err instanceof Error ? err.message : String(err) });
    return { status: "query_failed" };
  }
}
