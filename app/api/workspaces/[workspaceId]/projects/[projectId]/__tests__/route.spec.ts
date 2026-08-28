/**
 * Team Project Backend, Phase 8C-A — PATCH
 * /api/workspaces/{workspaceId}/projects/{projectId} (rename) tests.
 * Mocks `updateTeamProjectFields()` (independently tested in
 * lib/firestore/__tests__/teamProjects.spec.ts) — this suite covers auth,
 * request parsing, and status-code mapping only.
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
import { PATCH } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/route";

const UID = "member-1";
const WS_ID = "ws-team-1";
const PROJECT_ID = "proj-1";
const VALID_TOKEN = { seconds: 1_700_000_000, nanoseconds: 0 };

function buildRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/projects/${PROJECT_ID}`, { method: "PATCH", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function callRoute(body?: unknown) {
  const res = await PATCH(buildRequest(body), { params: { workspaceId: WS_ID, projectId: PROJECT_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = { name: "Renamed", expectedUpdateTime: VALID_TOKEN };

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
  const { res, json } = await callRoute({ ...VALID_BODY, workspaceId: "attacker-supplied" });
  expect(res.status).toBe(400);
  expect(json.errorCode).toBe("unexpected_field");
  expect(mockedUpdateTeamProjectFields).not.toHaveBeenCalled();
});

it("400s on an invalid name", async () => {
  const { res } = await callRoute({ name: "", expectedUpdateTime: VALID_TOKEN });
  expect(res.status).toBe(400);
  expect(mockedUpdateTeamProjectFields).not.toHaveBeenCalled();
});

it("400s on an invalid expectedUpdateTime", async () => {
  const { res } = await callRoute({ name: "X", expectedUpdateTime: { seconds: "not-a-number" } });
  expect(res.status).toBe(400);
  expect(mockedUpdateTeamProjectFields).not.toHaveBeenCalled();
});

it("passes {uid, workspaceId, projectId, mutation: {kind:'rename', name}, expectedUpdateTime} through unchanged", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({
    status: "updated",
    project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Renamed", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
    documentUpdateTime: Timestamp.now(),
  });
  await callRoute(VALID_BODY);
  expect(mockedUpdateTeamProjectFields).toHaveBeenCalledWith({
    uid: UID,
    workspaceId: WS_ID,
    projectId: PROJECT_ID,
    mutation: { kind: "rename", name: "Renamed" },
    expectedUpdateTime: new Timestamp(VALID_TOKEN.seconds, VALID_TOKEN.nanoseconds),
  });
});

it("200s and emits project_renamed only after a successful update", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({
    status: "updated",
    project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Renamed", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
    documentUpdateTime: Timestamp.now(),
  });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.project.name).toBe("Renamed");
  expect(mockedWriteProjectEvent).toHaveBeenCalledWith({ eventType: "project_renamed", actorUid: UID, workspaceId: WS_ID, projectId: PROJECT_ID });
});

it("maps unauthorized: insufficient_capability -> 403, everything else -> 404 concealed", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "unauthorized", reason: "insufficient_capability" });
  expect((await callRoute(VALID_BODY)).res.status).toBe(403);

  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "unauthorized", reason: "owner_integrity_violation" });
  expect((await callRoute(VALID_BODY)).res.status).toBe(404);
});

it("updated_projection_unavailable -> still 200 (rename genuinely committed), updateTime: null, never implies retry", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({
    status: "updated_projection_unavailable",
    project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Renamed", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
  });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.ok).toBe(true);
  expect(json.project.name).toBe("Renamed");
  expect(json.project.updateTime).toBeNull();
  expect(json.projectionUnavailable).toBe(true);
});

it("Mutation P proof: even if the event writer rejects, the route still returns the canonical 200 success", async () => {
  mockedWriteProjectEvent.mockRejectedValueOnce(new Error("simulated projectEvents failure"));
  mockedUpdateTeamProjectFields.mockResolvedValue({
    status: "updated",
    project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Renamed", status: "active", createdByUserId: UID, createdAt: Timestamp.now(), updatedAt: Timestamp.now() },
    documentUpdateTime: Timestamp.now(),
  });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(200);
  expect(json.ok).toBe(true);
});

it("404s (concealed) on project_not_found — same code as a genuinely missing Project", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "project_not_found" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(404);
  expect(json.errorCode).toBe("project_not_found");
});

it("409s on precondition_failed", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "precondition_failed" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(409);
  expect(json.errorCode).toBe("conflict");
});

it("Phase 10C.1A: team_workspaces_disabled -> concealed 404 (not a distinguishable 503)", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "team_workspaces_disabled" });
  const { res, json } = await callRoute(VALID_BODY);
  expect(res.status).toBe(404);
  expect(json.errorCode).toBe("team_workspace_not_found");
});

it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to an unauthorized/workspace_not_found denial (Case 2)", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "team_workspaces_disabled" });
  const notAdmitted = await callRoute(VALID_BODY);
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "unauthorized", reason: "workspace_not_found" });
  const admittedButForeign = await callRoute(VALID_BODY);
  expect(notAdmitted.res.status).toBe(admittedButForeign.res.status);
  expect(JSON.stringify(notAdmitted.json)).toBe(JSON.stringify(admittedButForeign.json));
});

it("500s on update_failed", async () => {
  mockedUpdateTeamProjectFields.mockResolvedValue({ status: "update_failed" });
  const { res } = await callRoute(VALID_BODY);
  expect(res.status).toBe(500);
});
