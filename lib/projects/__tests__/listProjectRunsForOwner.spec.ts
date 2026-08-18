/**
 * Project Read Foundation, Phase 7A — listProjectRunsForOwner() tests.
 * Mirrors lib/projects/__tests__/listProjectsForOwner.spec.ts's mocking
 * style and its central property: fail-whole-page-closed integrity, never
 * omit-and-continue. Additionally covers the Project/Unfiled scope split,
 * the archived-Project-still-readable rule, and read-after-association
 * semantics (via direct raw-layer mocking, since Phase 7A must not
 * mutate Production).
 */

import { Timestamp } from "firebase-admin/firestore";

const mockedResolvePersonalWorkspaceForOwner = jest.fn();
jest.mock("@/lib/workspaces/resolvePersonalWorkspaceForOwner", () => ({
  resolvePersonalWorkspaceForOwner: (...args: any[]) => mockedResolvePersonalWorkspaceForOwner(...args),
}));

const mockedResolveProjectForOwner = jest.fn();
jest.mock("@/lib/projects/resolveProjectForOwner", () => ({
  resolveProjectForOwner: (...args: any[]) => mockedResolveProjectForOwner(...args),
}));

const mockedListRunsByProjectScopeRaw = jest.fn();
jest.mock("@/lib/projects/listRunsByProjectScopeRaw", () => ({
  listRunsByProjectScopeRaw: (...args: any[]) => mockedListRunsByProjectScopeRaw(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listProjectRunsForOwner } from "@/lib/projects/listProjectRunsForOwner";
import { encodeProjectRunsCursor } from "@/lib/projects/projectRunsCursor";

const UID = "owner-1";
const WS_ID = "personal-owner-1";
const P1 = "proj-1";
const NOW = Timestamp.now();
const UPDATE_TIME = Timestamp.fromMillis(1_700_000_000_000);

function validWorkspace() {
  return { id: WS_ID, schemaVersion: 1, type: "personal", name: "Personal Workspace", ownerUserId: UID, createdAt: "x", updatedAt: "x" };
}

function validProject(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: P1, workspaceId: WS_ID, name: "My Project", status: "active", createdByUserId: UID, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function validRunDoc(overrides: Record<string, unknown> = {}) {
  return { userId: UID, workspaceId: WS_ID, projectId: P1, question: "q", selectedModels: [], status: "complete", createdAt: NOW, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "found", workspace: validWorkspace() });
  mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject(), documentUpdateTime: UPDATE_TIME });
});

describe("Workspace prerequisite", () => {
  it("propagates a non-found Workspace resolution outcome without ever calling the raw run query", async () => {
    mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status: "not_found" });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result).toEqual({ status: "workspace_failure", workspaceStatus: "not_found" });
    expect(mockedListRunsByProjectScopeRaw).not.toHaveBeenCalled();
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });

  it("every non-found Workspace status is faithfully propagated, not collapsed", async () => {
    for (const status of ["workspaces_disabled", "invalid_uid", "malformed", "wrong_owner", "wrong_type", "lookup_failed"] as const) {
      mockedResolvePersonalWorkspaceForOwner.mockResolvedValue({ status });
      const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
      expect(result).toEqual({ status: "workspace_failure", workspaceStatus: status });
    }
  });
});

describe("Project scope — authorization", () => {
  it("propagates a non-found Project resolution outcome without ever running the run query", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "workspace_mismatch" });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual({ status: "project_failure", projectStatus: "workspace_mismatch" });
    expect(mockedListRunsByProjectScopeRaw).not.toHaveBeenCalled();
  });

  it("SECURITY: a foreign/malformed/nonexistent Project all propagate through the same concealed pathway (status only, no distinguishing side channel)", async () => {
    for (const status of ["not_found", "malformed", "workspace_mismatch", "invalid_project_id"] as const) {
      mockedResolveProjectForOwner.mockResolvedValue({ status });
      const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
      expect(result).toEqual({ status: "project_failure", projectStatus: status });
    }
  });

  it("an ARCHIVED own Project resolves as found and its runs are readable — status is never gated here", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject({ status: "archived" }), documentUpdateTime: UPDATE_TIME });
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc(), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.projectMeta?.project.status).toBe("archived");
      expect(result.items).toHaveLength(1);
    }
  });

  it("scopes the raw query to the RESOLVED Workspace id and requested Project id", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(mockedListRunsByProjectScopeRaw).toHaveBeenCalledWith(expect.objectContaining({ userId: UID, workspaceId: WS_ID, projectId: P1 }));
  });

  it("returns Project display metadata alongside items — no separate detail GET needed", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.projectMeta).toEqual({ project: validProject(), documentUpdateTime: UPDATE_TIME });
    }
  });
});

describe("Unfiled scope", () => {
  it("does not call resolveProjectForOwner at all", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(mockedResolveProjectForOwner).not.toHaveBeenCalled();
  });

  it("scopes the raw query with projectId: null", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(mockedListRunsByProjectScopeRaw).toHaveBeenCalledWith(expect.objectContaining({ userId: UID, workspaceId: WS_ID, projectId: null }));
  });

  it("returns no projectMeta field", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: null }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.projectMeta).toBeUndefined();
      expect(result.items[0].projectId).toBeNull();
    }
  });

  it("a legitimately Unfiled run (projectId present and null) is included", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: null }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result).toEqual(expect.objectContaining({ status: "ok", hasMore: false }));
    if (result.status === "ok") expect(result.items).toHaveLength(1);
  });
});

