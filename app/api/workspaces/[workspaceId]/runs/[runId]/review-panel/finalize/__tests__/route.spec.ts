/**
 * Approval Workflow, Phase 9B.5.2 —
 * POST /api/workspaces/{workspaceId}/runs/{runId}/review-panel/finalize tests.
 * Mocks the underlying service — covers admission (deliberately NO Approval
 * Workflow gate), body validation, and status-code mapping only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedFinalizeWorkspaceReviewPanel = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewPanelMutations", () => ({
  finalizeWorkspaceReviewPanel: (...args: unknown[]) => mockedFinalizeWorkspaceReviewPanel(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-panel/finalize/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-panel/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { expectedPanelRevision: 1, expectedGovernanceUpdatedAt: "2026-08-01T00:00:00.000Z", ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedFinalizeWorkspaceReviewPanel.mockResolvedValue({ ok: true, status: "approved", finalizedAt: "2026-08-10T00:00:00.000Z" });
});

describe("auth (no Approval Workflow gate — drain-eligible)", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedFinalizeWorkspaceReviewPanel).not.toHaveBeenCalled();
  });
});

describe("body validation", () => {
  it("invalid JSON -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-panel/finalize`, { method: "POST", body: "{not json", headers: { "Content-Type": "application/json" } });
    const res = await POST(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("missing expectedPanelRevision -> 400", async () => {
    const res = await POST(buildRequest({ expectedGovernanceUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedFinalizeWorkspaceReviewPanel).not.toHaveBeenCalled();
  });

  it("invalid expectedGovernanceUpdatedAt -> 400", async () => {
    const res = await POST(buildRequest(validBody({ expectedGovernanceUpdatedAt: "not-a-date" })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });
});

describe("result mapping", () => {
  it("success -> 200", async () => {
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finalization.status).toBe("approved");
  });

  it("quorum_not_met -> 409", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "quorum_not_met" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("panel_deadlocked -> 409", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_deadlocked" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("panel_cancelled -> 409", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_cancelled" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("governance_stale -> 409", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "governance_stale" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("panel_absent -> concealed 404", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_absent" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("insufficient_capability -> 403", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("team_workspaces_disabled -> 503", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(503);
  });

  it("aggregation_invalid -> 500", async () => {
    mockedFinalizeWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "aggregation_invalid" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(500);
  });
});
