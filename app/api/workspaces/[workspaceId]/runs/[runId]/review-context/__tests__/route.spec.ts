/**
 * Approval Workflow, Phase 9B.6 —
 * GET /api/workspaces/{workspaceId}/runs/{runId}/review-context tests.
 * Mocks every underlying lib function — covers the deliberately
 * panel-GET-mirrored admission ordering (Team Workspace access first,
 * Approval-admission decision deferred into the service) and status-code
 * mapping only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

let approvalWorkflowEnabled = false;
jest.mock("@/lib/env", () => ({
  get APPROVAL_WORKFLOW_ENABLED() {
    return approvalWorkflowEnabled;
  },
  get APPROVAL_WORKFLOW_CANARY_UIDS() {
    return undefined;
  },
}));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: unknown[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

const mockedGetReviewContext = jest.fn();
jest.mock("@/lib/workspaces/reviewContext", () => ({
  getReviewContext: (...args: unknown[]) => mockedGetReviewContext(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-context/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-context`, { method: "GET" });
}

function grantedAccess(overrides: Record<string, unknown> = {}) {
  return { granted: true, membership: { role: "owner", status: "active" }, capabilities: ["research.read", "reviews.read"], ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  approvalWorkflowEnabled = true;
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(grantedAccess());
  mockedGetReviewContext.mockResolvedValue({
    status: "ok",
    context: {
      run: {},
      decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sourceBacked: true, humanReviewNeeded: false },
      review: {},
      assignment: null,
      panel: null,
      viewer: { mode: "normal" },
    },
  });
});

describe("admission ordering — Team Workspace access FIRST", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Team Workspace access denied -> concealed 404, zero service call", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedGetReviewContext).not.toHaveBeenCalled();
  });

  it("missing research.read -> 403", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["reviews.read"] }));
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
    expect(mockedGetReviewContext).not.toHaveBeenCalled();
  });

  it("missing reviews.read -> 403", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["research.read"] }));
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("Approval Workflow disabled: still calls the service with approvalAdmitted:false (admission decision deferred, not route-level)", async () => {
    approvalWorkflowEnabled = false;
    await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedGetReviewContext).toHaveBeenCalledWith(expect.objectContaining({ approvalAdmitted: false }));
  });

  it("Approval Workflow admitted: approvalAdmitted:true passed through", async () => {
    await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(mockedGetReviewContext).toHaveBeenCalledWith(expect.objectContaining({ approvalAdmitted: true }));
  });
});

describe("result mapping", () => {
  it("ok -> 200 with context", async () => {
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.context).toBeDefined();
  });

  it("10C.4A-U2: decisionReceipt flows through unmodified to an authorized caller's response", async () => {
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const body = await res.json();
    expect(body.context.decisionReceipt).toEqual({ conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sourceBacked: true, humanReviewNeeded: false });
  });

  it("10C.4A-U2: a caller denied at the existing Team access/capability gate never receives decisionReceipt — getReviewContext (and thus the receipt) is never reached", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.context).toBeUndefined();
    expect(mockedGetReviewContext).not.toHaveBeenCalled();
  });

  it("run_not_found -> concealed 404", async () => {
    mockedGetReviewContext.mockResolvedValueOnce({ status: "run_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("not_admitted -> concealed 404, same errorCode as run_not_found (never distinguishable)", async () => {
    mockedGetReviewContext.mockResolvedValueOnce({ status: "run_not_found" });
    const resA = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    mockedGetReviewContext.mockResolvedValueOnce({ status: "not_admitted" });
    const resB = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(resA.status).toBe(resB.status);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("firestore_unavailable -> 500-family internal error", async () => {
    mockedGetReviewContext.mockResolvedValueOnce({ status: "firestore_unavailable" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
