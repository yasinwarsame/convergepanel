/**
 * Team Member Management, Phase 12A — canManageMembershipTargetRole() tests.
 * Pure, zero-I/O — every branch of the frozen Owner/Admin removal-target
 * matrix, plus the structural exclusion of "owner" as a target role for
 * every caller.
 */

import { canManageMembershipTargetRole } from "@/lib/workspaces/membershipTargetAuthority";
import type { WorkspaceMembershipRole } from "@/lib/workspaces/membershipTypes";

describe("canManageMembershipTargetRole — Owner caller", () => {
  it.each<[WorkspaceMembershipRole, boolean]>([
    ["admin", true],
    ["member", true],
    ["reviewer", true],
    ["viewer", true],
    ["owner", false],
  ])("owner -> %s : %s", (targetRole, expected) => {
    expect(canManageMembershipTargetRole({ callerRole: "owner", targetRole })).toBe(expected);
  });
});

describe("canManageMembershipTargetRole — Admin caller", () => {
  it.each<[WorkspaceMembershipRole, boolean]>([
    ["admin", false],
    ["member", true],
    ["reviewer", true],
    ["viewer", true],
    ["owner", false],
  ])("admin -> %s : %s", (targetRole, expected) => {
    expect(canManageMembershipTargetRole({ callerRole: "admin", targetRole })).toBe(expected);
  });
});

describe("canManageMembershipTargetRole — lower-role callers always deny", () => {
  const lowerCallers: WorkspaceMembershipRole[] = ["member", "reviewer", "viewer"];
  const allTargets: WorkspaceMembershipRole[] = ["owner", "admin", "member", "reviewer", "viewer"];
  for (const callerRole of lowerCallers) {
    for (const targetRole of allTargets) {
      it(`${callerRole} -> ${targetRole} : false`, () => {
        expect(canManageMembershipTargetRole({ callerRole, targetRole })).toBe(false);
      });
    }
  }
});

describe("canManageMembershipTargetRole — owner target is structurally excluded regardless of who is asking", () => {
  it("targetRole: owner is always false, for every caller role, even Owner itself", () => {
    const allCallers: WorkspaceMembershipRole[] = ["owner", "admin", "member", "reviewer", "viewer"];
    for (const callerRole of allCallers) {
      expect(canManageMembershipTargetRole({ callerRole, targetRole: "owner" })).toBe(false);
    }
  });
});
