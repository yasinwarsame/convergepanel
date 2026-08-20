/**
 * Team Project Backend, Phase 8C-A — POST
 * /api/workspaces/{workspaceId}/projects/{projectId}/restore tests.
 * Mirror image of the archive route's suite.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedUpdateTeamProjectFields = jest.fn();
jest.mock("@/lib/firestore/teamProjects", () => ({
  updateTeamProjectFields: (...args: unknown[]) => mockedUpdateTeamProjectFields(...args),
}));

const mockedWriteProjectEvent = jest.fn();
jest.mock("@/lib/projects/projectEvents", () => ({
  writeProjectEvent: (...args: unknown[]) => mockedWriteProjectEvent(...args),
}));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { POST } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/restore/route";

const UID = "member-1";
const WS_ID = "ws-team-1";
const PROJECT_ID = "proj-1";
const VALID_TOKEN = { seconds: 1_700_000_000, nanoseconds: 0 };

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/projects/${PROJECT_ID}/restore`, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function callRoute(body?: unknown) {
  const res = await POST(buildRequest(body), { params: { workspaceId: WS_ID, projectId: PROJECT_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = { expectedUpdateTime: VALID_TOKEN };

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
  mockedWriteProjectEvent.mockResolvedValue(undefined);
});

it("401s when unauthenticated", async () => {
  mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(401);
  expect(mockedUpdateTeamProjectFields).not.toHaveBeenCalled();
});

it("400s on an unexpected field", async () => {
  const { res, json } = await callRoute({ ...VALID_BODY, status: "active" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedUpdateTeamProjectFields).not.toHaveBeenCalled();
});

it("passes {uid, workspaceId, projectId, mutation: {kind:'restore'}, expectedUpdateTime} through", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({
    status: "updated",
    project: { id: PROJECT_ID, workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
    documentUpdateTime: Timestamp.now(),
  });
  await callRoute(VALID_BODY);
  expect(mockedUpdateTeamProjectFields).toHaveBeenCalledWith({
    uid: UID,
    workspaceId: WS_ID,
    projectId: PROJECT_ID,
    mutation: { kind: "restore" },
    expectedUpdateTime: new Timestamp(VALID_TOKEN.seconds, VALID_TOKEN.nanoseconds),
  });
});

it("200s and emits project_restored only after a successful update", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({
    status: "updated",
    project: { id: PROJECT_ID, workspaceId: WS_ID, name: "P", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
    documentUpdateTime: Timestamp.now(),
  });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.project.status).toBe("active");
  expect(mockedWriteProjectEvent).toHaveBeenCalledWith({ eventType: "project_restored", actorUid: UID, workspaceId: WS_ID, projectId: PROJECT_ID });
});

it("409s on invalid_transition (already active)", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "invalid_transition" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
  expect(json.errorCode).toBe("invalid_project_status_transition");
});

it("maps unauthorized: insufficient_capability -> 403, everything else -> 404 concealed", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
  expect((await callRoute(VALID_BODY)).res.status).toBe(403);

  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "unauthorized", reason: "workspace_malformed" });
  expect((await callRoute(VALID_BODY)).res.status).toBe(404);
});

it("404s (concealed) on project_not_found", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "project_not_found" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(404);
  expect(json.errorCode).toBe("project_not_found");
});

it("503s when team_workspaces_disabled", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "team_workspaces_disabled" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(503);
});
