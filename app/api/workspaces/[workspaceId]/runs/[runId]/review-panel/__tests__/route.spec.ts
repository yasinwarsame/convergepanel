/**
 * Approval Workflow, Phase 9B.5.2 —
 * GET/PUT/DELETE /api/workspaces/{workspaceId}/runs/{runId}/review-panel tests.
 * Mocks every underlying lib function — covers admission gating (including
 * GET's deliberately different drain-aware ordering), body validation, and
 * status-code mapping only. Service-layer business logic is covered
 * exhaustively by workspaceReviewPanelMutations.spec.ts.
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

const mockedGetWorkspaceReviewPanel = jest.fn();
const mockedPutWorkspaceReviewPanel = jest.fn();
const mockedDeleteWorkspaceReviewPanel = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewPanelMutations", () => {
  const actual = jest.requireActual("@/lib/workspaces/workspaceReviewPanelMutations");
  return {
    ...actual,
    getWorkspaceReviewPanel: (...args: unknown[]) => mockedGetWorkspaceReviewPanel(...args),
    putWorkspaceReviewPanel: (...args: unknown[]) => mockedPutWorkspaceReviewPanel(...args),
    deleteWorkspaceReviewPanel: (...args: unknown[]) => mockedDeleteWorkspaceReviewPanel(...args),
  };
});

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-panel/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(method: string, body?: unknown): NextRequest {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-panel`, init);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  approvalWorkflowEnabled = true;
  approvalWorkflowCanaryUids = undefined;
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["research.read", "reviews.read", "reviews.manage"] });
  mockedGetWorkspaceReviewPanel.mockResolvedValue({ status: "ok", panel: null });
  mockedPutWorkspaceReviewPanel.mockResolvedValue({ ok: true, panel: { status: "open", revision: 1 } });
  mockedDeleteWorkspaceReviewPanel.mockResolvedValue({ ok: true });
});

describe("GET — admission ordering (deliberately Team Workspace access FIRST)", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Team Workspace access denied -> concealed, zero service call", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedGetWorkspaceReviewPanel).not.toHaveBeenCalled();
  });

  it("missing research.read -> 403, zero service call", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, capabilities: ["reviews.read"] });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
    expect(mockedGetWorkspaceReviewPanel).not.toHaveBeenCalled();
  });

  it("missing reviews.read -> 403, zero service call", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: true, capabilities: ["research.read"] });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("Approval Workflow disabled, service reports not_admitted -> concealed 404 (drain-read denied — no panel exists)", async () => {
    approvalWorkflowEnabled = false;
    mockedGetWorkspaceReviewPanel.mockResolvedValueOnce({ status: "not_admitted" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedGetWorkspaceReviewPanel).toHaveBeenCalledWith(expect.objectContaining({ approvalAdmitted: false }));
  });

  it("Approval Workflow disabled, existing panel -> drain-read succeeds", async () => {
    approvalWorkflowEnabled = false;
    mockedGetWorkspaceReviewPanel.mockResolvedValueOnce({ status: "ok", panel: { status: "open", revision: 1 } });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.panel.status).toBe("open");
  });

  it("Approval Workflow admitted -> approvalAdmitted:true passed through", async () => {
    await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedGetWorkspaceReviewPanel).toHaveBeenCalledWith(expect.objectContaining({ approvalAdmitted: true }));
  });

  it("no panel, admitted -> 200, { panel: null }", async () => {
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, panel: null });
  });

  it("run_not_found -> concealed 404, same shape as not_admitted", async () => {
    mockedGetWorkspaceReviewPanel.mockResolvedValueOnce({ status: "run_not_found" });
    const resA = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    mockedGetWorkspaceReviewPanel.mockResolvedValueOnce({ status: "not_admitted" });
    const resB = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(resA.status).toBe(resB.status);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("panel_unreadable -> 409", async () => {
    mockedGetWorkspaceReviewPanel.mockResolvedValueOnce({ status: "panel_unreadable" });
    const res = await GET(buildRequest("GET"), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });
});

describe("PUT — admission and validation", () => {
  it("Approval Workflow disabled -> concealed 404, zero service call", async () => {
    approvalWorkflowEnabled = false;
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedPutWorkspaceReviewPanel).not.toHaveBeenCalled();
  });

  it("invalid JSON -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-panel`, { method: "PUT", body: "{not json", headers: { "Content-Type": "application/json" } });
    const res = await PUT(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("reviewerUserIds too few -> 400, service never called", async () => {
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedPutWorkspaceReviewPanel).not.toHaveBeenCalled();
  });

  it("reviewerUserIds duplicates -> 400", async () => {
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "a"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("missing expectedRevision -> 400", async () => {
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"] }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("valid body -> service called, 200 on success", async () => {
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["b", "a"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    expect(mockedPutWorkspaceReviewPanel).toHaveBeenCalledWith(expect.objectContaining({ reviewerUserIds: ["a", "b"], expectedRevision: 0 }));
  });

  it("single_review_active -> 409", async () => {
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "single_review_active" });
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("panel_finalized -> 409", async () => {
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_finalized" });
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("target_not_eligible -> 400", async () => {
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: { kind: "target_not_eligible", reviewerUserId: "a", reason: "insufficient_capability" } });
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("insufficient_capability -> 403 (same shape as reviews.manage denial)", async () => {
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("run_not_found -> concealed 404", async () => {
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("Phase 10C.1A: team_workspaces_disabled -> concealed 404 (not a distinguishable 503)", async () => {
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const res = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("team_workspace_not_found");
  });

  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to run_not_found (Case 2)", async () => {
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const notAdmittedRes = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const notAdmittedJson = await notAdmittedRes.json();
    mockedPutWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    const admittedButForeignRes = await PUT(buildRequest("PUT", { reviewerUserIds: ["a", "b"], expectedRevision: 0 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const admittedButForeignJson = await admittedButForeignRes.json();
    expect(notAdmittedRes.status).toBe(admittedButForeignRes.status);
    expect(JSON.stringify(notAdmittedJson)).toBe(JSON.stringify(admittedButForeignJson));
  });
});

describe("DELETE — drain-eligible, no Approval Workflow gate", () => {
  it("Approval Workflow disabled -> still proceeds to the service (cancel is a drain operation)", async () => {
    approvalWorkflowEnabled = false;
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    expect(mockedDeleteWorkspaceReviewPanel).toHaveBeenCalled();
  });

  it("body-less DELETE defaults expectedRevision to 0", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-panel`, { method: "DELETE" });
    await DELETE(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedDeleteWorkspaceReviewPanel).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
  });

  it("panel_absent -> 404", async () => {
    mockedDeleteWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_absent" });
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("stale_revision -> 409", async () => {
    mockedDeleteWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "stale_revision" });
    const res = await DELETE(buildRequest("DELETE", { expectedRevision: 1 }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });
});
