/**
 * Workspace Review Authorization Core, Phase 9B.1 — pure, zero-I/O
 * reviewer-eligibility and self-review guard primitives for future
 * Workspace-qualified review mutations (assignment, panel, decision/vote).
 *
 * No I/O, no Firestore access, no capability-matrix mutation. Callers
 * supply already-resolved membership state (from
 * `authorizeTeamWorkspaceMutationInTransaction()` /
 * `resolveTeamRunWorkspaceAccess()`) and an already-resolved
 * `WorkspaceReviewTargetResult.creatorUid` (from
 * `resolveWorkspaceReviewTarget()`). This module never fetches either.
 *
 * `reviews.submit` is ELIGIBILITY ONLY (`lib/workspaces/capabilities.ts`'s
 * own frozen Phase 8B.2 design) — Owner, Admin, Member, and Reviewer all
 * currently hold it; Viewer does not. This module never hardcodes a role
 * allowlist for that reason: every check below is expressed as a
 * capability/state predicate (`roleHasCapability`, `status === "active"`,
 * UID equality), so the role names themselves are never the authority.
 * `reviews.submit` alone is never sufficient — every eligibility check
 * here additionally requires `research.read` (checked explicitly, never
 * assumed merely because the current matrix happens to grant both to the
 * same roles) and, for `isOrdinaryReviewerAuthorized()` specifically, the
 * canonical per-run assignment/panel relationship supplied by the caller.
 *
 * No Workspace->legacy fallback of any kind is reachable from this module —
 * it has no import of `lib/teams/`, `isTeamAdmin`, `loadUserAndTeam`, the
 * `teamRuns` projection, or the Personal reviewer relationship
 * (`personalReviewerAssignment.ts`).
 */

import { roleHasCapability, type WorkspaceCapability } from "./capabilities";
import type { WorkspaceMembershipRole } from "./membershipTypes";

export interface WorkspaceReviewCandidate {
  uid: string;
  workspaceId: string;
  role: WorkspaceMembershipRole;
  status: "active" | "removed";
}

const REQUIRED_ORDINARY_REVIEW_CAPABILITIES: readonly WorkspaceCapability[] = ["research.read", "reviews.submit"];

// ============================================
// Self-review guards — one underlying predicate (UID equality), three
// independently named, independently testable entry points, one per
// call-site context named in the Phase 9A.1 architecture (assignment,
// panel configuration, decision/vote). Owner Override deliberately has NO
// guard here — it is authorized separately via `reviews.override` and is
// out of scope for Phase 9B.1 (no override mutation is implemented here).
// ============================================

/** Would assigning `candidateUid` as the ordinary single reviewer violate the self-review policy? */
export function violatesAssignmentSelfReviewGuard(candidateUid: string, creatorUid: string): boolean {
  return candidateUid === creatorUid;
}

/** Would including `creatorUid` anywhere in a panel's reviewer-uid list violate the self-review policy? */
export function violatesPanelSelfReviewGuard(panelReviewerUids: readonly string[], creatorUid: string): boolean {
  return panelReviewerUids.includes(creatorUid);
}

/** Would `callerUid` casting an ordinary decision/vote violate the self-review policy — checked independently of (and never trusting) stale/forged assignment data. */
export function violatesDecisionSelfReviewGuard(callerUid: string, creatorUid: string): boolean {
  return callerUid === creatorUid;
}

// ============================================
// Assignment target eligibility (Phase 9A.1 §11) — is `candidate` a valid
// NEW assignment/panel target for this run? Does not check canonical
// assignment (there is none yet by definition).
// ============================================

export type AssignmentTargetIneligibilityReason = "not_found" | "removed" | "cross_workspace" | "insufficient_capability" | "self_review";

export type AssignmentTargetEligibilityResult = { eligible: true } | { eligible: false; reason: AssignmentTargetIneligibilityReason };

export function isValidAssignmentTarget(args: {
  candidate: WorkspaceReviewCandidate | null;
  runWorkspaceId: string;
  creatorUid: string;
}): AssignmentTargetEligibilityResult {
  const { candidate, runWorkspaceId, creatorUid } = args;

  if (!candidate) {
    return { eligible: false, reason: "not_found" };
  }
  if (candidate.status !== "active") {
    return { eligible: false, reason: "removed" };
  }
  if (candidate.workspaceId !== runWorkspaceId) {
    return { eligible: false, reason: "cross_workspace" };
  }
  if (violatesAssignmentSelfReviewGuard(candidate.uid, creatorUid)) {
    return { eligible: false, reason: "self_review" };
  }
  for (const capability of REQUIRED_ORDINARY_REVIEW_CAPABILITIES) {
    if (!roleHasCapability(candidate.role, capability)) {
      return { eligible: false, reason: "insufficient_capability" };
    }
  }
  return { eligible: true };
}

// ============================================
// Ordinary reviewer authorization (Phase 9A.1 §10) — is `reviewer`
// authorized to cast an ordinary review decision/vote RIGHT NOW? Requires
// everything isValidAssignmentTarget() requires, PLUS the canonical
// per-run assignment/panel relationship the caller has already resolved
// (`hasCanonicalAssignment`) — assignment never bypasses capability, and
// capability never bypasses assignment.
// ============================================

export type OrdinaryReviewerAuthorizationDenialReason = AssignmentTargetIneligibilityReason | "not_assigned";

export type OrdinaryReviewerAuthorizationResult = { authorized: true } | { authorized: false; reason: OrdinaryReviewerAuthorizationDenialReason };

export function isOrdinaryReviewerAuthorized(args: {
  reviewer: WorkspaceReviewCandidate | null;
  runWorkspaceId: string;
  creatorUid: string;
  hasCanonicalAssignment: boolean;
}): OrdinaryReviewerAuthorizationResult {
  const targetEligibility = isValidAssignmentTarget({ candidate: args.reviewer, runWorkspaceId: args.runWorkspaceId, creatorUid: args.creatorUid });
  if (!targetEligibility.eligible) {
    return { authorized: false, reason: targetEligibility.reason };
  }
  if (!args.hasCanonicalAssignment) {
    return { authorized: false, reason: "not_assigned" };
  }
  // Independent decision-time self-review re-check — never rely solely on
  // the assignment-time guard above having been correctly applied whenever
  // the assignment was originally created; stale/forged assignment data
  // must never resurrect self-review authority.
  if (violatesDecisionSelfReviewGuard(args.reviewer!.uid, args.creatorUid)) {
    return { authorized: false, reason: "self_review" };
  }
  return { authorized: true };
}
