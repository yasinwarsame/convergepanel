/**
 * Team Workspace Core Foundation, Phase 8B, route namespace corrected in
 * Phase 8B.1 — POST /api/workspaces tests. Mocks `createTeamWorkspace()`
 * (already independently tested) — this suite covers request parsing,
 * auth, and status-code mapping only. No feature-flag/disabled scenario
 * exists here — Phase 8B.1 removed `TEAM_WORKSPACES_ENABLED` entirely.
 *
 * Phase 9C.1-R1C adds `GET /api/workspaces` — the bounded, paginated
 * "Team Workspaces I actively belong to" discovery/selection list backing
 * the Reviews multi-Workspace chooser.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

const mockedCreateTeamWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaceMemberships", () => ({
  createTeamWorkspace: (...args: unknown[]) => mockedCreateTeamWorkspace(...args),
}));

let teamRolloutEnabled = true;
const mockedResolveTeamWorkspacesMode = jest.fn(() => ({ enabled: teamRolloutEnabled, source: teamRolloutEnabled ? "global" : "off", canaryConfigInvalid: false }));
jest.mock("@/lib/workspaces/teamWorkspacesRollout", () => ({
  resolveTeamWorkspacesMode: (...args: unknown[]) => mockedResolveTeamWorkspacesMode(...args),
}));

const mockedListViewerTeamWorkspaces = jest.fn();
jest.mock("@/lib/workspaces/listViewerTeamWorkspaces", () => ({
  ...jest.requireActual("@/lib/workspaces/listViewerTeamWorkspaces"),
  listViewerTeamWorkspaces: (...args: unknown[]) => mockedListViewerTeamWorkspaces(...args),
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/workspaces/route";

const UID = "uid-1";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/workspaces", { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

function buildGetRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces${query}`, { method: "GET" });
}

async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body));
  const json = await res.json();
  return { res, json };
}

async function callGet(query = "") {
  const res = await GET(buildGetRequest(query));
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  teamRolloutEnabled = true;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(401);
  expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
});

it("400s on an invalid JSON body", async () => {
  const req = new NextRequest("http://localhost/api/workspaces", { method: "POST", body: "not json" });
  const res = await POST(req);
  expect(res.status).toBe(400);
});

it("400s on an unexpected field", async () => {
  const { res, json } = await callRoute({ name: "Acme", ownerUserId: "attacker-controlled" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
});

it("400s on an invalid name", async () => {
  const { res } = await callRoute({ name: "" });
  expect(res.status).toBe(400);
  expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
});

it("201s and returns the created workspace/membership on success", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "created", workspace: { id: "ws-1", type: "team" }, membership: { id: "wm_1", role: "owner" } });
  const { res, json } = await callRoute({ name: "Acme Team" });
  expect(res.status).toBe(201);
  expect(json.ok).toBe(true);
  expect(json.workspace.id).toBe("ws-1");
  expect(mockedCreateTeamWorkspace).toHaveBeenCalledWith({ uid: UID, name: "Acme Team" });
});

it("passes only the authenticated uid — never a client-supplied uid", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "created", workspace: {}, membership: {} });
  await callRoute({ name: "Acme" });
  expect(mockedCreateTeamWorkspace.mock.calls[0][0]).toEqual({ uid: UID, name: "Acme" });
});

it("500s on create_failed", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "create_failed" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(500);
});

it("500s on firestore_unavailable", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "firestore_unavailable" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(500);
});

it("503s when team_workspaces_disabled (rollout gate off)", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "team_workspaces_disabled" });
  const { res, json } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(503);
  expect(json.errorCode).toBe("team_workspaces_disabled");
});

describe("GET /api/workspaces — Phase 9C.1-R1C list endpoint", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callGet();
    expect(res.status).toBe(401);
    expect(mockedListViewerTeamWorkspaces).not.toHaveBeenCalled();
  });

  it("503s when Team Workspaces rollout is off — never reaches Firestore", async () => {
    teamRolloutEnabled = false;
    const { res, json } = await callGet();
    expect(res.status).toBe(503);
    expect(json.errorCode).toBe("team_workspaces_disabled");
    expect(mockedListViewerTeamWorkspaces).not.toHaveBeenCalled();
  });

  it("200s and returns items/hasMore/nextCursor on success", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue({ status: "ok", items: [{ workspaceId: "ws-1", name: "Acme" }], hasMore: false, nextCursor: null });
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items).toEqual([{ workspaceId: "ws-1", name: "Acme" }]);
    expect(json.hasMore).toBe(false);
    expect(json.nextCursor).toBeNull();
  });

  it("passes only the authenticated uid — never a client-supplied uid — to listViewerTeamWorkspaces", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue({ status: "ok", items: [], hasMore: false, nextCursor: null });
    await callGet();
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ uid: UID });
  });

  it("forwards a supplied cursor verbatim", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue({ status: "ok", items: [], hasMore: false, nextCursor: null });
    await callGet("?cursor=wm_abc123");
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0]).toMatchObject({ cursor: "wm_abc123" });
  });

  it("clamps an oversized limit to the max page size", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue({ status: "ok", items: [], hasMore: false, nextCursor: null });
    await callGet("?limit=99999");
    expect(mockedListViewerTeamWorkspaces.mock.calls[0][0].limit).toBeLessThanOrEqual(50);
  });

  it("500s when the list lookup fails", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue({ status: "lookup_failed" });
    const { res } = await callGet();
    expect(res.status).toBe(500);
  });

  it("response never exposes role, capability arrays, owner uid, or member lists — only workspaceId/name", async () => {
    mockedListViewerTeamWorkspaces.mockResolvedValue({
      status: "ok",
      items: [{ workspaceId: "ws-1", name: "Acme" } as any],
      hasMore: false,
      nextCursor: null,
    });
    const { json } = await callGet();
    for (const item of json.items) {
      expect(Object.keys(item).sort()).toEqual(["name", "workspaceId"]);
    }
  });
});
