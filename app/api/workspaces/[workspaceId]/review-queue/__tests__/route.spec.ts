/**
 * Approval Workflow, Phase 9B.4 — GET /api/workspaces/{workspaceId}/review-queue
 * tests. Mocks every underlying lib function (each independently tested
 * elsewhere) — this suite covers the two admission gates, capability
 * checks, param validation, cursor binding, and status-code mapping only.
 * The real `encodeReviewQueueCursor`/`decodeReviewQueueCursor` are used
 * directly (pure, cheap, already covered by their own spec file).
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: unknown[]) => mockedLogIdentityResolutionFailure(...args),
}));

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

const mockedGetReviewQueue = jest.fn();
jest.mock("@/lib/workspaces/reviewQueue", () => ({
  getReviewQueue: (...args: unknown[]) => mockedGetReviewQueue(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/review-queue/route";
import { encodeReviewQueueCursor } from "@/lib/workspaces/reviewQueueCursor";

const UID = "member-1";
const WS_ID = "ws-team-1";

function buildRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/review-queue${query}`, { method: "GET" });
}

function grantedAccess(overrides: Record<string, unknown> = {}) {
  return {
    granted: true,
    workspace: { id: WS_ID },
    membership: { uid: UID, workspaceId: WS_ID, role: "member", status: "active" },
    capabilities: ["research.read", "reviews.read", "reviews.submit"],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  approvalWorkflowEnabled = true;
  approvalWorkflowCanaryUids = undefined;
  mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(grantedAccess());
  mockedGetReviewQueue.mockResolvedValue({ status: "ok", items: [], hasMore: false });
});

describe("auth", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(401);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetReviewQueue).not.toHaveBeenCalled();
  });

  it("invalid token -> 401 auth_error", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "invalid_token" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(401);
  });
});

describe("Approval Workflow admission gate", () => {
  it("disabled, caller not canary -> concealed 404, zero Team Workspace access call", async () => {
    approvalWorkflowEnabled = false;
    approvalWorkflowCanaryUids = undefined;
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetReviewQueue).not.toHaveBeenCalled();
  });

  it("disabled, but caller IS Approval-Workflow canary AND Team-Workspace-admitted -> allowed through", async () => {
    approvalWorkflowEnabled = false;
    approvalWorkflowCanaryUids = UID;
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalled();
  });

  it("caller is Approval-Workflow canary, but Team Workspace access denies -> still denied (canary never substitutes for Team Workspace access)", async () => {
    approvalWorkflowEnabled = false;
    approvalWorkflowCanaryUids = UID;
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("globally enabled but Team Workspace access denies -> denied (Approval Workflow flag never widens Team Workspace access)", async () => {
    approvalWorkflowEnabled = true;
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "membership_removed" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
    expect(mockedGetReviewQueue).not.toHaveBeenCalled();
  });
});

describe("Team Workspace access denial mapping", () => {
  it("team_workspaces_disabled -> 503", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "team_workspaces_disabled" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
  });

  it("lookup_failed -> 503 (infra failure distinguishable from absence)", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "lookup_failed" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(503);
  });

  it("workspace_not_found -> concealed 404", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(404);
  });

  it("wrong Workspace (wrong_workspace_type) -> concealed 404, identical body shape to workspace_not_found", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "wrong_workspace_type" });
    const resA = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    const bodyA = await resA.json();
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce({ granted: false, reason: "workspace_not_found" });
    const resB = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    const bodyB = await resB.json();
    expect(resA.status).toBe(resB.status);
    expect(bodyA.errorCode).toBe(bodyB.errorCode);
  });

  it("active Workspace member lacking research.read -> 403", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["reviews.read"] }));
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
  });

  it("active Workspace member lacking reviews.read -> 403 (this route requires BOTH capabilities)", async () => {
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValueOnce(grantedAccess({ capabilities: ["research.read"] }));
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(403);
  });
});

describe("view parameter", () => {
  it("missing view -> 400", async () => {
    const res = await GET(buildRequest(""), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("unknown view -> 400, no silent fallback to needs_review", async () => {
    const res = await GET(buildRequest("?view=all"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect(mockedGetReviewQueue).not.toHaveBeenCalled();
  });

  it.each(["assigned_to_me", "needs_review", "changes_requested", "overdue", "recently_approved"])("valid view %s is accepted", async (view) => {
    const res = await GET(buildRequest(`?view=${view}`), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockedGetReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ view }));
  });
});

describe("limit parameter", () => {
  it("default limit is 25", async () => {
    await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(mockedGetReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it("valid explicit limit is honored", async () => {
    await GET(buildRequest("?view=needs_review&limit=10"), { params: { workspaceId: WS_ID } });
    expect(mockedGetReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
  });

  it("limit above max (50) -> 400", async () => {
    const res = await GET(buildRequest("?view=needs_review&limit=51"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("limit of 0 -> 400", async () => {
    const res = await GET(buildRequest("?view=needs_review&limit=0"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("non-numeric limit -> 400", async () => {
    const res = await GET(buildRequest("?view=needs_review&limit=abc"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });
});

describe("project filter parameter", () => {
  it("no projectId/scope -> no filter (undefined)", async () => {
    await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(mockedGetReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ projectFilter: undefined }));
  });

  it("projectId=<id> -> that project", async () => {
    await GET(buildRequest("?view=needs_review&projectId=proj-1"), { params: { workspaceId: WS_ID } });
    expect(mockedGetReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ projectFilter: "proj-1" }));
  });

  it("scope=unfiled -> null", async () => {
    await GET(buildRequest("?view=needs_review&scope=unfiled"), { params: { workspaceId: WS_ID } });
    expect(mockedGetReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ projectFilter: null }));
  });

  it("both projectId and scope=unfiled -> 400", async () => {
    const res = await GET(buildRequest("?view=needs_review&projectId=proj-1&scope=unfiled"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("scope value other than unfiled -> 400", async () => {
    const res = await GET(buildRequest("?view=needs_review&scope=bogus"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });
});

describe("cursor", () => {
  it("malformed cursor -> 400 invalid_cursor", async () => {
    const res = await GET(buildRequest("?view=needs_review&cursor=not-a-real-cursor"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errorCode).toBe("invalid_cursor");
  });

  it("a cursor issued for a different view is rejected, never silently reinterpreted", async () => {
    const cursor = encodeReviewQueueCursor({ view: "overdue", projectFilter: undefined, sort: { kind: "iso", value: "2026-08-01T00:00:00.000Z" }, docPath: "runs/run-1/humanReviewAssignment/current" });
    const res = await GET(buildRequest(`?view=needs_review&cursor=${cursor}`), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
    expect(mockedGetReviewQueue).not.toHaveBeenCalled();
  });

  it("a cursor issued for a different Project filter is rejected", async () => {
    const cursor = encodeReviewQueueCursor({ view: "needs_review", projectFilter: "proj-A", sort: { kind: "timestamp", seconds: 1, nanoseconds: 0 }, docPath: "run-1" });
    const res = await GET(buildRequest(`?view=needs_review&cursor=${cursor}&projectId=proj-B`), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(400);
  });

  it("a valid cursor for the SAME view/project is honored and passed through", async () => {
    const cursor = encodeReviewQueueCursor({ view: "needs_review", projectFilter: undefined, sort: { kind: "timestamp", seconds: 1, nanoseconds: 0 }, docPath: "run-1" });
    const res = await GET(buildRequest(`?view=needs_review&cursor=${cursor}`), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    expect(mockedGetReviewQueue).toHaveBeenCalledWith(expect.objectContaining({ cursor: expect.objectContaining({ view: "needs_review" }) }));
  });
});

describe("result mapping", () => {
  it("ok result -> 200 with items/hasMore/nextCursor", async () => {
    mockedGetReviewQueue.mockResolvedValueOnce({ status: "ok", items: [{ runId: "run-1" }], hasMore: true, nextCursor: "abc" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, items: [{ runId: "run-1" }], hasMore: true, nextCursor: "abc" });
  });

  it("empty authorized queue -> 200, not 404", async () => {
    mockedGetReviewQueue.mockResolvedValueOnce({ status: "ok", items: [], hasMore: false });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, items: [], hasMore: false });
  });

  it("query_failed -> 500 (internalErrorResponse(), the same mapping the sibling GET /api/workspaces/{workspaceId}/runs route uses for its own query_failed/integrity_violation), distinguishable from an empty result", async () => {
    mockedGetReviewQueue.mockResolvedValueOnce({ status: "query_failed" });
    const res = await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(res.status).toBe(500);
  });
});

describe("no write behavior", () => {
  it("this route never imports anything from lib/firestore/runs.ts's write surface — proven structurally by module isolation (only getReviewQueue, a read-only service, is called)", async () => {
    await GET(buildRequest("?view=needs_review"), { params: { workspaceId: WS_ID } });
    expect(mockedGetReviewQueue).toHaveBeenCalledTimes(1);
  });
});
