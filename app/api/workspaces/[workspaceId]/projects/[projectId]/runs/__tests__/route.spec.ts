/**
 * Team Run Lists, Phase 8C-B2 — GET
 * /api/workspaces/{workspaceId}/projects/{projectId}/runs tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: unknown[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  getProject: (...args: unknown[]) => mockedGetProject(...args),
}));

const mockedListTeamProjectRuns = jest.fn();
jest.mock("@/lib/workspaces/listTeamProjectRuns", () => ({
  listTeamProjectRuns: (...args: unknown[]) => mockedListTeamProjectRuns(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/runs/route";

const UID = "member-1";
const WS_ID = "ws-team-1";
const P_ID = "proj-1";

function buildRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/projects/${P_ID}/runs${query}`, { method: "GET" });
}

function validProject(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id: P_ID, workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: {}, updatedAt: {}, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
});

describe("GET .../projects/[projectId]/runs — auth/access (mirrors the general runs route)", () => {
  it("access denied -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(404);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("no research.read -> 403", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: [] });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(403);
  });
});

describe("GET .../projects/[projectId]/runs — Project validation", () => {
  it("Project not_found -> concealed 404", async () => {
    mockedGetProject.mockResolvedValueOnce({ status: "not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errorCode).toBe("project_not_found");
  });

  it("Project malformed -> concealed 404", async () => {
    mockedGetProject.mockResolvedValueOnce({ status: "malformed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(404);
  });

  it("Project belongs to a DIFFERENT Workspace -> concealed 404, identical to not_found", async () => {
    mockedGetProject.mockResolvedValueOnce({ status: "found", project: validProject({ workspaceId: "some-other-ws" }) });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(404);
    const bodyA = await res.json();
    mockedGetProject.mockResolvedValueOnce({ status: "not_found" });
    const res2 = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    const bodyB = await res2.json();
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("Project lookup infra failure -> 503, not 404", async () => {
    mockedGetProject.mockResolvedValueOnce({ status: "firestore_unavailable" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(503);
  });

  it("valid Project -> proceeds to query, listTeamProjectRuns called with workspaceId+projectId", async () => {
    mockedGetProject.mockResolvedValueOnce({ status: "found", project: validProject() });
    mockedListTeamProjectRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(200);
    expect(mockedListTeamProjectRuns).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID, projectId: P_ID }));
  });

  it("no per-row Project re-read — getProject is called exactly once per request", async () => {
    mockedGetProject.mockResolvedValueOnce({ status: "found", project: validProject() });
    mockedListTeamProjectRuns.mockResolvedValueOnce({ status: "ok", items: [{ id: "r1" }, { id: "r2" }, { id: "r3" }], hasMore: false });
    await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(mockedGetProject).toHaveBeenCalledTimes(1);
  });
});

describe("GET .../projects/[projectId]/runs — result mapping", () => {
  beforeEach(() => {
    mockedGetProject.mockResolvedValue({ status: "found", project: validProject() });
  });

  it("ok -> 200 with items/hasMore, no creator filter applied", async () => {
    mockedListTeamProjectRuns.mockResolvedValueOnce({ status: "ok", items: [{ id: "r1", userId: "some-other-creator" }], hasMore: true, nextCursor: "xyz" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    const body = await res.json();
    expect(body.items[0].userId).toBe("some-other-creator");
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe("xyz");
  });

  it("invalid_cursor -> 400", async () => {
    mockedListTeamProjectRuns.mockResolvedValueOnce({ status: "invalid_cursor" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(400);
  });

  it("integrity_violation -> 500 internal_error", async () => {
    mockedListTeamProjectRuns.mockResolvedValueOnce({ status: "integrity_violation" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, projectId: P_ID } });
    expect(res.status).toBe(500);
  });
});
