import { Timestamp } from "firebase-admin/firestore";
import { isCanonicalTeamOwnerMembership } from "@/lib/workspaces/ownerInvariant";
import type { TeamWorkspaceV1 } from "@/lib/workspaces/types";
import type { WorkspaceMembershipV1 } from "@/lib/workspaces/membershipTypes";

const NOW = Timestamp.now();
const WS_ID = "ws-1";
const UID = "uid-1";

function workspace(overrides: Partial<TeamWorkspaceV1> = {}): TeamWorkspaceV1 {
  return { schemaVersion: 1, id: WS_ID, type: "team", name: "Team", ownerUserId: UID, createdByUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function membership(overrides: Partial<WorkspaceMembershipV1> = {}): WorkspaceMembershipV1 {
  return {
    schemaVersion: 1,
    id: "wm_x",
    workspaceId: WS_ID,
    uid: UID,
    role: "owner",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
}

describe("isCanonicalTeamOwnerMembership", () => {
  it("accepts a fully coherent owner row", () => {
    expect(isCanonicalTeamOwnerMembership({ workspace: workspace(), membership: membership() })).toBe(true);
  });

  it("rejects when workspace.ownerUserId disagrees with membership.uid", () => {
    expect(isCanonicalTeamOwnerMembership({ workspace: workspace({ ownerUserId: "someone-else" }), membership: membership() })).toBe(false);
  });

  it("rejects when membership.role is not owner", () => {
    expect(isCanonicalTeamOwnerMembership({ workspace: workspace(), membership: membership({ role: "admin" }) })).toBe(false);
  });

  it("rejects when membership.status is not active", () => {
    expect(isCanonicalTeamOwnerMembership({ workspace: workspace(), membership: membership({ status: "removed", removedAt: NOW, removedByUserId: "x" }) })).toBe(false);
  });

  it("rejects when membership.workspaceId disagrees with workspace.id", () => {
    expect(isCanonicalTeamOwnerMembership({ workspace: workspace(), membership: membership({ workspaceId: "different-ws" }) })).toBe(false);
  });
});
