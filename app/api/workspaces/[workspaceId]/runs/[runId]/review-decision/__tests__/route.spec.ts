/**
 * Approval Workflow, Phase 9B.5.1 —
 * POST /api/workspaces/{workspaceId}/runs/{runId}/review-decision tests.
 * Mocks every underlying lib function — covers admission gating, body
 * validation (reusing the real parseAdaptiveReviewDecisionRequest), and
 * status-code mapping only.
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

const mockedSubmitWorkspaceReviewDecision = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewMutations", () => ({
  submitWorkspaceReviewDecision: (...args: unknown[]) => mockedSubmitWorkspaceReviewDecision(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-decision/route";

const UID = "reviewer-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-decision`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { status: "approved", expectedUpdatedAt: "2026-08-01T00:00:00.000Z", ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  approvalWorkflowEnabled = true;
  approvalWorkflowCanaryUids = undefined;
  mockedSubmitWorkspaceReviewDecision.mockResolvedValue({ ok: true, status: "approved", reviewedAt: "2026-08-10T00:00:00.000Z" });
});

describe("auth / admission", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedSubmitWorkspaceReviewDecision).not.toHaveBeenCalled();
  });

  it("Approval Workflow disabled -> concealed 404, zero service call", async () => {
    approvalWorkflowEnabled = false;
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedSubmitWorkspaceReviewDecision).not.toHaveBeenCalled();
  });
});

describe("body validation (reuses the real request parser)", () => {
  it("invalid JSON -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-decision`, { method: "POST", body: "{not json", headers: { "Content-Type": "application/json" } });
    const res = await POST(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("invalid status -> 400", async () => {
    const res = await POST(buildRequest(validBody({ status: "unreviewed" })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedSubmitWorkspaceReviewDecision).not.toHaveBeenCalled();
  });

  it("missing expectedUpdatedAt -> 400", async () => {
    const res = await POST(buildRequest({ status: "approved" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("approved_with_conditions without conditions -> 400", async () => {
    const res = await POST(buildRequest(validBody({ status: "approved_with_conditions" })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("valid approved_with_conditions with conditions -> passed through", async () => {
    await POST(buildRequest(validBody({ status: "approved_with_conditions", conditions: ["add a source"] })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedSubmitWorkspaceReviewDecision).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ status: "approved_with_conditions", conditions: ["add a source"] }) }));
  });
});

describe("result mapping", () => {
  it("success -> 200", async () => {
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, review: { status: "approved", reviewedAt: "2026-08-10T00:00:00.000Z" } });
  });

  it("active_panel -> 409", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "active_panel" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("not_reviewable -> 409", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "not_reviewable" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("stale_expected_updated_at -> 409", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "stale_expected_updated_at" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("not_authorized (unassigned) -> 403, never distinguishable from other not_authorized sub-reasons", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: { kind: "not_authorized", reason: "not_assigned" } });
    const resA = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: { kind: "not_authorized", reason: "self_review" } });
    const resB = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(resA.status).toBe(403);
    expect(resB.status).toBe(403);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("insufficient_capability (Workspace-level) -> 403", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("run_not_found / governance_record_absent -> concealed 404", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("Phase 10C.1A: team_workspaces_disabled -> concealed 404 (not a distinguishable 503)", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("team_workspace_not_found");
  });

  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to run_not_found (Case 2)", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const notAdmittedRes = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const notAdmittedJson = await notAdmittedRes.json();
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "run_not_found" });
    const admittedButForeignRes = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const admittedButForeignJson = await admittedButForeignRes.json();
    expect(notAdmittedRes.status).toBe(admittedButForeignRes.status);
    expect(JSON.stringify(notAdmittedJson)).toBe(JSON.stringify(admittedButForeignJson));
  });

  it("write_failed -> 500", async () => {
    mockedSubmitWorkspaceReviewDecision.mockResolvedValueOnce({ ok: false, reason: "write_failed" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(500);
  });
});
