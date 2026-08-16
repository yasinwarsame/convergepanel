/**
 * Phase 6D.1 — validateRunWorkspaceBinding() tests. Composes canonical
 * `getWorkspace()` only; this file mocks that one dependency and asserts
 * the composition, never re-testing `getWorkspace()`'s own internals.
 */

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({
  getWorkspace: (...args: any[]) => mockedGetWorkspace(...args),
}));

import { validateRunWorkspaceBinding } from "@/lib/projects/validateRunWorkspaceBinding";

const UID = "uid-1";
const WS_ID = "personal-uid-1";

function validWorkspace(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: WS_ID, type: "personal", ownerUserId: UID, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("validateRunWorkspaceBinding", () => {
  it("valid, correctly-owned, personal Workspace at the canonical id -> true", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace() });
    await expect(validateRunWorkspaceBinding(UID, WS_ID)).resolves.toBe(true);
  });

  it("SECURITY: workspaceId that is not this user's OWN canonical Personal Workspace id -> false, without even reading Firestore", async () => {
    await expect(validateRunWorkspaceBinding(UID, "personal-someone-else")).resolves.toBe(false);
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("Workspace not found -> false", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "not_found" });
    await expect(validateRunWorkspaceBinding(UID, WS_ID)).resolves.toBe(false);
  });

  it("Workspace malformed -> false", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "malformed" });
    await expect(validateRunWorkspaceBinding(UID, WS_ID)).resolves.toBe(false);
  });

  it("Workspace lookup failed -> false (fail closed)", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "read_failed" });
    await expect(validateRunWorkspaceBinding(UID, WS_ID)).resolves.toBe(false);
  });

  it("SECURITY: Workspace owned by a different user -> false", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace({ ownerUserId: "someone-else" }) });
    await expect(validateRunWorkspaceBinding(UID, WS_ID)).resolves.toBe(false);
  });

  it("Workspace type is team, not personal -> false", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace({ type: "team" }) });
    await expect(validateRunWorkspaceBinding(UID, WS_ID)).resolves.toBe(false);
  });

  it("invalid uid (per getPersonalWorkspaceId's own validation) -> false, without reading Firestore", async () => {
    await expect(validateRunWorkspaceBinding("", WS_ID)).resolves.toBe(false);
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });
});
