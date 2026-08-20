/**
 * Team Workspace Core Foundation, Phase 8B — POST /api/user/team-workspaces
 * tests. Mocks `createTeamWorkspace()` (already independently tested) —
 * this suite covers request parsing, auth, and status-code mapping only.
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

import { NextRequest } from "next/server";
import { POST } from "@/app/api/user/team-workspaces/route";

const UID = "uid-1";

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/user/team-workspaces", { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body));
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(401);
  expect(mockedCreateTeamWorkspace).not.toHaveBeenCalled();
});

it("400s on an invalid JSON body", async () => {
  const req = new NextRequest("http://localhost/api/user/team-workspaces", { method: "POST", body: "not json" });
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

it("503s when Team Workspaces are disabled", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "team_workspaces_disabled" });
  const { res, json } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(503);
  expect(json.errorCode).toBe("team_workspaces_disabled");
});

it("500s on create_failed", async () => {
  mockedCreateTeamWorkspace.mockResolvedValue({ status: "create_failed" });
  const { res } = await callRoute({ name: "Acme" });
  expect(res.status).toBe(500);
});
