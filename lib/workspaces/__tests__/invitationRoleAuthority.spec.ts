import { canManageInvitationTargetRole } from "../invitationRoleAuthority";
import type { WorkspaceMembershipRole } from "../membershipTypes";

const ALL_TARGET_ROLES: WorkspaceMembershipRole[] = ["owner", "admin", "member", "reviewer", "viewer"];

describe("canManageInvitationTargetRole", () => {
  it("Owner caller may manage admin/member/reviewer/viewer", () => {
    for (const targetRole of ["admin", "member", "reviewer", "viewer"] as WorkspaceMembershipRole[]) {
      expect(canManageInvitationTargetRole({ callerRole: "owner", targetRole })).toBe(true);
    }
  });

  it("Admin caller may manage member/reviewer/viewer", () => {
    for (const targetRole of ["member", "reviewer", "viewer"] as WorkspaceMembershipRole[]) {
      expect(canManageInvitationTargetRole({ callerRole: "admin", targetRole })).toBe(true);
    }
  });

  it("Admin/Admin -> false", () => {
    expect(canManageInvitationTargetRole({ callerRole: "admin", targetRole: "admin" })).toBe(false);
  });

  it("Member caller may never manage any target role", () => {
    for (const targetRole of ALL_TARGET_ROLES) {
      expect(canManageInvitationTargetRole({ callerRole: "member", targetRole })).toBe(false);
    }
  });

  it("Reviewer caller may never manage any target role", () => {
    for (const targetRole of ALL_TARGET_ROLES) {
      expect(canManageInvitationTargetRole({ callerRole: "reviewer", targetRole })).toBe(false);
    }
  });

  it("Viewer caller may never manage any target role", () => {
    for (const targetRole of ALL_TARGET_ROLES) {
      expect(canManageInvitationTargetRole({ callerRole: "viewer", targetRole })).toBe(false);
    }
  });

  it("no caller role may ever manage an owner-target — including Owner itself", () => {
    for (const callerRole of ALL_TARGET_ROLES) {
      expect(canManageInvitationTargetRole({ callerRole, targetRole: "owner" })).toBe(false);
    }
  });

  it("full caller-role x target-role matrix (explicit truth table)", () => {
    const expected: Record<WorkspaceMembershipRole, Record<WorkspaceMembershipRole, boolean>> = {
      owner: { owner: false, admin: true, member: true, reviewer: true, viewer: true },
      admin: { owner: false, admin: false, member: true, reviewer: true, viewer: true },
      member: { owner: false, admin: false, member: false, reviewer: false, viewer: false },
      reviewer: { owner: false, admin: false, member: false, reviewer: false, viewer: false },
      viewer: { owner: false, admin: false, member: false, reviewer: false, viewer: false },
    };
    for (const callerRole of ALL_TARGET_ROLES) {
      for (const targetRole of ALL_TARGET_ROLES) {
        expect(canManageInvitationTargetRole({ callerRole, targetRole })).toBe(expected[callerRole][targetRole]);
      }
    }
  });
});
