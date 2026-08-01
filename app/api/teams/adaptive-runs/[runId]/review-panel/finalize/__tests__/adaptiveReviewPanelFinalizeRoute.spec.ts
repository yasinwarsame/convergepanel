/**
 * Transactional Multi-Reviewer Finalization, Part E —
 * POST /api/teams/adaptive-runs/[runId]/review-panel/finalize tests.
 */

const mockedGetRequestUid = jest.fn();
const mockedLoadUserAndTeam = jest.fn();
const mockedMemberRole = jest.fn();
const mockedIsTeamAdmin = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: (...args: any[]) => mockedGetRequestUid(...args),
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
  memberRole: (...args: any[]) => mockedMemberRole(...args),
  isTeamAdmin: (...args: any[]) => mockedIsTeamAdmin(...args),
}));

const mockedGetProjection = jest.fn();
const mockedSyncProjection = jest.fn();
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: (...args: any[]) => mockedGetProjection(...args),
  syncAdaptiveTeamRunProjectionAfterReview: (...args: any[]) => mockedSyncProjection(...args),
}));

const mockedFinalize = jest.fn();
const mockedCreateHistory = jest.fn();
const mockedCreatePanelHistory = jest.fn();
const mockedWriteEvent = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  finalizeAdaptiveHumanReviewPanel: (...args: any[]) => mockedFinalize(...args),
  createAdaptiveHumanReviewHistory: (...args: any[]) => mockedCreateHistory(...args),
  createAdaptivePanelFinalizationHistory: (...args: any[]) => mockedCreatePanelHistory(...args),
  writeAdaptivePanelFinalizationGovernanceEvent: (...args: any[]) => mockedWriteEvent(...args),
}));

const mockedWriteAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptivePanelFinalizationAdminAuditEvent: (...args: any[]) => mockedWriteAudit(...args),
}));

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {};
  },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "@/app/api/teams/adaptive-runs/[runId]/review-panel/finalize/route";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";

function team(overrides: Record<string, unknown> = {}) {
  return {
    id: TEAM_ID,
    name: "Test Team",
    members: [
      { uid: "owner-uid", email: "owner@test.com", role: "owner", joinedAt: "x" },
      { uid: "admin-uid", email: "admin@test.com", role: "admin", joinedAt: "x" },
      { uid: "member-uid", email: "member@test.com", role: "member", joinedAt: "x" },
    ],
    policyRules: [],
    settings: {},
    adaptiveMultiReviewerSettings: { enabled: true, mode: "majority_quorum" },
    ...overrides,
  };
}

