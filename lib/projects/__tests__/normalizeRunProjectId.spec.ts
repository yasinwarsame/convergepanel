/**
 * Phase 6D.3A — normalizeRunProjectId() tests. This is the one
 * write-capable function in the whole normalization feature area.
 */

const mockedGet = jest.fn();
const mockedUpdate = jest.fn();
const mockedDoc = jest.fn(() => ({ get: mockedGet, update: mockedUpdate }));
const mockedCollection = jest.fn(() => ({ doc: mockedDoc }));

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: { collection: (...args: any[]) => mockedCollection(...args) },
}));

const mockedValidateWorkspaceBinding = jest.fn();
jest.mock("@/lib/projects/validateRunWorkspaceBinding", () => ({
  validateRunWorkspaceBinding: (...args: any[]) => mockedValidateWorkspaceBinding(...args),
}));

import { normalizeRunProjectId } from "@/lib/projects/normalizeRunProjectId";
import { Status } from "google-gax";

const UPDATE_TIME = { seconds: 1700000000, nanoseconds: 0 };

function snapshotFor(data: Record<string, unknown> | undefined, exists = true) {
  return { exists, data: () => data, updateTime: UPDATE_TIME };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedValidateWorkspaceBinding.mockResolvedValue(true);
});

describe("normalizeRunProjectId", () => {
  it("valid bound-valid run with projectId absent -> normalized, exact { projectId: null } payload with native precondition", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1", workspaceId: "personal-uid-1" }));
    mockedUpdate.mockResolvedValue({ writeTime: UPDATE_TIME });

    const result = await normalizeRunProjectId("run-1");

    expect(result.status).toBe("normalized");
    expect(mockedCollection).toHaveBeenCalledWith("runs");
    expect(mockedDoc).toHaveBeenCalledWith("run-1");
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    const [payload, precondition] = mockedUpdate.mock.calls[0];
    expect(payload).toEqual({ projectId: null });
    expect(Object.keys(payload)).toEqual(["projectId"]); // exactly one field, nothing else
    expect(precondition).toEqual({ lastUpdateTime: UPDATE_TIME });
  });

  it("run not found -> not_found, no write attempted", async () => {
    mockedGet.mockResolvedValue(snapshotFor(undefined, false));
    const result = await normalizeRunProjectId("run-missing");
    expect(result.status).toBe("not_found");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("projectId already null -> skipped_not_absent, no write attempted (idempotent)", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1", workspaceId: "personal-uid-1", projectId: null }));
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("skipped_not_absent");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("SECURITY: projectId already assigned -> skipped_not_absent, never overwritten", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1", workspaceId: "personal-uid-1", projectId: "proj-real" }));
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("skipped_not_absent");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("malformed projectId -> skipped_not_absent, never coerced to null", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1", workspaceId: "personal-uid-1", projectId: 42 }));
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("skipped_not_absent");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("legacy run (no workspaceId) -> invalid_workspace_binding, no write attempted", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1" }));
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("invalid_workspace_binding");
    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(mockedValidateWorkspaceBinding).not.toHaveBeenCalled(); // never even attempted for a legacy run
  });

  it("SECURITY: Workspace binding fails fresh revalidation -> invalid_workspace_binding, never written even if projectId is absent", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1", workspaceId: "personal-uid-1" }));
    mockedValidateWorkspaceBinding.mockResolvedValue(false);
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("invalid_workspace_binding");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("Firestore precondition failure at write time -> precondition_failed (conflict), no retry", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1", workspaceId: "personal-uid-1" }));
    const err: any = new Error("FAILED_PRECONDITION");
    err.code = Status.FAILED_PRECONDITION;
    mockedUpdate.mockRejectedValue(err);
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("precondition_failed");
    expect(mockedUpdate).toHaveBeenCalledTimes(1); // exactly one attempt, no retry
  });

  it("Firestore unavailable -> firestore_unavailable", async () => {
    jest.resetModules();
    jest.doMock("@/lib/firebase/admin", () => ({ adminDb: undefined }));
    jest.doMock("@/lib/projects/validateRunWorkspaceBinding", () => ({ validateRunWorkspaceBinding: mockedValidateWorkspaceBinding }));
    const { normalizeRunProjectId: reloaded } = require("@/lib/projects/normalizeRunProjectId");
    const result = await reloaded("run-1");
    expect(result.status).toBe("firestore_unavailable");
  });

  it("unexpected read failure -> read_failed", async () => {
    mockedGet.mockRejectedValue(new Error("network blip"));
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("read_failed");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("unexpected write failure (not a precondition) -> write_failed", async () => {
    mockedGet.mockResolvedValue(snapshotFor({ userId: "uid-1", workspaceId: "personal-uid-1" }));
    mockedUpdate.mockRejectedValue(new Error("internal"));
    const result = await normalizeRunProjectId("run-1");
    expect(result.status).toBe("write_failed");
  });

  it("uses the FRESH read's updateTime for the precondition, not any externally-supplied value", async () => {
    const freshUpdateTime = { seconds: 1800000000, nanoseconds: 5 };
    mockedGet.mockResolvedValue({ exists: true, data: () => ({ userId: "uid-1", workspaceId: "personal-uid-1" }), updateTime: freshUpdateTime });
    mockedUpdate.mockResolvedValue({ writeTime: freshUpdateTime });
    await normalizeRunProjectId("run-1");
    const [, precondition] = mockedUpdate.mock.calls[0];
    expect(precondition).toEqual({ lastUpdateTime: freshUpdateTime });
  });
});
