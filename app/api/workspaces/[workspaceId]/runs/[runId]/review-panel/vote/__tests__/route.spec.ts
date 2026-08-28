/**
 * Approval Workflow, Phase 9B.5.2 —
 * POST /api/workspaces/{workspaceId}/runs/{runId}/review-panel/vote tests.
 * Mocks the underlying service — covers admission (deliberately NO
 * Approval Workflow gate), body validation (reusing the real
 * parseSubmitAdaptiveReviewVoteRequest), and status-code mapping only.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));

const mockedSubmitWorkspaceReviewPanelVote = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewPanelMutations", () => ({
  submitWorkspaceReviewPanelVote: (...args: unknown[]) => mockedSubmitWorkspaceReviewPanelVote(...args),
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/review-panel/vote/route";

const UID = "reviewer-1";
const WS_ID = "ws-team-1";
const RUN_ID = "run-1";

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-panel/vote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { panelRevision: 1, status: "approved", ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedSubmitWorkspaceReviewPanelVote.mockResolvedValue({ ok: true, submissionStatus: "submitted", vote: { status: "approved", submittedAt: "2026-08-10T00:00:00.000Z", commentPresent: false, conditionsCount: 0 } });
});

describe("auth (no Approval Workflow gate — drain-eligible)", () => {
  it("missing credentials -> 401, zero downstream calls", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(401);
    expect(mockedSubmitWorkspaceReviewPanelVote).not.toHaveBeenCalled();
  });

  it("authenticated -> proceeds straight to the service, no admission gate to bypass", async () => {
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    expect(mockedSubmitWorkspaceReviewPanelVote).toHaveBeenCalled();
  });
});

describe("body validation (reuses the real request parser)", () => {
  it("invalid JSON -> 400", async () => {
    const req = new NextRequest(`http://localhost/api/workspaces/${WS_ID}/runs/${RUN_ID}/review-panel/vote`, { method: "POST", body: "{not json", headers: { "Content-Type": "application/json" } });
    const res = await POST(req, { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("missing panelRevision -> 400", async () => {
    const res = await POST(buildRequest({ status: "approved" }), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
    expect(mockedSubmitWorkspaceReviewPanelVote).not.toHaveBeenCalled();
  });

  it("invalid status -> 400", async () => {
    const res = await POST(buildRequest(validBody({ status: "unreviewed" })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });

  it("rejected without comment -> 400", async () => {
    const res = await POST(buildRequest(validBody({ status: "rejected" })), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(400);
  });
});

describe("result mapping", () => {
  it("success -> 200", async () => {
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.submissionStatus).toBe("submitted");
  });

  it("not_reviewer -> 403", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "not_reviewer" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("self_review -> 403, same status/errorCode as not_reviewer (never distinguishable)", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "not_reviewer" });
    const resA = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "self_review" });
    const resB = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(resA.status).toBe(resB.status);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA.error.code).toBe(bodyB.error.code);
  });

  it("panel_not_open -> 409", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "panel_not_open" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("panel_stale -> 409", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "panel_stale" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("vote_conflict -> 409", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "vote_conflict" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(409);
  });

  it("panel_absent -> concealed 404", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "panel_absent" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
  });

  it("Phase 10C.1A: team_workspaces_disabled -> concealed 404 (not a distinguishable 503)", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(404);
    expect((await res.json()).errorCode).toBe("team_workspace_not_found");
  });

  it("F1 parity: team_workspaces_disabled (Case 1) is byte-identical to panel_absent (Case 2)", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "team_workspaces_disabled" });
    const notAdmittedRes = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const notAdmittedJson = await notAdmittedRes.json();
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "panel_absent" });
    const admittedButForeignRes = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    const admittedButForeignJson = await admittedButForeignRes.json();
    expect(notAdmittedRes.status).toBe(admittedButForeignRes.status);
    expect(JSON.stringify(notAdmittedJson)).toBe(JSON.stringify(admittedButForeignJson));
  });

  it("insufficient_capability (Workspace-level) -> 403", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "insufficient_capability" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(403);
  });

  it("write_failed -> 500", async () => {
    mockedSubmitWorkspaceReviewPanelVote.mockResolvedValueOnce({ ok: false, reason: "write_failed" });
    const res = await POST(buildRequest(validBody()), { params: { workspaceId: WS_ID, runId: RUN_ID } });
    expect(res.status).toBe(500);
  });
});
