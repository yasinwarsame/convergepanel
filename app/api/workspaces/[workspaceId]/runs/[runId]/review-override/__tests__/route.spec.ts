/**
 * Approval Workflow, Phase 9B.5.2 —
 * POST /api/workspaces/{workspaceId}/runs/{runId}/review-override tests.
 * Mocks the underlying service — covers admission (deliberately NO Approval
 * Workflow gate), body validation (reusing the real
 * parseSubmitAdaptiveReviewOverrideRequest), and status-code mapping only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedOverrideWorkspaceReviewPanel = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewPanelMutations", () => ({
  overrideWorkspaceReviewPanel: (...args: unknown[]) => mockedOverrideWorkspaceReviewPanel(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-override/route";

const UID = "owner-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-override`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { expectedPanelRevision: 1, expectedGovernanceUpdatedAt: "2026-08-01T00:00:00.000Z", status: "approved", justification: "Deadline requires immediate resolution.", ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedOverrideWorkspaceReviewPanel.mockResolvedValue({ ok: true, status: "approved", finalizedAt: "2026-08-10T00:00:00.000Z" });
});

describe("auth (no Approval Workflow gate — naturally self-limiting)", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedOverrideWorkspaceReviewPanel).not.toHaveBeenCalled();
  });
});

describe("body validation (reuses the real request parser)", () => {
  it("invalid JSON -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-override`, { method: "POST", body: "{not json", headers: { "Content-Type": "application/json" } });
    const res = await POST(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("missing justification -> 400, service never called", async () => {
    const res = await POST(buildRequest({ ...validBody(), justification: undefined }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedOverrideWorkspaceReviewPanel).not.toHaveBeenCalled();
  });

  it("whitespace-only justification -> 400", async () => {
    const res = await POST(buildRequest(validBody({ justification: "   " })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("oversized justification -> 400", async () => {
    const res = await POST(buildRequest(validBody({ justification: "x".repeat(5000) })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("invalid status -> 400", async () => {
    const res = await POST(buildRequest(validBody({ status: "unreviewed" })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("missing expectedPanelRevision -> 400", async () => {
    const res = await POST(buildRequest({ status: "approved", justification: "x", expectedGovernanceUpdatedAt: "2026-08-01T00:00:00.000Z" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });
});

describe("result mapping", () => {
  it("success -> 200", async () => {
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.override.status).toBe("approved");
  });

  it("panel_absent -> concealed 404 (naturally self-limiting, never a general hidden bypass)", async () => {
    mockedOverrideWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_absent" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("panel_already_finalized -> 409", async () => {
    mockedOverrideWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_already_finalized" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("panel_stale -> 409", async () => {
    mockedOverrideWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "panel_stale" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("insufficient_capability (missing reviews.override or research.read) -> 403", async () => {
    mockedOverrideWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("team_workspaces_disabled -> 503", async () => {
    mockedOverrideWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(503);
  });

  it("write_failed -> 500", async () => {
    mockedOverrideWorkspaceReviewPanel.mockResolvedValueOnce({ ok: false, reason: "write_failed" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(500);
  });
});
