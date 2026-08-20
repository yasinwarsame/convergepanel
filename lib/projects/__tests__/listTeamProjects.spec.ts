/**
 * Team Project Backend, Phase 8C-A — `listTeamProjects()` tests. Mocks
 * `listActiveProjectsRaw()` directly (already covered by its own existing
 * Personal-suite tests) to isolate this module's own integrity-validation
 * policy and query-predicate boundary (Section 8/32): `workspaceId == W`
 * only, never `userId ==`/`createdByUserId ==`.
 */

import { Timestamp } from "firebase-admin/firestore";

const listActiveProjectsRawMock = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  listActiveProjectsRaw: (...args: unknown[]) => listActiveProjectsRawMock(...args),
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { listTeamProjects } from "../listTeamProjects";
import { encodeProjectsCursor } from "../projectsCursor";

const WS_ID = "ws-team-1";

function ts(seconds: number): Timestamp {
  return new Timestamp(seconds, 0);
}

function validDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id,
    workspaceId: WS_ID,
    name: "P",
    status: "active",
    createdByUserId: "owner-1",
    createdAt: ts(1000),
    updatedAt: ts(1000),
    ...overrides,
  };
}

beforeEach(() => {
  listActiveProjectsRawMock.mockReset();
});

describe("listTeamProjects", () => {
  it("queries with workspaceId only — passes exactly workspaceId/limit/status/startAfter through, no userId/createdByUserId predicate exists anywhere in this module", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "ok", items: [{ data: validDoc("p1"), id: "p1", updateTime: ts(2000) }], hasMore: false });
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
    expect(result.status).toBe("ok");
    expect(listActiveProjectsRawMock).toHaveBeenCalledWith({ workspaceId: WS_ID, limit: 20, startAfter: undefined, status: "active" });
    const callArgs = listActiveProjectsRawMock.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("userId");
    expect(callArgs).not.toHaveProperty("createdByUserId");
  });

  it("happy path returns validated items and a cursor when hasMore", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "ok", items: [{ data: validDoc("p1"), id: "p1", updateTime: ts(2000) }], hasMore: true });
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeDefined();
  });

  it("fails the whole page (integrity_violation) on a malformed document — never silently omits", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "ok", items: [{ data: { id: "p1" }, id: "p1", updateTime: ts(2000) }], hasMore: false });
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("fails the whole page on an embedded-id mismatch", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "ok", items: [{ data: validDoc("different-id"), id: "p1", updateTime: ts(2000) }], hasMore: false });
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("fails the whole page on a workspaceId mismatch (never adopts a foreign-Workspace Project)", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "ok", items: [{ data: validDoc("p1", { workspaceId: "some-other-ws" }), id: "p1", updateTime: ts(2000) }], hasMore: false });
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("fails the whole page on an unexpected status (status-scoped query returned the wrong status)", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "ok", items: [{ data: validDoc("p1", { status: "archived" }), id: "p1", updateTime: ts(2000) }], hasMore: false });
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("rejects an invalid cursor", async () => {
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active", cursorRaw: "not-a-valid-cursor!!" });
    expect(result).toEqual({ status: "invalid_cursor" });
    expect(listActiveProjectsRawMock).not.toHaveBeenCalled();
  });

  it("decodes a valid cursor and passes it through as startAfter", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const cursor = encodeProjectsCursor({ createdAtSeconds: 500, createdAtNanoseconds: 0, lastDocId: "prev-id" });
    await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active", cursorRaw: cursor });
    expect(listActiveProjectsRawMock).toHaveBeenCalledWith({ workspaceId: WS_ID, limit: 20, startAfter: { createdAtSeconds: 500, createdAtNanoseconds: 0, lastDocId: "prev-id" }, status: "active" });
  });

  it("maps a raw lookup failure to lookup_failed", async () => {
    listActiveProjectsRawMock.mockResolvedValue({ status: "read_failed" });
    const result = await listTeamProjects({ workspaceId: WS_ID, limit: 20, status: "active" });
    expect(result).toEqual({ status: "lookup_failed" });
  });
});
