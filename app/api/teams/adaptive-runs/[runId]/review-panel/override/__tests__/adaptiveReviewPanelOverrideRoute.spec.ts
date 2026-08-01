/**
 * Multi-Reviewer Owner Override, Part F —
 * POST /api/teams/adaptive-runs/[runId]/review-panel/override tests.
 */

const mockedGetRequestUid = jest.fn();
const mockedLoadUserAndTeam = jest.fn();
const mockedMemberRole = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: (...args: any[]) => mockedGetRequestUid(...args),
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
  memberRole: (...args: any[]) => mockedMemberRole(...args),
}));

const mockedGetProjection = jest.fn();
const mockedSyncProjection = jest.fn();
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: (...args: any[]) => mockedGetProjection(...args),
  syncAdaptiveTeamRunProjectionAfterReview: (...args: any[]) => mockedSyncProjection(...args),
}));

const mockedOverride = jest.fn();
const mockedCreateHistory = jest.fn();
const mockedCreatePanelHistory = jest.fn();
const mockedWriteEvent = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  overrideAdaptiveHumanReviewPanel: (...args: any[]) => mockedOverride(...args),
  createAdaptiveHumanReviewHistory: (...args: any[]) => mockedCreateHistory(...args),
  createAdaptivePanelOverrideHistory: (...args: any[]) => mockedCreatePanelHistory(...args),
  writeAdaptivePanelOverrideGovernanceEvent: (...args: any[]) => mockedWriteEvent(...args),
}));

const mockedWriteAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptivePanelOverrideAdminAuditEvent: (...args: any[]) => mockedWriteAudit(...args),
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
import { POST } from "@/app/api/teams/adaptive-runs/[runId]/review-panel/override/route";

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
    submissionStatus: "overridden",
    panel: {
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: TEAM_ID,
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds: ["r1", "r2"],
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
      finalDecisionId: "panel_override_dec_abc123",
      aggregationPolicyVersion: 1,
      finalizedVia: "owner_override",
      overrideJustificationPresent: true,
      overrideByUserId: "owner-uid",
    },
    humanReview: {
      status: "approved",
      reviewerId: "owner-uid",
      reviewedAt: "2020-06-01T00:00:00.000Z",
      decidedVia: "multi_reviewer_owner_override",
      panelRevision: 1,
      overrideJustification: "The panel deadlocked and a decision was required before the deadline.",
    },
    priorHumanReviewStatus: "unreviewed",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    ...overrides,
  };
}

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/review-panel/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callOverride(body: unknown) {
  const res = await POST(buildRequest(body), { params: { runId: RUN_ID } });
  const json = await res.json();
  return { res, json };
}

const VALID_BODY = {
  expectedPanelRevision: 1,
  expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
  status: "approved",
  justification: "The panel deadlocked and a decision was required before the deadline.",
};

beforeEach(() => {
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedGetProjection.mockReset();
  mockedSyncProjection.mockReset();
  mockedOverride.mockReset();
  mockedCreateHistory.mockReset();
  mockedCreatePanelHistory.mockReset();
  mockedWriteEvent.mockReset();
  mockedWriteAudit.mockReset();
  mockLoggerWarn.mockClear();

  mockedGetRequestUid.mockResolvedValue("owner-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "owner@test.com" }, team: team() });
  mockedMemberRole.mockReturnValue("owner");
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedOverride.mockResolvedValue(successResult());
  mockedCreateHistory.mockResolvedValue({ status: "recorded" });
  mockedCreatePanelHistory.mockResolvedValue({ status: "recorded" });
  mockedWriteEvent.mockResolvedValue({ status: "recorded" });
  mockedWriteAudit.mockResolvedValue({ status: "recorded" });
  mockedSyncProjection.mockResolvedValue({ status: "synced" });
});

describe("POST .../review-panel/override — authorization (owner-only)", () => {
  it("rejects an unauthenticated request", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const { res } = await callOverride(VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockedOverride).not.toHaveBeenCalled();
  });

  it("rejects a caller with no team", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
    const { res } = await callOverride(VALID_BODY);
    expect(res.status).toBe(403);
  });

  it("allows an owner", async () => {
    mockedMemberRole.mockReturnValueOnce("owner");
    const { res } = await callOverride(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it("REJECTS an admin — unlike ordinary finalization, override is owner-only", async () => {
    mockedGetRequestUid.mockResolvedValueOnce("admin-uid");
    mockedMemberRole.mockReturnValueOnce("admin");
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("insufficient_role");
    expect(mockedOverride).not.toHaveBeenCalled();
  });

  it("rejects a plain member", async () => {
    mockedMemberRole.mockReturnValueOnce("member");
    const { res } = await callOverride(VALID_BODY);
    expect(res.status).toBe(403);
    expect(mockedOverride).not.toHaveBeenCalled();
  });

  it("hides a cross-team run behind projection_missing", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
    expect(mockedOverride).not.toHaveBeenCalled();
  });

  it("Step 5.10 — override remains available even when team opt-in is disabled (a DRAIN operation on an already-open panel, never new activity)", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({
      user: { email: "owner@test.com" },
      team: team({ adaptiveMultiReviewerSettings: { enabled: false, mode: "majority_quorum" } }),
    });
    const { res } = await callOverride(VALID_BODY);
    expect(res.status).toBe(200);
    expect(mockedOverride).toHaveBeenCalled();
  });
});

