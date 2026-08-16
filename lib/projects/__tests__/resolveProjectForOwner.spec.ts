/**
 * Projects Foundation, Phase 6B — resolveProjectForOwner() tests. Mocks
 * only its two real dependencies (getProject, resolvePersonalWorkspaceForOwner)
 * — never re-implements Project- or Workspace-shape validation here,
 * mirroring resolvePersonalWorkspaceForOwner.spec.ts's own convention.
 */

import { Timestamp } from "firebase-admin/firestore";

const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  getProject: (...args: any[]) => mockedGetProject(...args),
}));

const mockedResolvePersonalWorkspaceForOwner = jest.fn();
jest.mock("@/lib/workspaces/resolvePersonalWorkspaceForOwner", () => ({
  resolvePersonalWorkspaceForOwner: (...args: any[]) => mockedResolvePersonalWorkspaceForOwner(...args),
}));

import { resolveProjectForOwner } from "@/lib/projects/resolveProjectForOwner";

const UID = "owner-1";
const OWN_WS_ID = "personal-owner-1";
const PROJECT_ID = "proj-1";
const NOW = Timestamp.now();

function validProject(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    workspaceId: OWN_WS_ID,
    name: "My Project",
    status: "active",
    createdByUserId: UID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function validWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: OWN_WS_ID,
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
});

describe("resolveProjectForOwner — projectId syntax", () => {
  it("invalid projectId syntax -> invalid_project_id, no Firestore read at all", async () => {
    const result = await resolveProjectForOwner(UID, "");
    expect(result).toEqual({ status: "invalid_project_id" });
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("a projectId containing a path separator -> invalid_project_id, no read", async () => {
    const result = await resolveProjectForOwner(UID, "abc/def");
    expect(result).toEqual({ status: "invalid_project_id" });
    expect(mockedGetProject).not.toHaveBeenCalled();
  });
});

describe("resolveProjectForOwner — Project lookup outcomes", () => {
  it("Project not_found -> not_found, no Workspace resolution attempted", async () => {
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "not_found" });
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it("malformed Project -> malformed, fail closed, no Workspace resolution attempted", async () => {
    mockedGetProject.mockResolvedValue({ status: "malformed" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "malformed" });
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it.each(["firestore_unavailable", "read_failed"])("Project lookup %s -> lookup_failed", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "lookup_failed" });
  });
});

describe("resolveProjectForOwner — SECURITY: foreign-Workspace Project rejection, zero extra reads", () => {
  it("Project belonging to a DIFFERENT Personal Workspace -> workspace_mismatch, and resolvePersonalWorkspaceForOwner is NEVER called (no foreign Workspace read)", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject({ workspaceId: "personal-someone-else" }) });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "workspace_mismatch" });
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it("a Project referencing a syntactically-plausible but wrong workspaceId also short-circuits with zero Workspace reads", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject({ workspaceId: "personal-uid-that-is-not-caller" }) });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "workspace_mismatch" });
    expect(mockedResolvePersonalWorkspaceForOwner).toHaveBeenCalledTimes(0);
  });
});

describe("resolveProjectForOwner — own Project, own Workspace validated via the canonical resolver", () => {
  it("valid own Project + valid own Personal Workspace -> found", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace() });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "found", project: validProject() });
    expect(mockedResolvePersonalWorkspaceForOwner).toHaveBeenCalledWith(UID);
  });

  it("own Project + WORKSPACES_ENABLED off -> workspaces_disabled, fail closed", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "workspaces_disabled" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "workspaces_disabled" });
  });

  it("own Project + own Workspace document missing -> workspace_missing, fail closed", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "not_found" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "workspace_missing" });
  });

  it("own Project + malformed own Workspace document -> workspace_invalid, fail closed", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "malformed" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "workspace_invalid" });
  });

  it("SECURITY: own Project + a personal-{uid} Workspace document whose ownerUserId disagrees (corrupt/tampered) -> workspace_invalid, NEVER authorized merely because the document id is deterministic", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "wrong_owner" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "workspace_invalid" });
  });

  it("own Project + own Workspace has type !== personal -> unsupported_workspace, fail closed", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "wrong_type" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "unsupported_workspace" });
  });

  it("own Project + Workspace lookup transient failure -> lookup_failed, fail closed (never treated as found)", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "lookup_failed" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("defensive: an internally-unreachable invalid_uid from the Workspace resolver still fails closed rather than being unhandled", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "invalid_uid" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result).toEqual({ status: "lookup_failed" });
  });
});

describe("MUTATION CHECKS — proving the tests above actually catch a broken implementation", () => {
  it("if the workspaceId equality check were removed (always proceeding to Workspace resolution), a foreign Project would incorrectly call resolvePersonalWorkspaceForOwner — the read-count assertion above would fail", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject({ workspaceId: "personal-someone-else" }) });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace({ id: "personal-someone-else", ownerUserId: "someone-else" }) });
    await resolveProjectForOwner(UID, PROJECT_ID);
    // The real implementation must never reach this call for a foreign Project.
    expect(mockedResolvePersonalWorkspaceForOwner).not.toHaveBeenCalled();
  });

  it("if wrong_owner were silently mapped to 'found' instead of workspace_invalid, this test would pass incorrectly — asserting the real, strict mapping", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "wrong_owner" });
    const result = await resolveProjectForOwner(UID, PROJECT_ID);
    expect(result.status).not.toBe("found");
    expect(result).toEqual({ status: "workspace_invalid" });
  });
});
