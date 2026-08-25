/**
 * Approval Workflow, Phase 9B.5.1 —
 * GET/PUT/DELETE /api/workspaces/{workspaceId}/runs/{runId}/review-assignment
 * tests. Mocks every underlying lib function (each independently tested
 * elsewhere) — this suite covers admission gating, param/body validation,
 * and status-code mapping only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

let approvalWorkflowEnabled = false;
let approvalWorkflowCanaryUids: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get APPROVAL_WORKFLOW_ENABLED() {
    return approvalWorkflowEnabled;
  },
  get APPROVAL_WORKFLOW_CANARY_UIDS() {
    return approvalWorkflowCanaryUids;
  },
}));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: unknown[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

const mockedGetWorkspaceReviewAssignment = jest.fn();
const mockedPutWorkspaceReviewAssignment = jest.fn();
const mockedDeleteWorkspaceReviewAssignment = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewMutations", () => ({
  getWorkspaceReviewAssignment: (...args: unknown[]) => mockedGetWorkspaceReviewAssignment(...args),
  putWorkspaceReviewAssignment: (...args: unknown[]) => mockedPutWorkspaceReviewAssignment(...args),
  deleteWorkspaceReviewAssignment: (...args: unknown[]) => mockedDeleteWorkspaceReviewAssignment(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-assignment/route";

const UID = "member-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(method: "GET" | "PUT" | "DELETE", body?: unknown): NextRequest {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-assignment`, init);
}

function grantedAccess(overrides: Record<string, unknown> = {}) {
  return { granted: true, workspace: { id: WS_ID }, membership: { uid: UID, workspaceId: WS_ID, role: "member", status: "active" }, capabilities: ["research.read", "reviews.read", "reviews.submit"], ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  approvalWorkflowEnabled = true;
  approvalWorkflowCanaryUids = undefined;
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(grantedAccess());
  mockedGetWorkspaceReviewAssignment.mockResolvedValue({ status: "ok", assignment: null, assignmentRevision: 0 });
  mockedPutWorkspaceReviewAssignment.mockResolvedValue({ ok: true, assignment: { assignedReviewerUserId: "reviewer-1", revision: 1, assignedAt: "x", assignedByUserId: UID, updatedAt: "x", dueAt: null } });
  mockedDeleteWorkspaceReviewAssignment.mockResolvedValue({ ok: true });
});

describe("GET — auth", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedGetWorkspaceReviewAssignment).not.toHaveBeenCalled();
  });

  it("Approval Workflow disabled, not canary -> concealed 404, zero Team Workspace call", async () => {
    approvalWorkflowEnabled = false;
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Team Workspace access denied -> mapped response, zero service call", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedGetWorkspaceReviewAssignment).not.toHaveBeenCalled();
  });

  it("missing research.read -> 403", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["reviews.read"] }));
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("missing reviews.read -> 403", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["research.read"] }));
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });
});

describe("GET — result mapping", () => {
  it("no assignment -> 200, null, assignmentRevision 0", async () => {
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, assignment: null, assignmentRevision: 0 });
  });

  it("existing assignment -> 200, DTO, assignmentRevision echoed", async () => {
    mockedGetWorkspaceReviewAssignment.mockResolvedValueOnce({
      status: "ok",
      assignment: { assignedReviewerUserId: "reviewer-1", revision: 2, assignedAt: "x", assignedByUserId: "owner-1", updatedAt: "x", dueAt: null },
      assignmentRevision: 2,
    });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const body = await res.json();
    expect(body.assignment.assignedReviewerUserId).toBe("reviewer-1");
    expect(body.assignmentRevision).toBe(2);
  });

  it("Phase 9B.7: cleared assignment -> 200, assignment null but assignmentRevision nonzero", async () => {
    mockedGetWorkspaceReviewAssignment.mockResolvedValueOnce({ status: "ok", assignment: null, assignmentRevision: 3 });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const body = await res.json();
    expect(body).toEqual({ ok: true, assignment: null, assignmentRevision: 3 });
  });

  it("run_not_found -> concealed 404", async () => {
    mockedGetWorkspaceReviewAssignment.mockResolvedValueOnce({ status: "run_not_found" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("read_failed -> 500", async () => {
    mockedGetWorkspaceReviewAssignment.mockResolvedValueOnce({ status: "read_failed" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(500);
  });
});

describe("PUT — validation", () => {
  it("missing assignedReviewerUserId -> 400", async () => {
    const res = await PUT(buildRequest("PUT", { expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedPutWorkspaceReviewAssignment).not.toHaveBeenCalled();
  });

  it("missing expectedRevision -> 400", async () => {
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("negative expectedRevision -> 400", async () => {
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: -1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("invalid JSON -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-assignment`, { method: "PUT", body: "{not json", headers: { "Content-Type": "application/json" } });
    const res = await PUT(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("malformed dueAt (date-only string) -> 400, service never called", async () => {
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: "2026-08-23" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedPutWorkspaceReviewAssignment).not.toHaveBeenCalled();
  });

  it("valid request with dueAt omitted -> service called with dueAt: undefined", async () => {
    await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedPutWorkspaceReviewAssignment).toHaveBeenCalledWith(expect.objectContaining({ dueAt: undefined }));
  });

  it("valid request with dueAt: null -> service called with dueAt: null", async () => {
    await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedPutWorkspaceReviewAssignment).toHaveBeenCalledWith(expect.objectContaining({ dueAt: null }));
  });

  it("Approval Workflow disabled -> concealed 404, service never called", async () => {
    approvalWorkflowEnabled = false;
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedPutWorkspaceReviewAssignment).not.toHaveBeenCalled();
  });
});

describe("PUT — result mapping", () => {
  it("success -> 200", async () => {
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
  });

  it("active_panel -> 409", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "active_panel" });
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("stale_revision -> 409", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "stale_revision" });
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("due_at_required_on_reassignment -> 400", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "due_at_required_on_reassignment" });
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("target_not_eligible -> 400", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: { kind: "target_not_eligible", reason: "self_review" } });
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("insufficient_capability -> 403", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("run_not_found -> concealed 404", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("membership_not_found (Workspace-level denial) -> concealed 404, same shape as run_not_found", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "membership_not_found" });
    const resA = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const bodyA = await resA.json();
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    const resB = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const bodyB = await resB.json();
    expect(resA.status).toBe(resB.status);
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("team_workspaces_disabled -> 503", async () => {
    mockedPutWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const res = await PUT(buildRequest("PUT", { assignedReviewerUserId: "reviewer-1", expectedRevision: 0, dueAt: null }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(503);
  });
});

describe("DELETE", () => {
  it("no body -> expectedRevision defaults to 0", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-assignment`, { method: "DELETE" });
    await DELETE(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedDeleteWorkspaceReviewAssignment).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
  });

  it("explicit expectedRevision honored", async () => {
    await DELETE(buildRequest("DELETE", { expectedRevision: 3 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedDeleteWorkspaceReviewAssignment).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 3 }));
  });

  it("success -> 200", async () => {
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
  });

  it("active_panel -> 409", async () => {
    mockedDeleteWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "active_panel" });
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("insufficient_capability -> 403", async () => {
    mockedDeleteWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("stale_revision -> 409", async () => {
    mockedDeleteWorkspaceReviewAssignment.mockResolvedValueOnce({ ok: false, reason: "stale_revision" });
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("Approval Workflow disabled -> concealed 404, service never called", async () => {
    approvalWorkflowEnabled = false;
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedDeleteWorkspaceReviewAssignment).not.toHaveBeenCalled();
  });
});