describe("POST .../review-panel/override — request validation", () => {
  it("rejects a missing expectedPanelRevision", async () => {
    const { expectedPanelRevision, ...rest } = VALID_BODY as any;
    const { res } = await callOverride(rest);
    expect(res.status).toBe(400);
    expect(mockedOverride).not.toHaveBeenCalled();
  });

  it("rejects a missing justification", async () => {
    const { justification, ...rest } = VALID_BODY;
    const { res, json } = await callOverride(rest);
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("validation_error");
    expect(mockedOverride).not.toHaveBeenCalled();
  });

  it("rejects an empty-after-trim justification", async () => {
    const { res } = await callOverride({ ...VALID_BODY, justification: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid status", async () => {
    const { res } = await callOverride({ ...VALID_BODY, status: "pending" });
    expect(res.status).toBe(400);
  });

  it("rejects approved_with_conditions with no conditions", async () => {
    const { res } = await callOverride({ ...VALID_BODY, status: "approved_with_conditions" });
    expect(res.status).toBe(400);
  });

  it("rejects conditions on a plain approved override", async () => {
    const { res } = await callOverride({ ...VALID_BODY, conditions: ["x"] });
    expect(res.status).toBe(400);
  });

  it("accepts a valid approved_with_conditions override", async () => {
    const { res } = await callOverride({ ...VALID_BODY, status: "approved_with_conditions", conditions: ["fix X"] });
    expect(res.status).toBe(200);
  });

  it("client-supplied teamId/actor/finalDecisionId/quorum/aggregation fields are ignored — only the allowed fields ever reach the transaction call", async () => {
    await callOverride({
      ...VALID_BODY,
      teamId: "attacker-team",
      actorId: "attacker-uid",
      finalDecisionId: "forged-id",
      quorum: 99,
      aggregationResult: "ready",
      finalizedAt: "forged-time",
    });
    expect(mockedOverride).toHaveBeenCalledWith({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "owner-uid",
      expectedPanelRevision: 1,
      expectedGovernanceUpdatedAt: "2020-01-01T00:00:00.000Z",
      status: "approved",
      justification: VALID_BODY.justification,
      conditions: undefined,
    });
  });
});

describe("POST .../review-panel/override — outcome mapping", () => {
  it("an open panel is overridden successfully", async () => {
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.override.status).toBe("approved");
    expect(json.override.finalizedAt).toBe("2020-06-01T00:00:00.000Z");
    expect(json.panelRevision).toBe(2);
  });

  it("panel_already_finalized maps to 409", async () => {
    mockedOverride.mockResolvedValueOnce({ ok: false, reason: "panel_already_finalized" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_already_finalized");
  });

  it("panel_stale maps to 409", async () => {
    mockedOverride.mockResolvedValueOnce({ ok: false, reason: "panel_stale" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_stale");
  });

  it("governance_stale maps to 409", async () => {
    mockedOverride.mockResolvedValueOnce({ ok: false, reason: "governance_stale" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("governance_stale");
  });

  it("panel_cancelled maps to 409", async () => {
    mockedOverride.mockResolvedValueOnce({ ok: false, reason: "panel_cancelled" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_cancelled");
  });

  it("not_pending maps to 409", async () => {
    mockedOverride.mockResolvedValueOnce({ ok: false, reason: "not_pending" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("not_pending");
  });

  it("inconsistent_finalization_state maps to 409", async () => {
    mockedOverride.mockResolvedValueOnce({ ok: false, reason: "inconsistent_finalization_state" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("inconsistent_finalization_state");
  });

  it("already_overridden (idempotent retry) still returns 200 success", async () => {
    mockedOverride.mockResolvedValueOnce(successResult({ submissionStatus: "already_overridden" }));
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("never exposes a raw Firestore error or parser-internal reason", async () => {
    mockedOverride.mockResolvedValueOnce({ ok: false, reason: "write_failed" });
    const { json } = await callOverride(VALID_BODY);
    expect(JSON.stringify(json)).not.toContain("Firestore");
  });
});

describe("POST .../review-panel/override — secondary artifacts and privacy", () => {
  it("attempts history, panel history, event, audit, and projection sync after a successful override", async () => {
    await callOverride(VALID_BODY);
    expect(mockedCreateHistory).toHaveBeenCalledTimes(1);
    expect(mockedCreatePanelHistory).toHaveBeenCalledTimes(1);
    expect(mockedWriteEvent).toHaveBeenCalledTimes(1);
    expect(mockedWriteAudit).toHaveBeenCalledTimes(1);
    expect(mockedSyncProjection).toHaveBeenCalledTimes(1);
  });

  it("a secondary artifact failure still returns HTTP 200 with the canonical success, reporting the failure compactly", async () => {
    mockedCreateHistory.mockResolvedValueOnce({ status: "failed" });
    mockedWriteAudit.mockResolvedValueOnce({ status: "failed" });
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.historyStatus).toBe("failed");
    expect(json.auditStatus).toBe("failed");
  });

  it("a secondary artifact throwing never surfaces as an HTTP error", async () => {
    mockedCreatePanelHistory.mockRejectedValueOnce(new Error("boom"));
    mockedWriteEvent.mockRejectedValueOnce(new Error("boom"));
    const { res, json } = await callOverride(VALID_BODY);
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("never exposes the raw justification text, internal IDs, or actor UIDs in the public response", async () => {
    const { json } = await callOverride(VALID_BODY);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(VALID_BODY.justification);
    expect(serialized).not.toContain("panel_override_dec_abc123");
    expect(serialized).not.toContain("finalizedByUserId");
    expect(serialized).not.toContain("overrideByUserId");
  });
});
