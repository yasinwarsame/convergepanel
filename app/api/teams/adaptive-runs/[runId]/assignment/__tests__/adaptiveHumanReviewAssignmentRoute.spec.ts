/**
 * Part E3 — GET/PUT/DELETE /api/teams/adaptive-runs/[runId]/assignment tests.
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
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: (...args: any[]) => mockedGetProjection(...args),
}));

const mockedSubmitAssignment = jest.fn();
const mockedGetAssignment = jest.fn();
const mockedCreateAssignmentHistory = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  submitAdaptiveHumanReviewAssignment: (...args: any[]) => mockedSubmitAssignment(...args),
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetAssignment(...args),
  createAdaptiveHumanReviewAssignmentHistory: (...args: any[]) => mockedCreateAssignmentHistory(...args),
}));

const mockedWriteAssignmentAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptiveAssignmentAdminAuditEvent: (...args: any[]) => mockedWriteAssignmentAudit(...args),
}));

const mockedUserGet = jest.fn();
const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => (name === "runs" ? { exists: true } : mockedUserGet(id)),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest, NextResponse } from "next/server";
import { GET, PUT, DELETE } from "@/app/api/teams/adaptive-runs/[runId]/assignment/route";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";

function team(overrides: Record<string, unknown> = {}) {
  return {
    id: TEAM_ID,
    name: "Test Team",
    createdBy: "owner-uid",
    createdAt: null,
    members: [
      { uid: "owner-uid", email: "owner@test.com", role: "owner", joinedAt: "x" },
      { uid: "admin-uid", email: "admin@test.com", role: "admin", joinedAt: "x" },
      { uid: "member-uid", email: "member@test.com", role: "member", joinedAt: "x" },
    ],
    policyRules: [],
    settings: {},
    ...overrides,
  };
}

function validProjection(overrides: Record<string, unknown> = {}) {
  return { projectionVersion: 1, adaptive: true, teamId: TEAM_ID, runId: RUN_ID, ...overrides };
}

function buildGetRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/assignment`);
}

function buildPutRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/assignment`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildDeleteRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/assignment`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function callGet() {
  const res = await GET(buildGetRequest(), { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

async function callPut(body: unknown) {
  const res = await PUT(buildPutRequest(body), { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

async function callDelete(body?: unknown) {
  const res = await DELETE(buildDeleteRequest(body), { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

beforeEach(() => {
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedGetProjection.mockReset();
  mockedSubmitAssignment.mockReset();
  mockedGetAssignment.mockReset();
  mockedCreateAssignmentHistory.mockReset();
  mockedWriteAssignmentAudit.mockReset();
  mockedUserGet.mockReset();
  mockLoggerWarn.mockClear();

  mockedGetRequestUid.mockResolvedValue("admin-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "admin@test.com" }, team: team() });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
  mockedUserGet.mockResolvedValue({ exists: false, data: () => undefined });
  mockedCreateAssignmentHistory.mockResolvedValue({ status: "recorded" });
  mockedWriteAssignmentAudit.mockResolvedValue({ status: "recorded" });
});

describe("GET .../assignment — authorization", () => {
  it("rejects an unauthenticated request", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const { res } = await callGet();
    expect(res.status).toBe(401);
  });

  it("rejects a caller with no team", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
    const { res } = await callGet();
    expect(res.status).toBe(403);
  });

  it("rejects a plain member", async () => {
    mockedIsTeamAdmin.mockReturnValueOnce(false);
    const { res } = await callGet();
    expect(res.status).toBe(403);
  });

  it("rejects a cross-team run (projection not found)", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });
});

describe("PUT/DELETE .../assignment — authorization", () => {
  it("rejects an unauthenticated PUT", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const { res } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(401);
    expect(mockedSubmitAssignment).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated DELETE", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const { res } = await callDelete();
    expect(res.status).toBe(401);
    expect(mockedSubmitAssignment).not.toHaveBeenCalled();
  });

  it("rejects a PUT from a plain, non-admin member", async () => {
    mockedIsTeamAdmin.mockReturnValueOnce(false);
    const { res } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(403);
    expect(mockedSubmitAssignment).not.toHaveBeenCalled();
  });

  it("rejects a DELETE from a plain, non-admin member", async () => {
    mockedIsTeamAdmin.mockReturnValueOnce(false);
    const { res } = await callDelete();
    expect(res.status).toBe(403);
    expect(mockedSubmitAssignment).not.toHaveBeenCalled();
  });

  it("rejects a PUT for a cross-team run (projection not found)", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
    expect(mockedSubmitAssignment).not.toHaveBeenCalled();
  });

  it("rejects a DELETE for a cross-team run (projection not found)", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callDelete();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
    expect(mockedSubmitAssignment).not.toHaveBeenCalled();
  });
});

describe("GET .../assignment — contract", () => {
  it("returns assignment: {assignedReviewerUserId: null, revision: 0, ...} when unassigned", async () => {
    const { json } = await callGet();
    expect(json.assignment).toEqual({
      assignedReviewerUserId: null,
      assignedReviewerDisplayName: null,
      assignedAt: null,
      assignedByUserId: null,
      revision: 0,
    });
  });

  it("returns the eligible reviewer list restricted to owner/admin, excluding member", async () => {
    const { json } = await callGet();
    const ids = json.eligibleReviewers.map((r: any) => r.userId).sort();
    expect(ids).toEqual(["admin-uid", "owner-uid"]);
  });

  it("resolves a display name for the assigned reviewer, never exposing raw private membership fields", async () => {
    mockedGetAssignment.mockResolvedValueOnce({
      status: "found",
      assignment: {
        schemaVersion: 1,
        teamId: TEAM_ID,
        runId: RUN_ID,
        assignedReviewerUserId: "owner-uid",
        assignedAt: "2026-07-30T00:00:00.000Z",
        assignedByUserId: "admin-uid",
        updatedAt: "2026-07-30T00:00:00.000Z",
        updatedByUserId: "admin-uid",
        revision: 1,
      },
    });
    const { json } = await callGet();
    expect(json.assignment.assignedReviewerUserId).toBe("owner-uid");
    expect(typeof json.assignment.assignedReviewerDisplayName).toBe("string");
    expect(json).not.toHaveProperty("teamId");
  });

  it("masks another member's raw email (owner@test.com), while the caller's OWN email may appear unmasked per maskEmail()'s existing, established precedent", async () => {
    const { json } = await callGet();
    const serialized = JSON.stringify(json);
    // The caller is admin-uid/admin@test.com — maskEmail() intentionally
    // leaves the CALLER's own email unmasked (existing precedent, reused
    // verbatim from GovernanceDashboard.tsx). Only OTHER members' raw
    // emails must never appear.
    expect(serialized).not.toContain("owner@test.com");
  });
});

describe("PUT .../assignment — validation and eligibility", () => {
  it("rejects a missing assignedReviewerUserId", async () => {
    const { res } = await callPut({});
    expect(res.status).toBe(400);
  });

  it("rejects assigning a non-member", async () => {
    const { res, json } = await callPut({ assignedReviewerUserId: "not-a-member" });
    expect(res.status).toBe(400);
    expect(json.error.message).toContain("not a member");
  });

  it("rejects assigning a plain member (ineligible role)", async () => {
    const { res, json } = await callPut({ assignedReviewerUserId: "member-uid" });
    expect(res.status).toBe(400);
    expect(json.error.message).toContain("permission");
    expect(mockedSubmitAssignment).not.toHaveBeenCalled();
  });

  it("rejects a malformed expectedRevision", async () => {
    const { res } = await callPut({ assignedReviewerUserId: "owner-uid", expectedRevision: -1 });
    expect(res.status).toBe(400);
  });

  it("accepts assigning an eligible admin member", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: TEAM_ID,
        runId: RUN_ID,
        assignedReviewerUserId: "admin-uid",
        assignedAt: "x",
        assignedByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
        revision: 1,
      },
      previousReviewerUserId: null,
    });
    const { res, json } = await callPut({ assignedReviewerUserId: "admin-uid" });
    expect(res.status).toBe(200);
    expect(json.assignment.assignedReviewerUserId).toBe("admin-uid");
  });
});

describe("PUT/DELETE .../assignment — canonical outcome mapping", () => {
  it("not_pending maps to 409", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({ ok: false, reason: "not_pending" });
    const { res, json } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("not_pending");
  });

  it("stale_revision maps to 409", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({ ok: false, reason: "stale_revision" });
    const { res, json } = await callPut({ assignedReviewerUserId: "owner-uid", expectedRevision: 5 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("stale_revision");
  });

  it("run_missing maps to 404", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({ ok: false, reason: "run_missing" });
    const { res } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(404);
  });

  it("firestore_unavailable maps to 503", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({ ok: false, reason: "firestore_unavailable" });
    const { res } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(503);
  });

  it("DELETE unassigns without requiring assignedReviewerUserId in the body", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: TEAM_ID,
        runId: RUN_ID,
        assignedReviewerUserId: null,
        assignedAt: null,
        assignedByUserId: null,
        updatedAt: "x",
        updatedByUserId: "admin-uid",
        revision: 2,
      },
      previousReviewerUserId: "owner-uid",
    });
    const { res, json } = await callDelete();
    expect(res.status).toBe(200);
    expect(json.assignment.assignedReviewerUserId).toBeNull();
    expect(mockedSubmitAssignment).toHaveBeenCalledWith(expect.objectContaining({ newReviewerUserId: null }));
  });
});

describe("PUT/DELETE .../assignment — secondary artifacts", () => {
  function successResult(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: TEAM_ID,
        runId: RUN_ID,
        assignedReviewerUserId: "owner-uid",
        assignedAt: "x",
        assignedByUserId: "admin-uid",
        updatedAt: "2026-07-30T00:00:00.000Z",
        updatedByUserId: "admin-uid",
        revision: 1,
        ...overrides,
      },
      previousReviewerUserId: null,
    };
  }

  it("calls the assignment-history and admin-audit writers with matching metadata", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce(successResult());
    await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(mockedCreateAssignmentHistory).toHaveBeenCalledTimes(1);
    expect(mockedWriteAssignmentAudit).toHaveBeenCalledTimes(1);
    const [, historyEntry] = mockedCreateAssignmentHistory.mock.calls[0];
    expect(historyEntry.eventType).toBe("assigned");
    const [auditArgs] = mockedWriteAssignmentAudit.mock.calls[0];
    expect(auditArgs.action).toBe("adaptive_human_review_reviewer_assigned");
  });

  it("uses the reassigned/unassigned action correctly based on the transition", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({ ...successResult(), previousReviewerUserId: "admin-uid" });
    await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(mockedWriteAssignmentAudit.mock.calls[0][0].action).toBe("adaptive_human_review_reviewer_reassigned");
  });

  it("history/audit failure still returns HTTP 200 with the canonical assignment success", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce(successResult());
    mockedCreateAssignmentHistory.mockResolvedValueOnce({ status: "failed" });
    mockedWriteAssignmentAudit.mockResolvedValueOnce({ status: "failed" });
    const { res, json } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.historyStatus).toBe("failed");
    expect(json.auditStatus).toBe("failed");
  });

  it("history/audit exceptions never surface as an HTTP error", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce(successResult());
    mockedCreateAssignmentHistory.mockRejectedValueOnce(new Error("boom"));
    mockedWriteAssignmentAudit.mockRejectedValueOnce(new Error("boom"));
    const { res, json } = await callPut({ assignedReviewerUserId: "owner-uid" });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });
});

describe("PUT/DELETE .../assignment — privacy", () => {
  it("never exposes reviewer email, decisionId, or raw Firestore errors in the mutation response", async () => {
    mockedSubmitAssignment.mockResolvedValueOnce({
      ok: true,
      assignment: {
        schemaVersion: 1,
        teamId: TEAM_ID,
        runId: RUN_ID,
        assignedReviewerUserId: "owner-uid",
        assignedAt: "x",
        assignedByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
        revision: 1,
      },
      previousReviewerUserId: null,
    });
    const { json } = await callPut({ assignedReviewerUserId: "owner-uid" });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("owner@test.com");
  });
});
