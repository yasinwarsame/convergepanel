/**
 * Team Member Management, Phase 12B — canAssignMembershipDestinationRole()
 * tests. Pure, zero-I/O — every branch of the frozen Owner/Admin
 * destination-role matrix, plus the structural exclusion of "owner" as a
 * destination for every caller.
 */

import { canAssignMembershipDestinationRole } from "@/lib/workspaces/membershipRoleAuthority";
import type { WorkspaceMembershipRole } from "@/lib/workspaces/membershipTypes";

describe("canAssignMembershipDestinationRole — Owner caller", () => {
  it.each<[WorkspaceMembershipRole, boolean]>([
    ["admin", true],
    ["member", true],
    ["reviewer", true],
    ["viewer", true],
    ["owner", false],
  ])("owner -> %s : %s", (destinationRole, expected) => {
    expect(canAssignMembershipDestinationRole({ callerRole: "owner", destinationRole })).toBe(expected);
  });
});

describe("canAssignMembershipDestinationRole — Admin caller", () => {
  it.each<[WorkspaceMembershipRole, boolean]>([
    ["admin", false],
    ["member", true],
    ["reviewer", true],
    ["viewer", true],
    ["owner", false],
  ])("admin -> %s : %s", (destinationRole, expected) => {
    expect(canAssignMembershipDestinationRole({ callerRole: "admin", destinationRole })).toBe(expected);
  });
});

describe("canAssignMembershipDestinationRole — lower-role callers always deny", () => {
  const lowerCallers: WorkspaceMembershipRole[] = ["member", "reviewer", "viewer"];
  const allDestinations: WorkspaceMembershipRole[] = ["owner", "admin", "member", "reviewer", "viewer"];
  for (const callerRole of lowerCallers) {
    for (const destinationRole of allDestinations) {
      it(`${callerRole} -> ${destinationRole} : false`, () => {
        expect(canAssignMembershipDestinationRole({ callerRole, destinationRole })).toBe(false);
      });
    }
  }
});

describe("canAssignMembershipDestinationRole — owner destination is structurally excluded regardless of who is asking", () => {
  it("destinationRole: owner is always false, for every caller role, even Owner itself", () => {
    const allCallers: WorkspaceMembershipRole[] = ["owner", "admin", "member", "reviewer", "viewer"];
    for (const callerRole of allCallers) {
      expect(canAssignMembershipDestinationRole({ callerRole, destinationRole: "owner" })).toBe(false);
    }
  });
});
