/**
 * Project/Research Assignment (D2) — the two target rules on ONE fixture:
 * a Viewer is a valid PROJECT assignee but never a RUN assignee. Uses the
 * real capability matrix (no mock) so the run rule is pinned to
 * `roleHasCapability(role, "research.create")`.
 */

import { isEligibleAssignmentTarget, deriveAssigneeState } from "../assignmentTargetEligibility";
import { ROLE_CAPABILITIES } from "../capabilities";
import type { WorkspaceMembershipV1 } from "../membershipTypes";

function membership(role: WorkspaceMembershipV1["role"], status: "active" | "removed" = "active"): WorkspaceMembershipV1 {
  return { schemaVersion: 1, id: `ws-1_${role}`, workspaceId: "ws-1", uid: `${role}-uid`, role, status, createdAt: {} as never, updatedAt: {} as never, invitedByUserId: null, removedAt: null, removedByUserId: null } as unknown as WorkspaceMembershipV1;
}

describe("D2 — Project vs run target rules", () => {
  it("SAME FIXTURE: a Viewer can be a Project assignee but NOT a run assignee", () => {
    const viewer = membership("viewer");
    expect(isEligibleAssignmentTarget("project", viewer)).toBe(true);
    expect(isEligibleAssignmentTarget("run", viewer)).toBe(false);
  });

  it("run rule is exactly `research.create` on the CURRENT role (pinned to the matrix)", () => {
    for (const role of ["owner", "admin", "member", "reviewer", "viewer"] as const) {
      expect(isEligibleAssignmentTarget("run", membership(role))).toBe(ROLE_CAPABILITIES[role].includes("research.create"));
    }
    // Positive + negative control the matrix actually encodes today.
    expect(isEligibleAssignmentTarget("run", membership("member"))).toBe(true);
    expect(isEligibleAssignmentTarget("run", membership("reviewer"))).toBe(false);
  });

  it("a removed / absent / unbound membership is never eligible for either kind", () => {
    expect(isEligibleAssignmentTarget("project", membership("owner", "removed"))).toBe(false);
    expect(isEligibleAssignmentTarget("run", membership("owner", "removed"))).toBe(false);
    expect(isEligibleAssignmentTarget("project", null)).toBe(false);
    expect(isEligibleAssignmentTarget("run", null)).toBe(false);
  });

  it("deriveAssigneeState is the same predicate as presentation", () => {
    expect(deriveAssigneeState("run", membership("viewer"))).toBe("stale");
    expect(deriveAssigneeState("project", membership("viewer"))).toBe("active");
    expect(deriveAssigneeState("project", null)).toBe("stale");
  });
});
