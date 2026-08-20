/**
 * Team Project Backend, Phase 8C-A — GET/POST
 * /api/workspaces/{workspaceId}/projects tests. Mocks every underlying lib
 * function (each independently tested elsewhere) — this suite covers
 * auth, capability-gating, request parsing, and status-code mapping only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: unknown[]) => mockedResolveWorkspaceAccess(...args),
}));

const mockedListTeamProjects = jest.fn();
jest.mock("@/lib/projects/listTeamProjects", () => ({
  listTeamProjects: (...args: unknown[]) => mockedListTeamProjects(...args),
}));

const mockedCreateTeamProject = jest.fn();
jest.mock("@/lib/firestore/teamProjects", () => ({
  createTeamProject: (...args: unknown[]) => mockedCreateTeamProject(...args),
}));

const mockedCountProjectsInWorkspace = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  countProjectsInWorkspace: (...args: unknown[]) => mockedCountProjectsInWorkspace(...args),
}));

const mockedWriteProjectEvent = jest.fn();
jest.mock("@/lib/projects/projectEvents", () => ({
  writeProjectEvent: (...args: unknown[]) => mockedWriteProjectEvent(...args),
}));

const mockedCheckRateLimit = jest.fn();
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: (...args: unknown[]) => mockedCheckRateLimit(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET, POST } from "@/app/api/workspaces/[workspaceId]/projects/route";

const UID = "member-1";
const WS_ID = "ws-team-1";

function buildRequest(method: "GET" | "POST", path = "", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/projects${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function callGet(path = "") {
  const res = await GET(buildRequest("GET", path), { params: { workspaceId: WS_ID } });
  const json = await res.json();
  return { res, json };
}
async function callPost(body?: unknown) {
  const res = await POST(buildRequest("POST", "", body), { params: { workspaceId: WS_ID } });
  const json = await res.json();
  return { res, json };
}

const GRANTED_TEAM_ACCESS = {
  granted: true,
  workspaceType: "team",
  workspace: { id: WS_ID, type: "team" },
  membership: { role: "member" },
  capabilities: ["workspace.read", "projects.read", "projects.create", "projects.manage", "research.read", "research.create", "research.organize"],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedResolveWorkspaceAccess.mockResolvedValue(GRANTED_TEAM_ACCESS);
  mockedCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 19, resetAt: new Date() });
  mockedCountProjectsInWorkspace.mockResolvedValue({ status: "ok", count: 1 });
  mockedWriteProjectEvent.mockResolvedValue(undefined);
});

describe("GET (list)", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callGet();
    expect(res.status).toBe(401);
    expect(mockedListTeamProjects).not.toHaveBeenCalled();
  });

  it("uses resolveWorkspaceAccess as the read gate — 404 concealed on any non-capability denial", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("team_workspace_not_found");
    expect(mockedListTeamProjects).not.toHaveBeenCalled();
  });

  it("503s when team_workspaces_disabled", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "team_workspaces_disabled" });
    const { res, json } = await callGet();
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("team_workspaces_disabled");
  });

  it("404s if the resolved workspace is Personal-typed, not Team", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID } });
    const { res } = await callGet();
    expect(res.status).toBe(404);
  });

  it("403s via the centralized capability check when projects.read is somehow absent from the resolved capability set", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ ...GRANTED_TEAM_ACCESS, capabilities: ["workspace.read"] });
    const { res, json } = await callGet();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("insufficient_capability");
  });

  it("200s with items on success, and passes only workspaceId (never a userId filter) through to listTeamProjects", async () => {
    mockedListTeamProjects.mockResolvedValue({
      status: "ok",
      items: [{ project: { id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() }, documentUpdateTime: Timestamp.now() }],
      hasMore: false,
    });
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.items).toHaveLength(1);
    expect(mockedListTeamProjects).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID, status: "active" }));
    const callArgs = mockedListTeamProjects.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("userId");
  });

  it("400s on an invalid ?status= value", async () => {
    const { res, json } = await callGet("?status=garbage");
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("invalid_status");
  });
});

describe("POST (create)", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callPost({ name: "P" });
    expect(res.status).toBe(401);
    expect(mockedCreateTeamProject).not.toHaveBeenCalled();
  });

  it("429s when rate limited", async () => {
    mockedCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const { res } = await callPost({ name: "P" });
    expect(res.status).toBe(429);
    expect(mockedCreateTeamProject).not.toHaveBeenCalled();
  });

  it("400s on an unexpected field (e.g. an attacker-supplied createdByUserId)", async () => {
    const { res, json } = await callPost({ name: "P", createdByUserId: "attacker-controlled" });
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unexpected_field");
    expect(mockedCreateTeamProject).not.toHaveBeenCalled();
  });

  it("400s on an invalid name", async () => {
    const { res } = await callPost({ name: "" });
    expect(res.status).toBe(400);
    expect(mockedCreateTeamProject).not.toHaveBeenCalled();
  });

  it("passes only {uid, workspaceId, name} to createTeamProject — never a client-supplied uid/createdByUserId", async () => {
    mockedCreateTeamProject.mockResolvedValue({
      status: "created",
      project: { id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
      documentUpdateTime: Timestamp.now(),
    });
    await callPost({ name: "P" });
    expect(mockedCreateTeamProject).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID, name: "P" });
  });

  it("201s and emits a project_created event only AFTER a successful create", async () => {
    mockedCreateTeamProject.mockResolvedValue({
      status: "created",
      project: { id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
      documentUpdateTime: Timestamp.now(),
    });
    const { res, json } = await callPost({ name: "P" });
    expect(res.status).toBe(201);
    expect(json.project.id).toBe("p1");
    expect(json.project.workspaceId).toBe(WS_ID);
    expect(mockedWriteProjectEvent).toHaveBeenCalledWith({ eventType: "project_created", actorUid: UID, workspaceId: WS_ID, projectId: "p1" });
  });

  it("maps unauthorized reasons: insufficient_capability -> 403, everything else -> 404 concealed", async () => {
    mockedCreateTeamProject.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
    const capRes = await callPost({ name: "P" });
    expect(capRes.res.status).toBe(403);

    mockedCreateTeamProject.mockResolvedValue({ status: "unauthorized", reason: "membership_removed" });
    const concealedRes = await callPost({ name: "P" });
    expect(concealedRes.res.status).toBe(404);
  });

  it("created_projection_unavailable -> still 201 (mutation genuinely committed), updateTime: null, never implies the client should retry the create", async () => {
    mockedCreateTeamProject.mockResolvedValue({
      status: "created_projection_unavailable",
      project: { id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
    });
    const { res, json } = await callPost({ name: "P" });
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
    expect(json.project.id).toBe("p1");
    expect(json.project.updateTime).toBeNull();
    expect(json.projectionUnavailable).toBe(true);
    expect(mockedWriteProjectEvent).toHaveBeenCalledWith({ eventType: "project_created", actorUid: UID, workspaceId: WS_ID, projectId: "p1" });
  });

  it("Mutation P proof: even if the event writer rejects, the route still returns the canonical 201 success — an event failure never invalidates an already-committed mutation", async () => {
    mockedWriteProjectEvent.mockRejectedValueOnce(new Error("simulated projectEvents failure"));
    mockedCreateTeamProject.mockResolvedValue({
      status: "created",
      project: { id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
      documentUpdateTime: Timestamp.now(),
    });
    const { res, json } = await callPost({ name: "P" });
    expect(res.status).toBe(201);
    expect(json.ok).toBe(true);
  });

  it("503s when team_workspaces_disabled", async () => {
    mockedCreateTeamProject.mockResolvedValue({ status: "team_workspaces_disabled" });
    const { res, json } = await callPost({ name: "P" });
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("team_workspaces_disabled");
  });

  it("429s (too_many_projects) when the abuse guard trips, without calling createTeamProject", async () => {
    mockedCountProjectsInWorkspace.mockResolvedValue({ status: "ok", count: 999 });
    const { res, json } = await callPost({ name: "P" });
    expect(res.status).toBe(429);
    expect(json.errorCode).toBe("too_many_projects");
    expect(mockedCreateTeamProject).not.toHaveBeenCalled();
  });

  it("fails open on the abuse guard itself (a count failure never blocks creation)", async () => {
    mockedCountProjectsInWorkspace.mockResolvedValue({ status: "count_failed" });
    mockedCreateTeamProject.mockResolvedValue({
      status: "created",
      project: { id: "p1", workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
      documentUpdateTime: Timestamp.now(),
    });
    const { res } = await callPost({ name: "P" });
    expect(res.status).toBe(201);
  });
});