describe("cursor", () => {
  it("invalid cursor -> invalid_cursor, no run query attempted", async () => {
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20, cursorRaw: "not a valid cursor!!!" });
    expect(result).toEqual({ status: "invalid_cursor" });
    expect(mockedListRunsByProjectScopeRaw).not.toHaveBeenCalled();
  });

  it("a valid cursor decodes and is passed through as startAfter", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const cursor = encodeProjectRunsCursor({ createdAtSeconds: 100, createdAtNanoseconds: 0, lastDocId: "run-x" });
    await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20, cursorRaw: cursor });
    expect(mockedListRunsByProjectScopeRaw).toHaveBeenCalledWith(expect.objectContaining({ startAfter: { createdAtSeconds: 100, createdAtNanoseconds: 0, lastDocId: "run-x" } }));
  });

  it("produces a nextCursor only when hasMore is true", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: null }), id: "run-1" }], hasMore: true });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.nextCursor).toBeDefined();
  });

  it("omits nextCursor when hasMore is false", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: null }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.nextCursor).toBeUndefined();
  });
});

describe("SECURITY/INTEGRITY: fail the whole page closed, never omit-and-continue", () => {
  it("a wrong-userId row fails the ENTIRE page (project scope)", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({
      status: "ok",
      items: [{ data: validRunDoc(), id: "run-1" }, { data: validRunDoc({ userId: "someone-else" }), id: "run-2" }],
      hasMore: false,
    });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("a wrong-workspaceId row fails the whole page closed", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ workspaceId: "personal-someone-else" }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("project scope: a row whose projectId doesn't exactly match the requested Project fails the whole page closed", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: "some-other-project" }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("project scope: a row with projectId absent fails the whole page closed", async () => {
    const doc = validRunDoc();
    delete (doc as any).projectId;
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: doc, id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("project scope: a row with projectId null fails the whole page closed", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: null }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("unfiled scope: a row with projectId ABSENT (never included as legacy fallback) fails the whole page closed", async () => {
    const doc = validRunDoc();
    delete (doc as any).projectId;
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: doc, id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("unfiled scope: a row with projectId a non-empty STRING fails the whole page closed", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: "proj-2" }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("unfiled scope: a row with a MALFORMED projectId value (number) fails the whole page closed", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: 12345 }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result).toEqual({ status: "integrity_violation" });
  });

  it("MUTATION CHECK: an omit-and-continue implementation would return {status:'ok', items:[validRun]} for the mixed-page case — proving the strict-fail test actually distinguishes the two policies", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({
      status: "ok",
      items: [{ data: validRunDoc(), id: "run-1" }, { data: validRunDoc({ userId: "someone-else" }), id: "run-2" }],
      hasMore: false,
    });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).not.toEqual(expect.objectContaining({ status: "ok" }));
  });
});

describe("read-after-association semantics (via raw-layer mocking — Phase 7A performs no Production mutation)", () => {
  it("a run currently null is included by the Unfiled scope", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: null }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.id)).toContain("run-1");
  });

  it("after an assign (R now under P1), the SAME raw layer scoped to P1 returns it, and scoped to Unfiled would not (simulated via two independent calls with different raw responses)", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValueOnce({ status: "ok", items: [{ data: validRunDoc({ projectId: P1 }), id: "run-1" }], hasMore: false });
    const projectResult = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(projectResult.status).toBe("ok");
    if (projectResult.status === "ok") expect(projectResult.items.map((i) => i.id)).toContain("run-1");

    mockedListRunsByProjectScopeRaw.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    const unfiledResult = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(unfiledResult.status).toBe("ok");
    if (unfiledResult.status === "ok") expect(unfiledResult.items).toHaveLength(0);
  });

  it("after a move (P1 -> P2), scoping to P1 no longer returns it and scoping to P2 does", async () => {
    const P2 = "proj-2";
    mockedListRunsByProjectScopeRaw.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    const p1Result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(p1Result.status).toBe("ok");
    if (p1Result.status === "ok") expect(p1Result.items).toHaveLength(0);

    mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject({ id: P2 }), documentUpdateTime: UPDATE_TIME });
    mockedListRunsByProjectScopeRaw.mockResolvedValueOnce({ status: "ok", items: [{ data: validRunDoc({ projectId: P2 }), id: "run-1" }], hasMore: false });
    const p2Result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P2 }, limit: 20 });
    expect(p2Result.status).toBe("ok");
    if (p2Result.status === "ok") expect(p2Result.items.map((i) => i.id)).toContain("run-1");
  });

  it("after an unassign (P2 -> null), scoping to Unfiled returns it again", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [{ data: validRunDoc({ projectId: null }), id: "run-1" }], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.items.map((i) => i.id)).toContain("run-1");
  });
});

describe("empty states are data, not errors", () => {
  it("an active Project with zero runs returns a successful empty page", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual(expect.objectContaining({ status: "ok", items: [], hasMore: false }));
  });

  it("an archived Project with zero runs returns a successful empty page", async () => {
    mockedResolveProjectForOwner.mockResolvedValue({ status: "found", project: validProject({ status: "archived" }), documentUpdateTime: UPDATE_TIME });
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "project", projectId: P1 }, limit: 20 });
    expect(result).toEqual(expect.objectContaining({ status: "ok", items: [], hasMore: false }));
  });

  it("Unfiled with zero runs returns a successful empty page", async () => {
    mockedListRunsByProjectScopeRaw.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    const result = await listProjectRunsForOwner({ uid: UID, scope: { type: "unfiled" }, limit: 20 });
    expect(result).toEqual(expect.objectContaining({ status: "ok", items: [], hasMore: false }));
  });
});
