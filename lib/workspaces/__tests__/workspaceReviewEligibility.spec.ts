/**
 * Workspace Review Authorization Core, Phase 9B.1 —
 * `workspaceReviewEligibility.ts` tests. Pure/zero-I/O — `roleHasCapability()`
 * (the real, unmocked, frozen `lib/workspaces/capabilities.ts` matrix) is
 * exercised directly, never mocked, so these tests prove real composed
 * authorization behavior against the actual deployed capability matrix,
 * not a stand-in.
 */

import {
  isValidAssignmentTarget,
  isOrdinaryReviewerAuthorized,
  violatesAssignmentSelfReviewGuard,
  violatesPanelSelfReviewGuard,
  violatesDecisionSelfReviewGuard,
  type WorkspaceReviewCandidate,
} from "../workspaceReviewEligibility";
import type { WorkspaceMembershipRole } from "../membershipTypes";

const CREATOR_UID = "creator-1";
const WS_ID = "ws-team-1";
const OTHER_WS_ID = "ws-team-2";

function candidate(uid: string, role: WorkspaceMembershipRole, overrides: Partial<WorkspaceReviewCandidate> = {}): WorkspaceReviewCandidate {
  return { uid, workspaceId: WS_ID, role, status: "active", ...overrides };
}

// ============================================
// §14 — Member policy regression test (mandatory: resolves the Phase 9A discrepancy)
// ============================================
describe("Member policy — reviews.submit is eligibility, assignment is still mandatory (Phase 8B.2 frozen matrix)", () => {
  it("Member + active membership + research.read + reviews.submit + canonical assignment + not creator => ordinary reviewer eligibility ALLOWED", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("member-uid", "member"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: true });
  });

  it("Member with identical capabilities but NOT assigned => review authority DENIED (not_assigned)", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("member-uid", "member"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: false,
    });
    expect(result).toEqual({ authorized: false, reason: "not_assigned" });
  });

  it("Member is a valid ASSIGNMENT TARGET (eligible to be assigned) when active, same workspace, and not creator", () => {
    const result = isValidAssignmentTarget({ candidate: candidate("member-uid", "member"), runWorkspaceId: WS_ID, creatorUid: CREATOR_UID });
    expect(result).toEqual({ eligible: true });
  });
});

// ============================================
// §15 — Viewer test
// ============================================
describe("Viewer — reviews.submit absent, forged assignment must never elevate", () => {
  it("Viewer + hasCanonicalAssignment: true (forged/stale) => still DENIED (insufficient_capability)", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("viewer-uid", "viewer"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "insufficient_capability" });
  });

  it("Viewer is never a valid assignment target", () => {
    const result = isValidAssignmentTarget({ candidate: candidate("viewer-uid", "viewer"), runWorkspaceId: WS_ID, creatorUid: CREATOR_UID });
    expect(result).toEqual({ eligible: false, reason: "insufficient_capability" });
  });
});

// ============================================
// §16 — Removed / role-changed member tests (stale assignment cannot resurrect access)
// ============================================
describe("Removed / role-changed reviewer — authorization uses CURRENT state, never stale assignment", () => {
  it("assigned Member -> membership removed => DENY (removed)", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("member-uid", "member", { status: "removed" }),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "removed" });
  });

  it("assigned Member -> role changed to Viewer => DENY (insufficient_capability)", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("member-uid", "viewer"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "insufficient_capability" });
  });

  it("assigned Reviewer -> membership removed => DENY (removed)", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("reviewer-uid", "reviewer", { status: "removed" }),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "removed" });
  });

  it("assigned Reviewer -> role changed to Viewer => DENY (insufficient_capability)", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("reviewer-uid", "viewer"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "insufficient_capability" });
  });

  it("membership entirely absent (null) despite hasCanonicalAssignment: true => DENY (not_found)", () => {
    const result = isOrdinaryReviewerAuthorized({ reviewer: null, runWorkspaceId: WS_ID, creatorUid: CREATOR_UID, hasCanonicalAssignment: true });
    expect(result).toEqual({ authorized: false, reason: "not_found" });
  });
});

