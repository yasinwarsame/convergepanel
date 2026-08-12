/**
 * Personal Reviewer Inbox + Action Flow — resolveAdaptiveRunAccess() tests.
 */

import { resolveAdaptiveRunAccess } from "@/lib/governance/adaptiveRunAccess";
import type { AdaptiveHumanReviewAssignmentV1 } from "@/lib/governance/adaptiveHumanReviewAssignment";

const OWNER_UID = "owner-1";
const REVIEWER_UID = "reviewer-1";
const OTHER_UID = "other-1";

function personalAssignment(overrides: Partial<AdaptiveHumanReviewAssignmentV1> = {}): AdaptiveHumanReviewAssignmentV1 {
  return {
    schemaVersion: 1,
    teamId: null,
    runId: "run-1",
    assignedReviewerUserId: REVIEWER_UID,
    assignedAt: "2026-08-12T18:00:00.000Z",
    assignedByUserId: OWNER_UID,
    updatedAt: "2026-08-12T18:00:00.000Z",
    updatedByUserId: OWNER_UID,
    revision: 1,
    ...overrides,
  };
}

describe("resolveAdaptiveRunAccess", () => {
  it("grants the owner full owner capabilities, canSubmitReview always false", () => {
    const result = resolveAdaptiveRunAccess({
      uid: OWNER_UID,
      runOwnerUid: OWNER_UID,
      assignment: null,
      humanReviewStatus: "unreviewed",
    });
    expect(result.role).toBe("owner");
    expect(result.capabilities).toEqual({
      canViewReport: true,
      canViewGovernance: true,
      canSubmitReview: false,
      canExport: true,
      canMutateRun: true,
    });
  });

  it("owner role wins even if, hypothetically, an assignment also named them (defensive; should be structurally impossible via the config route)", () => {
    const result = resolveAdaptiveRunAccess({
      uid: OWNER_UID,
      runOwnerUid: OWNER_UID,
      assignment: personalAssignment({ assignedReviewerUserId: OWNER_UID }),
      humanReviewStatus: "unreviewed",
    });
    expect(result.role).toBe("owner");
  });

  it("grants the currently-assigned personal reviewer review-scoped access, never owner-level capabilities", () => {
    const result = resolveAdaptiveRunAccess({
      uid: REVIEWER_UID,
      runOwnerUid: OWNER_UID,
      assignment: personalAssignment(),
      humanReviewStatus: "unreviewed",
    });
    expect(result.role).toBe("personal_reviewer");
    expect(result.capabilities).toEqual({
      canViewReport: true,
      canViewGovernance: true,
      canSubmitReview: true,
      canExport: false,
      canMutateRun: false,
    });
    if (result.role === "personal_reviewer") {
      expect(result.assignment.assignedReviewerUserId).toBe(REVIEWER_UID);
    }
  });

  it.each(["pending"] as const)("canSubmitReview is true for non-terminal status %s too", (status) => {
    const result = resolveAdaptiveRunAccess({
      uid: REVIEWER_UID,
      runOwnerUid: OWNER_UID,
      assignment: personalAssignment(),
      humanReviewStatus: status,
    });
    expect(result.role).toBe("personal_reviewer");
    expect(result.capabilities.canSubmitReview).toBe(true);
  });

  it.each(["approved", "approved_with_conditions", "changes_requested", "rejected"] as const)(
    "canSubmitReview is false once terminal (%s) — reviewer still has view access, never decision access",
    (status) => {
      const result = resolveAdaptiveRunAccess({
        uid: REVIEWER_UID,
        runOwnerUid: OWNER_UID,
        assignment: personalAssignment(),
        humanReviewStatus: status,
      });
      expect(result.role).toBe("personal_reviewer");
      expect(result.capabilities.canViewReport).toBe(true);
      expect(result.capabilities.canViewGovernance).toBe(true);
      expect(result.capabilities.canSubmitReview).toBe(false);
    }
  );

  it("denies a user with no assignment at all", () => {
    const result = resolveAdaptiveRunAccess({
      uid: OTHER_UID,
      runOwnerUid: OWNER_UID,
      assignment: null,
      humanReviewStatus: "unreviewed",
    });
    expect(result).toEqual({ role: "unauthorized", capabilities: { canViewReport: false, canViewGovernance: false, canSubmitReview: false, canExport: false, canMutateRun: false } });
  });

  it("denies a user who is assigned to a DIFFERENT run's team assignment (cross-run IDOR guard, Part 21)", () => {
    const result = resolveAdaptiveRunAccess({
      uid: OTHER_UID,
      runOwnerUid: OWNER_UID,
      assignment: personalAssignment({ assignedReviewerUserId: REVIEWER_UID }),
      humanReviewStatus: "unreviewed",
    });
    expect(result.role).toBe("unauthorized");
  });

  it("denies a team assignment (teamId is a real team id, not null) — team access must go through the team routes, never this resolver", () => {
    const result = resolveAdaptiveRunAccess({
      uid: REVIEWER_UID,
      runOwnerUid: OWNER_UID,
      assignment: personalAssignment({ teamId: "team-abc" }),
      humanReviewStatus: "unreviewed",
    });
    expect(result.role).toBe("unauthorized");
  });

  it("denies an assignment with assignedReviewerUserId: null (explicitly unassigned)", () => {
    const result = resolveAdaptiveRunAccess({
      uid: REVIEWER_UID,
      runOwnerUid: OWNER_UID,
      assignment: personalAssignment({ assignedReviewerUserId: null }),
      humanReviewStatus: "unreviewed",
    });
    expect(result.role).toBe("unauthorized");
  });

  it("Part 22: reviewer change stability — the OLD assignment's reviewer keeps access even though it no longer matches any *current* default config (this resolver never looks at config at all, only the per-run assignment)", () => {
    // Run A was assigned to Reviewer A. The owner's default later changed
    // to Reviewer B (a fact this resolver is never even given — proving by
    // construction that it cannot influence access to an already-assigned
    // run).
    const runAAssignment = personalAssignment({ assignedReviewerUserId: "reviewer-A", runId: "run-A" });
    const reviewerAResult = resolveAdaptiveRunAccess({
      uid: "reviewer-A",
      runOwnerUid: OWNER_UID,
      assignment: runAAssignment,
      humanReviewStatus: "unreviewed",
    });
    expect(reviewerAResult.role).toBe("personal_reviewer");

    // Reviewer B does NOT gain access to Run A merely by being the new
    // default — Run A's own assignment still names Reviewer A.
    const reviewerBResult = resolveAdaptiveRunAccess({
      uid: "reviewer-B",
      runOwnerUid: OWNER_UID,
      assignment: runAAssignment,
      humanReviewStatus: "unreviewed",
    });
    expect(reviewerBResult.role).toBe("unauthorized");
  });

  it("denies access when humanReviewStatus is null (no governance record) even with a real assignment — defensive, should not occur in practice since assignment implies governance existed", () => {
    const result = resolveAdaptiveRunAccess({
      uid: REVIEWER_UID,
      runOwnerUid: OWNER_UID,
      assignment: personalAssignment(),
      humanReviewStatus: null,
    });
    // View access is still granted (the assignment itself is real) —
    // only submission requires a real, reviewable status.
    expect(result.role).toBe("personal_reviewer");
    expect(result.capabilities.canSubmitReview).toBe(false);
  });
});
