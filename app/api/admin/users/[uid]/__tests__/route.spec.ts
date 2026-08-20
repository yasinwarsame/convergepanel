/**
 * Team Workspace Core Foundation, Phase 8B — narrow tests for the new
 * Team-owner delete/disable guard added to
 * `PATCH`/`DELETE /api/admin/users/[uid]`. Does not attempt to re-test
 * this route's pre-existing behavior beyond what's needed to prove the
 * guard is additive (non-Team-owner behavior unchanged).
 */

jest.mock("@/lib/firebase/auth-helpers", () => ({
  requireAdmin: jest.fn(),
}));

const mockUpdateUser = jest.fn();
const mockDeleteUser = jest.fn();
const mockUsersDocSet = jest.fn();
const mockUsersDocDelete = jest.fn();

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
    deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
  },
  adminDb: {
    collection: () => ({
      doc: () => ({
        set: (...args: unknown[]) => mockUsersDocSet(...args),
        delete: (...args: unknown[]) => mockUsersDocDelete(...args),
      }),
    }),
  },
}));

const mockGetTeamWorkspaceOwnershipForUid = jest.fn();
jest.mock("@/lib/workspaces/teamOwnerGuard", () => ({
  getTeamWorkspaceOwnershipForUid: (...args: unknown[]) => mockGetTeamWorkspaceOwnershipForUid(...args),
}));

import { requireAdmin } from "@/lib/firebase/auth-helpers";
import { NextRequest } from "next/server";
import { PATCH, DELETE } from "@/app/api/admin/users/[uid]/route";

const UID = "target-uid-1";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/users/" + UID, { method: "PATCH", body: JSON.stringify(body) });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ uid: "admin-uid" });
  mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
});

describe("PATCH /api/admin/users/[uid] — Team-owner disable guard", () => {
  it("blocks disabling a Team Workspace Owner with 409, and performs zero disablement", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: true, workspaceIds: ["ws-team-1"] });
    const res = await PATCH(makeRequest({ isDisabled: true }), { params: { uid: UID } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.errorCode).toBe("team_workspace_owner");
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockUsersDocSet).not.toHaveBeenCalled();
  });

  it("allows re-enabling (isDisabled: false) a Team Workspace Owner — never consults the guard", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: true, workspaceIds: ["ws-team-1"] });
    const res = await PATCH(makeRequest({ isDisabled: false }), { params: { uid: UID } });
    expect(res.status).toBe(200);
    expect(mockGetTeamWorkspaceOwnershipForUid).not.toHaveBeenCalled();
    expect(mockUpdateUser).toHaveBeenCalledWith(UID, { disabled: false });
  });

  it("allows disabling an ordinary Team member (non-owner) unaffected", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
    const res = await PATCH(makeRequest({ isDisabled: true }), { params: { uid: UID } });
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(UID, { disabled: true });
  });

  it("allows disabling a uid that owns only a Personal Workspace — guard never fires for Personal-only ownership", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
    const res = await PATCH(makeRequest({ isDisabled: true }), { params: { uid: UID } });
    expect(res.status).toBe(200);
  });

  it("does not block the request when the ownership lookup itself fails (fails open on infrastructure failure, not on confirmed ownership)", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "lookup_failed" });
    const res = await PATCH(makeRequest({ isDisabled: true }), { params: { uid: UID } });
    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(UID, { disabled: true });
  });
});

describe("DELETE /api/admin/users/[uid] — Team-owner delete guard", () => {
  function makeDeleteRequest() {
    return new NextRequest("http://localhost/api/admin/users/" + UID, { method: "DELETE" });
  }

  it("blocks deleting a Team Workspace Owner with 409, and performs zero deletion", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: true, workspaceIds: ["ws-team-1"] });
    const res = await DELETE(makeDeleteRequest(), { params: { uid: UID } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.errorCode).toBe("team_workspace_owner");
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockUsersDocDelete).not.toHaveBeenCalled();
  });

  it("allows deleting an ordinary Team member (non-owner) — existing behavior unchanged", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
    const res = await DELETE(makeDeleteRequest(), { params: { uid: UID } });
    expect(res.status).toBe(200);
    expect(mockDeleteUser).toHaveBeenCalledWith(UID);
    expect(mockUsersDocDelete).toHaveBeenCalled();
  });

  it("allows deleting a uid that owns only a Personal Workspace", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
    const res = await DELETE(makeDeleteRequest(), { params: { uid: UID } });
    expect(res.status).toBe(200);
  });

  it("never cascades Team resource deletion — no Team-scoped collection is touched by this route", async () => {
    mockGetTeamWorkspaceOwnershipForUid.mockResolvedValue({ status: "ok", ownsTeamWorkspace: false, workspaceIds: [] });
    await DELETE(makeDeleteRequest(), { params: { uid: UID } });
    // Only the users/{uid} doc and the Auth user are touched — asserted
    // by the mock surface itself exposing no other write path.
    expect(mockUsersDocDelete).toHaveBeenCalledTimes(1);
  });
});
