/**
 * Project Foundation, Phase 6C — listProjectsForOwner() tests. The
 * central property under test: Phase 6A.2's deliberately STRICTER policy
 * than GET /api/user/workspace/runs — any single malformed/mismatched
 * document returned by the caller-scoped query fails the WHOLE page
 * closed, never silently omits-and-continues.
 */

import { Timestamp } from "firebase-admin/firestore";

const mockedResolvePersonalWorkspaceForOwner = jest.fn();
jest.mock("@/lib/workspaces/resolvePersonalWorkspaceForOwner", () => ({
  resolvePersonalWorkspaceForOwner: (...args: any[]) => mockedResolvePersonalWorkspaceForOwner(...args),
}));

const mockedListActiveProjectsRaw = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  listActiveProjectsRaw: (...args: any[]) => mockedListActiveProjectsRaw(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listProjectsForOwner } from "@/lib/projects/listProjectsForOwner";

const UID = "owner-1";
const WS_ID = "personal-owner-1";
const NOW = Timestamp.now();
const UPDATE_TIME = Timestamp.fromMillis(1_700_000_000_000);

function validProjectDoc(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "proj-1",
    workspaceId: WS_ID,
    name: "My Project",
    status: "active",
    createdByUserId: UID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function validWorkspace() {
  return { id: WS_ID, schemaVersion: 1, type: "personal", name: "Personal Workspace", ownerUserId: UID, createdAt: "x", updatedAt: "x" };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace() });
});

describe("listProjectsForOwner — Workspace prerequisite", () => {
  it("propagates a non-found Workspace resolution outcome without ever calling listActiveProjectsRaw", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "not_found" });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "not_found" });
    expect(mockedListActiveProjectsRaw).not.toHaveBeenCalled();
  });

  it("scopes the raw query to the RESOLVED Workspace id, never a client-supplied one (no such parameter exists)", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(mockedListActiveProjectsRaw).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID }));
  });
});

describe("listProjectsForOwner — cursor", () => {
  it("invalid cursor -> invalid_cursor, no query attempted", async () => {
    const result = await listProjectsForOwner({ uid: UID, limit: 20, cursorRaw: "not a valid cursor!!!" });
    expect(result).toEqual({ status: "invalid_cursor" });
    expect(mockedListActiveProjectsRaw).not.toHaveBeenCalled();
  });

  it("a valid cursor decodes and is passed through as startAfter", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const { encodeProjectsCursor } = require("@/lib/projects/projectsCursor");
    const cursor = encodeProjectsCursor({ createdAtSeconds: 100, createdAtNanoseconds: 0, lastDocId: "proj-x" });
    await listProjectsForOwner({ uid: UID, limit: 20, cursorRaw: cursor });
    expect(mockedListActiveProjectsRaw).toHaveBeenCalledWith(
      expect.objectContaining({ startAfter: { createdAtSeconds: 100, createdAtNanoseconds: 0, lastDocId: "proj-x" } })
    );
  });

  it("produces a nextCursor only when hasMore is true", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "ok", items: [{ data: validProjectDoc(), id: "proj-1", updateTime: UPDATE_TIME }], hasMore: true });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.nextCursor).toBeDefined();
    }
  });

  it("omits nextCursor when hasMore is false", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "ok", items: [{ data: validProjectDoc(), id: "proj-1", updateTime: UPDATE_TIME }], hasMore: false });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.nextCursor).toBeUndefined();
    }
  });
});

describe("listProjectsForOwner — happy path", () => {
  it("returns validated items with their documentUpdateTime attached", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "ok", items: [{ data: validProjectDoc(), id: "proj-1", updateTime: UPDATE_TIME }], hasMore: false });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "ok", items: [{ project: validProjectDoc(), documentUpdateTime: UPDATE_TIME }], hasMore: false });
  });

  it("returns an empty list, not an error, when there are no Projects", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "ok", items: [], hasMore: false });
  });
});

describe("listProjectsForOwner — SECURITY/INTEGRITY: fail the whole page closed, never omit-and-continue", () => {
  it("a malformed document among otherwise-valid ones fails the ENTIRE page, not just that one row", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({
      status: "ok",
      items: [
        { data: validProjectDoc({ id: "proj-1" }), id: "proj-1", updateTime: UPDATE_TIME },
        { data: { schemaVersion: 1 }, id: "proj-2", updateTime: UPDATE_TIME }, // malformed
      ],
      hasMore: false,
    });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("an embedded-id mismatch fails the whole page closed", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({
      status: "ok",
      items: [{ data: validProjectDoc({ id: "proj-impostor" }), id: "proj-real", updateTime: UPDATE_TIME }],
      hasMore: false,
    });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("SECURITY: a workspaceId mismatch (a foreign Project somehow returned by the query) fails the whole page closed — never silently included", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({
      status: "ok",
      items: [{ data: validProjectDoc({ workspaceId: "personal-someone-else" }), id: "proj-1", updateTime: UPDATE_TIME }],
      hasMore: false,
    });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("a non-active status on a document from the active-only query fails the whole page closed", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({
      status: "ok",
      items: [{ data: validProjectDoc({ status: "archived" }), id: "proj-1", updateTime: UPDATE_TIME }],
      hasMore: false,
    });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("MUTATION CHECK: an omit-and-continue implementation would return {status:'ok', items:[validProject]} for the mixed-page case above — proving the strict-fail test actually distinguishes the two policies", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({
      status: "ok",
      items: [
        { data: validProjectDoc({ id: "proj-1" }), id: "proj-1", updateTime: UPDATE_TIME },
        { data: { schemaVersion: 1 }, id: "proj-2", updateTime: UPDATE_TIME },
      ],
      hasMore: false,
    });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    // The omit-and-continue alternative would be `status: "ok"` with one
    // item — the real implementation must NOT produce that.
    expect(result.status).not.toBe("ok");
  });
});

describe("listProjectsForOwner — infrastructure failure", () => {
  it("propagates lookup_failed from the raw query", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "read_failed" });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "lookup_failed" });
  });

  it("propagates lookup_failed when Firestore is unavailable", async () => {
    mockedListActiveProjectsRaw.mockResolvedValue({ status: "firestore_unavailable" });
    const result = await listProjectsForOwner({ uid: UID, limit: 20 });
    expect(result).toEqual({ status: "lookup_failed" });
  });
});