function validProjection(overrides: Record<string, unknown> = {}) {
  return { projectionVersion: 1, adaptive: true, teamId: TEAM_ID, runId: RUN_ID, ...overrides };
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    submissionStatus: "finalized",
    panel: {
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: TEAM_ID,
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds: ["owner-uid", "admin-uid"],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "finalized",
      revision: 2,
      createdAt: "x",
      createdByUserId: "admin-uid",
      updatedAt: "2020-06-01T00:00:00.000Z",
      updatedByUserId: "owner-uid",
      finalizedAt: "2020-06-01T00:00:00.000Z",
      finalizedByUserId: "owner-uid",
      finalStatus: "approved",
      finalDecisionId: "panel_dec_abc123",
      aggregationPolicyVersion: 1,
    },
    humanReview: {
      status: "approved",
      reviewerId: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      decidedVia: "multi_reviewer_panel",
      panelRevision: 1,
      aggregationPolicyVersion: 1,
      supportingReviewerCount: 2,
    },
    priorHumanReviewStatus: "unreviewed",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    submittedCount: 2,
    ...overrides,
  };
}

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/review-panel/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callFinalize(body: unknown) {
  const res = await POST(buildRequest(body), { params: { runId: RUN_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = { expectedPanelRevision: 1, expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z" };

beforeEach(() => {
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedGetProjection.mockReset();
  mockedSyncProjection.mockReset();
  mockedFinalize.mockReset();
  mockedCreateHistory.mockReset();
  mockedCreatePanelHistory.mockReset();
  mockedWriteEvent.mockReset();
  mockedWriteAudit.mockReset();
  mockLoggerWarn.mockClear();

  mockedGetRequestUid.mockResolvedValue("owner-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "owner@test.com" }, team: team() });
  mockedMemberRole.mockReturnValue("owner");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedFinalize.mockResolvedValue(successResult());
  mockedCreateHistory.mockResolvedValue({ status: "recorded" });
  mockedCreatePanelHistory.mockResolvedValue({ status: "recorded" });
  mockedWriteEvent.mockResolvedValue({ status: "recorded" });
  mockedWriteAudit.mockResolvedValue({ status: "recorded" });
  mockedSyncProjection.mockResolvedValue({ status: "synced" });
});

describe("POST .../review-panel/finalize — authorization", () => {
  it("rejects an unauthenticated request", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const { res } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("rejects a caller with no team", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
    const { res } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it("rejects a plain member", async () => {
    mockedIsTeamAdmin.mockReturnValueOnce(false);
    const { res } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(403);
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("allows an owner", async () => {
    mockedMemberRole.mockReturnValueOnce("owner");
    const { res } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it("allows an admin (no owner-only restriction for ordinary finalization)", async () => {
    mockedGetRequestUid.mockResolvedValueOnce("admin-uid");
    mockedMemberRole.mockReturnValueOnce("admin");
    const { res } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it("hides a cross-team run behind projection_missing", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("Step 5.10 — finalize remains available even when team opt-in is disabled (a DRAIN operation on an already-ready panel, never new activity)", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({
      user: { email: "owner@test.com" },
      team: team({ adaptiveMultiReviewerSettings: { enabled: false, mode: "majority_quorum" } }),
    });
    const { res } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(200);
    expect(mockedFinalize).toHaveBeenCalled();
  });
});

describe("POST .../review-panel/finalize — request validation", () => {
  it("rejects a missing expectedPanelRevision", async () => {
    const { res } = await callFinalize({ expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(400);
    expect(mockedFinalize).not.toHaveBeenCalled();
  });

  it("rejects an invalid (non-positive) expectedPanelRevision", async () => {
    const { res } = await callFinalize({ expectedPanelRevision: 0, expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing expectedGovernanceUpdatedAt", async () => {
    const { res } = await callFinalize({ expectedPanelRevision: 1 });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid expectedGovernanceUpdatedAt timestamp", async () => {
    const { res } = await callFinalize({ expectedPanelRevision: 1, expectedGovernanceUpdatedAt: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("client-supplied finalStatus/actor/team/quorum/decisionId fields are ignored — only the two allowed fields ever reach the transaction call", async () => {
    await callFinalize({
      ...VALID_BODY,
      finalStatus: "approved",
      actorId: "attacker-uid",
      teamId: "attacker-team",
      quorum: 99,
      aggregationResult: "ready",
      finalDecisionId: "forged-id",
    });
    expect(mockedFinalize).toHaveBeenCalledWith({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
    });
  });
});

describe("POST .../review-panel/finalize — outcome mapping", () => {
  it("a ready panel finalizes successfully", async () => {
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.finalization.status).toBe("approved");
    expect(json.finalization.finalizedAt).toBe("2020-06-01T00:00:00.000Z");
    expect(json.panelRevision).toBe(2);
  });

  it("quorum_not_met maps to 409 with compact metadata only", async () => {
    mockedFinalize.mockResolvedValueOnce({ ok: false, reason: "quorum_not_met", submittedCount: 1, quorum: 2 });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("quorum_not_met");
    expect(json.submittedCount).toBe(1);
    expect(json.quorum).toBe(2);
    expect(json).not.toHaveProperty("votes");
  });

  it("panel_deadlocked maps to 409", async () => {
    mockedFinalize.mockResolvedValueOnce({ ok: false, reason: "panel_deadlocked" });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_deadlocked");
  });

  it("panel_stale maps to 409", async () => {
    mockedFinalize.mockResolvedValueOnce({ ok: false, reason: "panel_stale" });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_stale");
  });

  it("governance_stale maps to 409", async () => {
    mockedFinalize.mockResolvedValueOnce({ ok: false, reason: "governance_stale" });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("governance_stale");
  });

  it("panel_cancelled maps to 409", async () => {
    mockedFinalize.mockResolvedValueOnce({ ok: false, reason: "panel_cancelled" });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_cancelled");
  });

  it("inconsistent_finalization_state maps to 409", async () => {
    mockedFinalize.mockResolvedValueOnce({ ok: false, reason: "inconsistent_finalization_state" });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("inconsistent_finalization_state");
  });

  it("already_finalized (idempotent) still returns 200 success", async () => {
    mockedFinalize.mockResolvedValueOnce(successResult({ submissionStatus: "already_finalized" }));
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("never exposes a raw Firestore error or parser-internal reason", async () => {
    mockedFinalize.mockResolvedValueOnce({ ok: false, reason: "write_failed" });
    const { json } = await callFinalize(VALID_BODY);
    expect(JSON.stringify(json)).not.toContain("Firestore");
  });
});

describe("POST .../review-panel/finalize — secondary artifacts", () => {
  it("attempts history, panel history, event, audit, and projection sync after a successful finalization", async () => {
    await callFinalize(VALID_BODY);
    expect(mockedCreateHistory).toHaveBeenCalledTimes(1);
    expect(mockedCreatePanelHistory).toHaveBeenCalledTimes(1);
    expect(mockedWriteEvent).toHaveBeenCalledTimes(1);
    expect(mockedWriteAudit).toHaveBeenCalledTimes(1);
    expect(mockedSyncProjection).toHaveBeenCalledTimes(1);
  });

  it("a secondary artifact failure still returns HTTP 200 with the canonical success, reporting the failure compactly", async () => {
    mockedCreateHistory.mockResolvedValueOnce({ status: "failed" });
    mockedWriteAudit.mockResolvedValueOnce({ status: "failed" });
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.historyStatus).toBe("failed");
    expect(json.auditStatus).toBe("failed");
  });

  it("a secondary artifact throwing never surfaces as an HTTP error", async () => {
    mockedCreatePanelHistory.mockRejectedValueOnce(new Error("boom"));
    mockedWriteEvent.mockRejectedValueOnce(new Error("boom"));
    const { res, json } = await callFinalize(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("never exposes internal IDs (finalDecisionId, finalizedByUserId) in the public response", async () => {
    const { json } = await callFinalize(VALID_BODY);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("panel_dec_abc123");
    expect(serialized).not.toContain("finalizedByUserId");
  });
});