// ============================================
// §17 — Self-review test matrix
// ============================================
describe("Self-review test matrix — every role, ordinary review path, creator always denied", () => {
  const roles: WorkspaceMembershipRole[] = ["owner", "admin", "member", "reviewer"];

  it.each(roles)("creator %s assigned as normal reviewer => DENY (self_review), even with canonical assignment", (role) => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate(CREATOR_UID, role),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "self_review" });
  });

  it.each(roles)("creator %s is never a valid ASSIGNMENT TARGET", (role) => {
    const result = isValidAssignmentTarget({ candidate: candidate(CREATOR_UID, role), runWorkspaceId: WS_ID, creatorUid: CREATOR_UID });
    expect(result).toEqual({ eligible: false, reason: "self_review" });
  });

  it("creator included anywhere in a panel reviewer-uid list => panel self-review guard violated", () => {
    expect(violatesPanelSelfReviewGuard(["reviewer-a", CREATOR_UID, "reviewer-b"], CREATOR_UID)).toBe(true);
  });

  it("creator absent from panel reviewer-uid list => panel self-review guard not violated", () => {
    expect(violatesPanelSelfReviewGuard(["reviewer-a", "reviewer-b"], CREATOR_UID)).toBe(false);
  });

  it("creator attempts ordinary decision despite a forged/stale existing assignment (hasCanonicalAssignment true, reviewer === creator) => DENY", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate(CREATOR_UID, "owner"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result.authorized).toBe(false);
    expect((result as { authorized: false; reason: string }).reason).toBe("self_review");
  });

  it("violatesAssignmentSelfReviewGuard / violatesDecisionSelfReviewGuard are independent, both fire on creator === candidate", () => {
    expect(violatesAssignmentSelfReviewGuard(CREATOR_UID, CREATOR_UID)).toBe(true);
    expect(violatesDecisionSelfReviewGuard(CREATOR_UID, CREATOR_UID)).toBe(true);
    expect(violatesAssignmentSelfReviewGuard("someone-else", CREATOR_UID)).toBe(false);
    expect(violatesDecisionSelfReviewGuard("someone-else", CREATOR_UID)).toBe(false);
  });

  it("Owner Override is out of scope for this module — no export named/shaped like an override guard exists", () => {
    const eligibility = require("../workspaceReviewEligibility");
    const exportedNames = Object.keys(eligibility);
    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toMatch(/override/);
    }
  });
});

// ============================================
// §18 — Cross-workspace tests (IDOR)
// ============================================
describe("Cross-workspace isolation — no fallback regardless of caller's standing elsewhere", () => {
  it("candidate's own membership.workspaceId (B) does not match the run's workspaceId (A) => DENY (cross_workspace), even for an Owner", () => {
    const result = isValidAssignmentTarget({
      candidate: candidate("owner-of-B", "owner", { workspaceId: OTHER_WS_ID }),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
    });
    expect(result).toEqual({ eligible: false, reason: "cross_workspace" });
  });

  it("ordinary-reviewer path: cross-workspace candidate denied even with hasCanonicalAssignment: true (no capability shortcut around workspace boundary)", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("admin-of-B", "admin", { workspaceId: OTHER_WS_ID }),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "cross_workspace" });
  });
});

// ============================================
// §20 — No teamRuns / legacy lookup reachable from this module
// ============================================
describe("workspaceReviewEligibility — no legacy/Firestore access", () => {
  it("module has no import of Firestore, legacy Team, teamRuns, or Personal-reviewer modules", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(process.cwd(), "lib/workspaces/workspaceReviewEligibility.ts"), "utf8");
    const importLines = source.split("\n").filter((line: string) => /^import /.test(line.trim()));
    for (const line of importLines) {
      expect(line).not.toMatch(/firebase-admin|adminDb|lib\/teams\/|isTeamAdmin|loadUserAndTeam|personalReviewerAssignment|teamRuns/);
    }
  });

  it("assignment does not bypass capabilities: active same-workspace non-creator Viewer with hasCanonicalAssignment true is still denied", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("viewer-uid", "viewer"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: true,
    });
    expect(result).toEqual({ authorized: false, reason: "insufficient_capability" });
  });

  it("capabilities do not bypass assignment: active same-workspace non-creator Reviewer with all capabilities but hasCanonicalAssignment false is still denied", () => {
    const result = isOrdinaryReviewerAuthorized({
      reviewer: candidate("reviewer-uid", "reviewer"),
      runWorkspaceId: WS_ID,
      creatorUid: CREATOR_UID,
      hasCanonicalAssignment: false,
    });
    expect(result).toEqual({ authorized: false, reason: "not_assigned" });
  });
});
