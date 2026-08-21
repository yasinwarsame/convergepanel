/**
 * Team Run Lists, Phase 8C-B2 — GET /api/workspaces/{workspaceId}/runs
 * tests. Mocks every underlying lib function (each independently tested
 * elsewhere) — this suite covers auth, capability-gating, scope parsing,
 * and status-code mapping only.
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

const mockedListTeamWorkspaceRuns = jest.fn();
jest.mock("@/lib/workspaces/listTeamWorkspaceRuns", () => ({
  listTeamWorkspaceRuns: (...args: unknown[]) => mockedListTeamWorkspaceRuns(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/route";

const UID = "member-1";
const WS_ID = "ws-team-1";

function buildRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs${query}`, { method: "GET" });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
});

describe("GET /api/workspaces/[workspaceId]/runs — auth", () => {
  it("missing credentials -> 401 unauthorized", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(401);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — access denial mapping", () => {
  it("team_workspaces_disabled -> 503", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
  });

  it("lookup_failed -> 503", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
  });

  it("workspace_not_found -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("wrong_workspace_type (Personal-B collision path) -> concealed 404, identical shape to workspace_not_found", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "wrong_workspace_type" });
    const res = await GET(buildRequest(), { params: { workspaceId: "personal-B" } });
    expect(res.status).toBe(404);
    const bodyA = await res.json();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const res2 = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    const bodyB = await res2.json();
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("membership_not_found -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("membership_removed -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("owner_integrity_violation -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "owner_integrity_violation" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("granted but no research.read capability -> 403 insufficient_capability", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, workspace: {}, membership: {}, capabilities: ["projects.read"] });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errorCode).toBe("insufficient_capability");
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — scope handling", () => {
  beforeEach(() => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
  });

  it("no scope param -> scope=all passed to listTeamWorkspaceRuns", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(mockedListTeamWorkspaceRuns).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID, scope: "all" }));
  });

  it("scope=unfiled -> scope=unfiled passed to listTeamWorkspaceRuns", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest("?scope=unfiled"), { params: { workspaceId: WS_ID } });
    expect(mockedListTeamWorkspaceRuns).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_ID, scope: "unfiled" }));
  });

  it("unsupported scope value -> 400 invalid_scope, listTeamWorkspaceRuns never called", async () => {
    const res = await GET(buildRequest("?scope=bogus"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect(mockedListTeamWorkspaceRuns).not.toHaveBeenCalled();
  });

  it("no magic projectId=null sentinel accepted", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest("?projectId=null"), { params: { workspaceId: WS_ID } });
    // projectId is simply not a recognized query param at all — falls
    // through to scope=all, never a special-cased sentinel.
    expect(mockedListTeamWorkspaceRuns).toHaveBeenCalledWith(expect.objectContaining({ scope: "all" }));
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — result mapping", () => {
  beforeEach(() => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
  });

  it("ok -> 200 with items/hasMore/scope", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "ok", items: [{ id: "r1" }], hasMore: true, nextCursor: "abc" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.items).toEqual([{ id: "r1" }]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe("abc");
    expect(body.scope).toBe("all");
  });

  it("invalid_cursor -> 400", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "invalid_cursor" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("integrity_violation -> 500 internal_error (never 404)", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "integrity_violation" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.errorCode).toBe("internal_error");
  });

  it("query_failed -> 500 internal_error", async () => {
    mockedListTeamWorkspaceRuns.mockResolvedValueOnce({ status: "query_failed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/workspaces/[workspaceId]/runs — no client-side authorization trust", () => {
  it("workspaceId/scope authorization always re-derived server-side from the authenticated uid — never trusts a client-supplied override", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, workspace: {}, membership: {}, capabilities: ["research.read"] });
    mockedListTeamWorkspaceRuns.mockResolvedValue({ status: "ok", items: [], hasMore: false });
    await GET(buildRequest(), { params: { workspaceId: WS_ID } });
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });
});
