/**
 * Team Workspace Core Foundation, Phase 8B — `resolveWorkspaceAccess()`
 * tests. Mocks `getWorkspace()`/`getWorkspaceMembershipForBinding()`
 * directly (both already independently tested) rather than a Firestore
 * fake, since this module's own logic is pure composition + the Owner
 * invariant check over their results.
 */

let teamWorkspacesEnabled = true;
jest.mock("@/lib/env", () => ({
  get TEAM_WORKSPACES_ENABLED() {
    return teamWorkspacesEnabled;
  },
}));

const mockGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({
  getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args),
}));

const mockGetWorkspaceMembershipForBinding = jest.fn();
jest.mock("@/lib/firestore/workspaceMemberships", () => ({
  getWorkspaceMembershipForBinding: (...args: unknown[]) => mockGetWorkspaceMembershipForBinding(...args),
}));

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("@/lib/logger", () => ({ logger: mockLogger }));

import { Timestamp } from "firebase-admin/firestore";
import { resolveWorkspaceAccess } from "@/lib/workspaces/resolveWorkspaceAccess";
import type { PersonalWorkspaceV1, TeamWorkspaceV1 } from "@/lib/workspaces/types";
import type { WorkspaceMembershipV1, WorkspaceMembershipRole } from "@/lib/workspaces/membershipTypes";

const NOW = Timestamp.now();
const UID = "uid-1";
const WS_ID = "ws-team-1";

function personalWorkspace(overrides: Partial<PersonalWorkspaceV1> = {}): PersonalWorkspaceV1 {
  return { schemaVersion: 1, id: "ws-personal-1", type: "personal", name: "Personal", ownerUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function teamWorkspace(overrides: Partial<TeamWorkspaceV1> = {}): TeamWorkspaceV1 {
  return { schemaVersion: 1, id: WS_ID, type: "team", name: "Team", ownerUserId: UID, createdByUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function membership(role: WorkspaceMembershipRole, overrides: Partial<WorkspaceMembershipV1> = {}): WorkspaceMembershipV1 {
  return {
    schemaVersion: 1,
    id: "wm_x",
    workspaceId: WS_ID,
    uid: UID,
    role,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    invitedByUserId: null,
    removedAt: null,
    removedByUserId: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  teamWorkspacesEnabled = true;
});

describe("Personal Workspace path", () => {
  it("grants access to the owner, no membership lookup performed", async () => {
    mockGetWorkspace.mockResolvedValue({ status: "found", workspace: personalWorkspace() });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: "ws-personal-1" });
    expect(result.granted).toBe(true);
    if (result.granted && result.workspaceType === "personal") {
      expect(result.workspace.ownerUserId).toBe(UID);
    }
    expect(mockGetWorkspaceMembershipForBinding).not.toHaveBeenCalled();
  });

  it("denies a non-owner", async () => {
    mockGetWorkspace.mockResolvedValue({ status: "found", workspace: personalWorkspace({ ownerUserId: "someone-else" }) });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: "ws-personal-1" });
    expect(result).toEqual({ granted: false, reason: "not_owner" });
  });
});

describe("workspace lookup failures", () => {
  it.each([
    ["not_found", "workspace_not_found"],
    ["malformed", "workspace_malformed"],
    ["firestore_unavailable", "lookup_failed"],
    ["read_failed", "lookup_failed"],
  ])("%s -> %s", async (lookupStatus, expectedReason) => {
    mockGetWorkspace.mockResolvedValue({ status: lookupStatus });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: expectedReason });
  });
});

describe("Team Workspace path", () => {
  beforeEach(() => {
    mockGetWorkspace.mockResolvedValue({ status: "found", workspace: teamWorkspace() });
  });

  it("denies outright when TEAM_WORKSPACES_ENABLED is off, even for a legitimate active membership", async () => {
    teamWorkspacesEnabled = false;
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({ status: "found", membership: membership("owner") });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "team_workspaces_disabled" });
    expect(mockGetWorkspaceMembershipForBinding).not.toHaveBeenCalled();
  });

  it.each<WorkspaceMembershipRole>(["admin", "member", "reviewer", "viewer"])("resolves a valid active %s membership with its role's capability set", async (role) => {
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({ status: "found", membership: membership(role) });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result.granted).toBe(true);
    if (result.granted && result.workspaceType === "team") {
      expect(result.membership.role).toBe(role);
      expect(result.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("resolves the canonical Owner successfully", async () => {
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({ status: "found", membership: membership("owner") });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result.granted).toBe(true);
    if (result.granted && result.workspaceType === "team") {
      expect(result.membership.role).toBe("owner");
      expect(result.capabilities).toContain("ownership.transfer");
    }
  });

  it("denies the ENTIRE access for a stray owner-role row whose uid doesn't match workspace.ownerUserId (integrity violation), never falling back to a lower role", async () => {
    // workspace.ownerUserId is UID, but this membership row (also uid=UID
    // per how it's fetched, but with an internally inconsistent
    // workspace) simulates the integrity-violation shape: role "owner"
    // while the workspace's true owner is someone else.
    mockGetWorkspace.mockResolvedValue({ status: "found", workspace: teamWorkspace({ ownerUserId: "different-owner-uid" }) });
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({ status: "found", membership: membership("owner", { uid: UID }) });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "owner_integrity_violation" });
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("denies a removed membership", async () => {
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({
      status: "found",
      membership: membership("member", { status: "removed", removedAt: NOW, removedByUserId: "admin-1" }),
    });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "membership_removed" });
  });

  it("denies a missing membership", async () => {
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({ status: "not_found" });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "membership_not_found" });
  });

  it("denies a malformed membership", async () => {
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({ status: "malformed" });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "membership_malformed" });
  });

  it("maps a membership lookup infrastructure failure to lookup_failed", async () => {
    mockGetWorkspaceMembershipForBinding.mockResolvedValue({ status: "read_failed" });
    const result = await resolveWorkspaceAccess({ uid: UID, workspaceId: WS_ID });
    expect(result).toEqual({ granted: false, reason: "lookup_failed" });
  });
});
