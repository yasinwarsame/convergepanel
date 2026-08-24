/**
 * Approval Workflow, Phase 9B.5.1 —
 * POST /api/workspaces/{workspaceId}/runs/{runId}/review-resubmit tests.
 * Mocks resubmitWorkspaceReview() (Phase 9B.3, independently tested in its
 * own spec file) — this suite covers ONLY admission gating, body
 * validation, and status-code mapping, proving the route is a genuinely
 * thin wrapper.
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

const mockedResubmitWorkspaceReview = jest.fn();
jest.mock("@/lib/workspaces/resubmitWorkspaceReview", () => ({
  resubmitWorkspaceReview: (...args: unknown[]) => mockedResubmitWorkspaceReview(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-resubmit/route";

const UID = "creator-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-resubmit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  approvalWorkflowEnabled = true;
  approvalWorkflowCanaryUids = undefined;
  mockedResubmitWorkspaceReview.mockResolvedValue({ ok: true, record: { humanReview: { status: "unreviewed" } }, assignmentActionable: null });
});

describe("auth / admission", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedResubmitWorkspaceReview).not.toHaveBeenCalled();
  });

  it("Approval Workflow disabled -> concealed 404, zero service call", async () => {
    approvalWorkflowEnabled = false;
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedResubmitWorkspaceReview).not.toHaveBeenCalled();
  });
});

describe("body validation", () => {
  it("invalid JSON -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-resubmit`, { method: "POST", body: "{not json", headers: { "Content-Type": "application/json" } });
    const res = await POST(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("missing expectedUpdatedAt -> 400, service never called", async () => {
    const res = await POST(buildRequest({}), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedResubmitWorkspaceReview).not.toHaveBeenCalled();
  });

  it("no extra fields accepted (comment/assignment mutation fields ignored, per Phase 9B.3 contract) — only expectedUpdatedAt is forwarded", async () => {
    await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z", comment: "note", assignedReviewerUserId: "someone" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedResubmitWorkspaceReview).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID, runId: RUN_ID, expectedUpdatedAt: "2026-08-01T00:00:00.000Z" });
  });
});

describe("result mapping", () => {
  it("success -> 200", async () => {
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.review.status).toBe("unreviewed");
  });

  it("not_changes_requested -> 409", async () => {
    mockedResubmitWorkspaceReview.mockResolvedValueOnce({ ok: false, reason: "not_changes_requested" });
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("stale_expected_updated_at -> 409", async () => {
    mockedResubmitWorkspaceReview.mockResolvedValueOnce({ ok: false, reason: "stale_expected_updated_at" });
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("not_creator_or_manager -> concealed 404", async () => {
    mockedResubmitWorkspaceReview.mockResolvedValueOnce({ ok: false, reason: "not_creator_or_manager" });
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("run_not_found -> concealed 404, same shape as not_creator_or_manager", async () => {
    mockedResubmitWorkspaceReview.mockResolvedValueOnce({ ok: false, reason: "not_creator_or_manager" });
    const resA = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    mockedResubmitWorkspaceReview.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    const resB = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(resA.status).toBe(resB.status);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("team_workspaces_disabled -> 503", async () => {
    mockedResubmitWorkspaceReview.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(503);
  });

  it("write_failed -> 500", async () => {
    mockedResubmitWorkspaceReview.mockResolvedValueOnce({ ok: false, reason: "write_failed" });
    const res = await POST(buildRequest({ expectedUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(500);
  });
});
