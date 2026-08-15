/**
 * Phase 5B — resolvePersonalWorkspaceForOwner(). Reuses getWorkspace()
 * (Phase 1) verbatim; these tests mock only that dependency plus
 * WORKSPACES_ENABLED, never re-implement Workspace-shape validation.
 */

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({
  getWorkspace: (...args: any[]) => mockedGetWorkspace(...args),
}));

let workspacesEnabled = true;
jest.mock("@/lib/env", () => ({
  get WORKSPACES_ENABLED() {
    return workspacesEnabled;
  },
}));

import { resolvePersonalWorkspaceForOwner } from "@/lib/workspaces/resolvePersonalWorkspaceForOwner";

const UID = "owner-1";
const WS_ID = "personal-owner-1";

function validWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: WS_ID,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: UID,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  workspacesEnabled = true;
});

describe("resolvePersonalWorkspaceForOwner", () => {
  it("W=false -> workspaces_disabled, no getWorkspace call at all", async () => {
    workspacesEnabled = false;
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "workspaces_disabled" });
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("invalid uid -> invalid_uid, no getWorkspace call", async () => {
    const result = await resolvePersonalWorkspaceForOwner("");
    expect(result).toEqual({ status: "invalid_uid" });
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("calls getWorkspace with the deterministic personal-{uid} id, never a caller-influenced value", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "not_found" });
    await resolvePersonalWorkspaceForOwner(UID);
    expect(mockedGetWorkspace).toHaveBeenCalledWith(WS_ID);
  });

  it("not_found -> not_found", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "not_found" });
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "not_found" });
  });

  it("malformed -> malformed", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "malformed" });
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "malformed" });
  });

  it.each(["firestore_unavailable", "read_failed"])("%s -> lookup_failed", async (status) => {
    mockedGetWorkspace.mockResolvedValue({ status });
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("SECURITY: found but ownerUserId !== uid -> wrong_owner, never treated as found", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace({ ownerUserId: "someone-else" }) });
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "wrong_owner" });
  });

  it("found but type !== personal -> wrong_type, never treated as found", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace({ type: "team" }) });
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "wrong_type" });
  });

  it("owner check runs before type check when both fail — reports wrong_owner", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace({ ownerUserId: "someone-else", type: "team" }) });
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "wrong_owner" });
  });

  it("fully valid Personal Workspace -> found, returns the workspace", async () => {
    const ws = validWorkspace();
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: ws });
    const result = await resolvePersonalWorkspaceForOwner(UID);
    expect(result).toEqual({ status: "found", workspace: ws });
  });
});
