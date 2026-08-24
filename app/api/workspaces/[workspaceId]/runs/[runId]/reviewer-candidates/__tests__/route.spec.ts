/**
 * Approval Workflow, Phase 9B.6 —
 * GET /api/workspaces/{workspaceId}/runs/{runId}/reviewer-candidates tests.
 * Mocks every underlying lib function — covers normal-only admission (no
 * drain), dual-capability requirement, and status-code mapping.
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

const mockedGetReviewerCandidates = jest.fn();
jest.mock("@/lib/workspaces/reviewerCandidates", () => ({
  getReviewerCandidates: (...args: unknown[]) => mockedGetReviewerCandidates(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/reviewer-candidates/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/reviewer-candidates`, { method: "GET" });
}

function grantedAccess(overrides: Record<string, unknown> = {}) {
  return { granted: true, membership: { role: "owner", status: "active" }, capabilities: ["research.read", "reviews.manage"], ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  approvalWorkflowEnabled = true;
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(grantedAccess());
  mockedGetReviewerCandidates.mockResolvedValue({ status: "ok", reviewers: [] });
});

describe("admission — normal only, no drain", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("Approval Workflow disabled -> concealed 404, zero Team Workspace access call, zero service call (no drain access)", async () => {
    approvalWorkflowEnabled = false;
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetReviewerCandidates).not.toHaveBeenCalled();
  });

  it("Team Workspace access denied -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("missing research.read -> 403", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["reviews.manage"] }));
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
    expect(mockedGetReviewerCandidates).not.toHaveBeenCalled();
  });

  it("missing reviews.manage (e.g. an ordinary Member/Reviewer): 403 — this route is manager-only", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["research.read", "reviews.read", "reviews.submit"] }));
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });
});

describe("result mapping", () => {
  it("ok -> 200 with reviewers", async () => {
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "ok", reviewers: [{ uid: "u1", displayName: "Alice" }] });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewers).toEqual([{ uid: "u1", displayName: "Alice" }]);
  });

  it("run_not_found -> concealed 404", async () => {
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "run_not_found" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("query_failed -> 500-family internal error", async () => {
    mockedGetReviewerCandidates.mockResolvedValueOnce({ status: "query_failed" });
    const res = await GET(buildRequest(), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
