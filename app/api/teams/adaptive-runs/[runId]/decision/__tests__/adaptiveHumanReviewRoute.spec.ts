/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part D —
 * POST /api/teams/adaptive-runs/[runId]/decision route wiring tests.
 *
 * `parseGovernanceRecord` and `parseAdaptiveReviewDecisionRequest` are left
 * REAL (pure, already independently unit-tested) so this file proves
 * genuine end-to-end wiring — does the route's own auth/lookup/dispatch
 * logic correctly connect real validation to the (mocked) persistence
 * layer — rather than just asserting a mock was called.
 */

import { NextRequest, NextResponse } from "next/server";

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

const mockedSubmitReview = jest.fn();
const mockedWriteEvent = jest.fn();
const mockedCreateHistory = jest.fn();
const mockedGetAssignment = jest.fn().mockResolvedValue({ status: "unassigned" });
const mockedGetPanel = jest.fn().mockResolvedValue({ status: "absent" });
jest.mock("@/lib/firestore/runs", () => ({
  submitAdaptiveHumanReview: (...args: any[]) => mockedSubmitReview(...args),
  writeAdaptiveHumanReviewEvent: (...args: any[]) => mockedWriteEvent(...args),
  createAdaptiveHumanReviewHistory: (...args: any[]) => mockedCreateHistory(...args),
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetAssignment(...args),
  getAdaptiveHumanReviewPanel: (...args: any[]) => mockedGetPanel(...args),
}));

const mockedWriteAdaptiveAdminAuditEvent = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptiveAdminAuditEvent: (...args: any[]) => mockedWriteAdaptiveAdminAuditEvent(...args),
}));

const mockedRunGet = jest.fn();
const mockedUserGet = jest.fn();
const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => (name === "runs" ? mockedRunGet(id) : mockedUserGet(id)),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: (...args: unknown[]) => mockLoggerInfo(...args), error: jest.fn(), debug: jest.fn() },
}));

import { POST } from "@/app/api/teams/adaptive-runs/[runId]/decision/route";

const RUN_ID = "run-abc123";
const TEAM_ID = "team_abc12345_1700000000000";
const VALID_UPDATED_AT = "2026-07-29T00:00:00.000Z";

function team(overrides: Record<string, unknown> = {}) {
  return { id: TEAM_ID, name: "Test Team", createdBy: "owner-uid", createdAt: null, members: [], policyRules: [], settings: {}, ...overrides };
}

function validGovernanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    automatedGovernance: { status: "flagged", reasons: ["2 model(s) failed"], evaluatedAt: VALID_UPDATED_AT, policyVersion: 3 },
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "The panel recommends option A.",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: VALID_UPDATED_AT,
    ...overrides,
  };
}

function validProjection(overrides: Record<string, unknown> = {}) {
  return { adaptive: true, teamId: TEAM_ID, runId: RUN_ID, ...overrides };
}

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callRoute(body: unknown) {
  const response = await POST(buildRequest(body), { params: { runId: RUN_ID } });
  const json = await response.json();
  return { response, json };
}

function setupHappyPath(overrides: { submitResult?: any; syncResult?: any; eventResult?: any; historyResult?: any; auditResult?: any } = {}) {
  mockedGetRequestUid.mockResolvedValue("reviewer-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { name: "Reviewer Name", email: "reviewer@test.com" }, team: team() });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ governanceRecord: validGovernanceRecord(), userId: "owner-uid" }) });
  mockedUserGet.mockResolvedValue({ exists: true, data: () => ({ teamId: TEAM_ID }) });
  mockedSubmitReview.mockResolvedValue(
    overrides.submitResult ?? {
      ok: true,
      record: { ...validGovernanceRecord(), humanReview: { status: "approved", reviewerId: "reviewer-uid", reviewedAt: "2026-07-30T00:00:00.000Z" } },
      priorHumanReviewStatus: "unreviewed",
    }
  );
  mockedSyncProjection.mockResolvedValue(overrides.syncResult ?? { status: "synced" });
  mockedWriteEvent.mockResolvedValue(overrides.eventResult ?? { written: true });
  mockedCreateHistory.mockResolvedValue(overrides.historyResult ?? { status: "recorded" });
  mockedWriteAdaptiveAdminAuditEvent.mockResolvedValue(overrides.auditResult ?? { status: "recorded" });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("POST /api/teams/adaptive-runs/[runId]/decision", () => {
  describe("authorization", () => {
    it("rejects an unauthenticated request", async () => {
      mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(401);
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("rejects a caller with no team", async () => {
      setupHappyPath();
      mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(403);
      expect(json.error.code).toBe("forbidden");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("rejects a plain member (non-admin)", async () => {
      setupHappyPath();
      mockedMemberRole.mockReturnValueOnce("member");
      mockedIsTeamAdmin.mockReturnValueOnce(false);
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(403);
      expect(json.error.code).toBe("insufficient_role");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("allows an owner", async () => {
      setupHappyPath();
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });

    it("allows an admin", async () => {
      setupHappyPath();
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });

    it("rejects when no adaptive projection exists at the deterministic ID", async () => {
      setupHappyPath();
      mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(404);
      expect(json.error.code).toBe("projection_missing");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("rejects a projection whose stored teamId does not match the caller's team", async () => {
      setupHappyPath();
      mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ teamId: "some-other-team" }) });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(404);
      expect(json.error.code).toBe("projection_invalid");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("rejects a malformed projection (adaptive discriminator not true)", async () => {
      setupHappyPath();
      mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ adaptive: false }) });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(404);
      expect(json.error.code).toBe("projection_invalid");
    });

    it("rejects a projection whose stored runId does not match the route's runId", async () => {
      setupHappyPath();
      mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ runId: "different-run" }) });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(404);
      expect(json.error.code).toBe("projection_invalid");
    });

    it("rejects when the parent run is missing", async () => {
      setupHappyPath();
      mockedRunGet.mockResolvedValueOnce({ exists: false });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(404);
      expect(json.error.code).toBe("not_found");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("never trusts a client-supplied reviewerId — the server-derived uid is always used", async () => {
      setupHappyPath();
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT, reviewerId: "attacker-controlled-uid" });
      const [submitArgs] = mockedSubmitReview.mock.calls[0];
      expect(submitArgs.reviewerId).toBe("reviewer-uid");
    });

    it("never trusts a client-supplied teamId — the server-resolved team is always used", async () => {
      setupHappyPath();
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT, teamId: "attacker-supplied-team" });
      expect(mockedGetProjection).toHaveBeenCalledWith(TEAM_ID, RUN_ID);
      const [syncArgs] = mockedSyncProjection.mock.calls[0];
      expect(syncArgs.teamId).toBe(TEAM_ID);
    });
  });

  describe("request validation", () => {
    it("rejects an invalid body with 400", async () => {
      setupHappyPath();
      const { response, json } = await callRoute({ status: "unreviewed", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(400);
      expect(json.error.code).toBe("validation_error");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("rejects invalid JSON with 400", async () => {
      setupHappyPath();
      const req = new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const response = await POST(req, { params: { runId: RUN_ID } });
      expect(response.status).toBe(400);
    });
  });

  describe("transactional outcome mapping", () => {
    it("stale_expected_updated_at maps to 409", async () => {
      setupHappyPath({ submitResult: { ok: false, reason: "stale_expected_updated_at" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(409);
      expect(json.error.code).toBe("stale_expected_updated_at");
    });

    it("terminal_review_exists maps to 409", async () => {
      setupHappyPath({ submitResult: { ok: false, reason: "terminal_review_exists" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(409);
      expect(json.error.code).toBe("terminal_review_exists");
    });

    it("run_missing (from the transaction itself) maps to 404", async () => {
      setupHappyPath({ submitResult: { ok: false, reason: "run_missing" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(404);
      expect(json.error.code).toBe("not_found");
    });

    it("governance_record_malformed maps to 500 without exposing parser detail", async () => {
      setupHappyPath({ submitResult: { ok: false, reason: "governance_record_malformed" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(500);
      expect(JSON.stringify(json)).not.toContain("malformed");
    });

    it("firestore_unavailable maps to 500", async () => {
      setupHappyPath({ submitResult: { ok: false, reason: "firestore_unavailable" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(500);
      expect(json.error.code).toBe("internal_error");
    });
  });

  describe("canonical-success semantics", () => {
    it("projection sync failure still returns HTTP 200 with projectionSyncStatus 'failed'", async () => {
      setupHappyPath({ syncResult: { status: "write_failed" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.projectionSyncStatus).toBe("failed");
    });

    it("projection sync 'not_found' still returns HTTP 200 with projectionSyncStatus 'failed'", async () => {
      setupHappyPath({ syncResult: { status: "not_found" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
      expect(json.projectionSyncStatus).toBe("failed");
    });

    it("a governance-event write failure still returns HTTP 200 with ok:true", async () => {
      setupHappyPath({ eventResult: { written: false, reason: "write_failed" } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
    });

    it("a governance-event write throwing still returns HTTP 200 with ok:true", async () => {
      setupHappyPath();
      mockedWriteEvent.mockRejectedValueOnce(new Error("boom"));
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
    });

    it("never returns HTTP 500 once the canonical transaction has committed", async () => {
      setupHappyPath({ syncResult: { status: "write_failed" }, eventResult: { written: false, reason: "write_failed" } });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });
  });

  describe("response contract", () => {
    it("returns a compact success response with no reviewerId/teamId/projectionId/comment/conditions/governanceRecord", async () => {
      setupHappyPath();
      const { json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(json).toEqual({
        ok: true,
        review: { status: "approved", reviewedAt: "2026-07-30T00:00:00.000Z" },
        projectionSyncStatus: "synced",
        historyStatus: "recorded",
        auditStatus: "recorded",
      });
    });

    it("never exposes raw Firestore errors", async () => {
      setupHappyPath({ submitResult: { ok: false, reason: "write_failed" } });
      const { json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(JSON.stringify(json)).not.toContain("write_failed");
    });
  });

  describe("ordering and isolation", () => {
    it("calls submitAdaptiveHumanReview before syncAdaptiveTeamRunProjectionAfterReview and writeAdaptiveHumanReviewEvent", async () => {
      setupHappyPath();
      const callOrder: string[] = [];
      mockedSubmitReview.mockImplementationOnce(async () => {
        callOrder.push("submit");
        return {
          ok: true,
          record: { ...validGovernanceRecord(), humanReview: { status: "approved", reviewedAt: "2026-07-30T00:00:00.000Z" } },
          priorHumanReviewStatus: "unreviewed",
        };
      });
      mockedSyncProjection.mockImplementationOnce(async () => {
        callOrder.push("sync");
        return { status: "synced" };
      });
      mockedWriteEvent.mockImplementationOnce(async () => {
        callOrder.push("event");
        return { written: true };
      });

      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(callOrder).toEqual(["submit", "sync", "event"]);
    });

    it("does not call submitAdaptiveHumanReview, syncAdaptiveTeamRunProjectionAfterReview, or writeAdaptiveHumanReviewEvent when authorization fails", async () => {
      setupHappyPath();
      mockedIsTeamAdmin.mockReturnValueOnce(false);
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(mockedSubmitReview).not.toHaveBeenCalled();
      expect(mockedSyncProjection).not.toHaveBeenCalled();
      expect(mockedWriteEvent).not.toHaveBeenCalled();
    });

    it("calls each downstream function exactly once on a successful decision", async () => {
      setupHappyPath();
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(mockedSubmitReview).toHaveBeenCalledTimes(1);
      expect(mockedSyncProjection).toHaveBeenCalledTimes(1);
      expect(mockedWriteEvent).toHaveBeenCalledTimes(1);
    });

    it("passes only status/comment/conditions in the update object to submitAdaptiveHumanReview — never reviewerId/reviewerName/reviewedAt", async () => {
      setupHappyPath();
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      const [submitArgs] = mockedSubmitReview.mock.calls[0];
      expect(Object.keys(submitArgs.update).sort()).toEqual(["comment", "conditions", "status"].sort());
    });
  });

  describe("Part E3 — reviewer-assignment submission restriction", () => {
    it("unassigned run: preserves all existing submission behavior (no restriction)", async () => {
      setupHappyPath();
      mockedGetAssignment.mockResolvedValueOnce({ status: "unassigned" });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });

    it("the assigned reviewer (who is also an admin) may submit", async () => {
      setupHappyPath();
      mockedGetRequestUid.mockResolvedValueOnce("reviewer-uid");
      mockedGetAssignment.mockResolvedValueOnce({
        status: "found",
        assignment: { assignedReviewerUserId: "reviewer-uid", assignedAt: "x", assignedByUserId: "admin-uid", revision: 1 },
      });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });

    it("a non-assigned admin without override permission is rejected with 403, not 404", async () => {
      setupHappyPath();
      mockedGetRequestUid.mockResolvedValueOnce("some-other-admin-uid");
      mockedMemberRole.mockReturnValueOnce("admin");
      mockedGetAssignment.mockResolvedValueOnce({
        status: "found",
        assignment: { assignedReviewerUserId: "reviewer-uid", assignedAt: "x", assignedByUserId: "admin-uid", revision: 1 },
      });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(403);
      expect(json.error.code).toBe("reviewer_assigned");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("the team owner may submit as an administrative override, even when not the assigned reviewer", async () => {
      setupHappyPath();
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedGetAssignment.mockResolvedValueOnce({
        status: "found",
        assignment: { assignedReviewerUserId: "reviewer-uid", assignedAt: "x", assignedByUserId: "admin-uid", revision: 1 },
      });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });

    it("a plain (non-owner) admin override is never granted merely by role — assignment restriction still applies to admins", async () => {
      setupHappyPath();
      mockedGetRequestUid.mockResolvedValueOnce("another-admin-uid");
      mockedMemberRole.mockReturnValueOnce("admin");
      mockedGetAssignment.mockResolvedValueOnce({
        status: "found",
        assignment: { assignedReviewerUserId: "reviewer-uid", assignedAt: "x", assignedByUserId: "admin-uid", revision: 1 },
      });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(403);
    });

    it("assignment never grants submission permission by itself — the assigned user must still independently pass isTeamAdmin", async () => {
      setupHappyPath();
      mockedGetRequestUid.mockResolvedValueOnce("reviewer-uid");
      mockedIsTeamAdmin.mockReturnValueOnce(false); // the assigned reviewer no longer passes the baseline gate (e.g. demoted)
      mockedGetAssignment.mockResolvedValueOnce({
        status: "found",
        assignment: { assignedReviewerUserId: "reviewer-uid", assignedAt: "x", assignedByUserId: "admin-uid", revision: 1 },
      });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(403);
      expect(mockedGetAssignment).not.toHaveBeenCalled(); // never even reached — baseline gate rejects first
    });

    it("an assignment-lookup failure fails open (does not block a legitimate submission) — a deliberate, documented choice", async () => {
      setupHappyPath();
      mockedGetAssignment.mockResolvedValueOnce({ status: "firestore_unavailable" });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });
  });

  describe("Multi-Reviewer Panel Foundation, Part B — panel-presence gate (coexistence)", () => {
    it("no panel (absent) → the exact current single-review path proceeds unchanged", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "absent" });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(mockedSubmitReview).toHaveBeenCalledTimes(1);
    });

    it("absent panel + an existing single-reviewer assignment → assignment rules are entirely unaffected", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "absent" });
      mockedGetAssignment.mockResolvedValueOnce({
        status: "found",
        assignment: { assignedReviewerUserId: "reviewer-uid", assignedAt: "x", assignedByUserId: "admin-uid", revision: 1 },
      });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
    });

    it("an OPEN panel blocks the direct decision route with 409 adaptive_review_panel_active", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "found", panel: { status: "open", revision: 1 } });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(409);
      expect(json.error.code).toBe("adaptive_review_panel_active");
    });

    it("an open panel never calls the canonical review transaction", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "found", panel: { status: "open", revision: 1 } });
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("an open panel never writes history, never syncs the projection, never emits a decision event or admin audit", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "found", panel: { status: "open", revision: 1 } });
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(mockedCreateHistory).not.toHaveBeenCalled();
      expect(mockedSyncProjection).not.toHaveBeenCalled();
      expect(mockedWriteEvent).not.toHaveBeenCalled();
      expect(mockedWriteAdaptiveAdminAuditEvent).not.toHaveBeenCalled();
    });

    it("an open panel is checked BEFORE the single-reviewer assignment lookup — the assignment check is never even reached", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "found", panel: { status: "open", revision: 1 } });
      await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(mockedGetAssignment).not.toHaveBeenCalled();
    });

    it("a CANCELLED panel follows the approved coexistence rule — the single-reviewer path proceeds exactly as if no panel existed", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "found", panel: { status: "cancelled", revision: 2 } });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(200);
      expect(mockedSubmitReview).toHaveBeenCalledTimes(1);
    });

    it("existing single-reviewer assignment is restored as the active path once a panel is cancelled", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "found", panel: { status: "cancelled", revision: 2 } });
      mockedGetRequestUid.mockResolvedValueOnce("some-other-admin-uid");
      mockedGetAssignment.mockResolvedValueOnce({
        status: "found",
        assignment: { assignedReviewerUserId: "reviewer-uid", assignedAt: "x", assignedByUserId: "admin-uid", revision: 1 },
      });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(403); // the (still-active, restored) single assignment correctly blocks a non-assigned caller
      expect(json.error.code).toBe("reviewer_assigned");
    });

    it("a malformed stored panel fails CLOSED — never silently falls back to single-reviewer behavior", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "malformed" });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(409);
      expect(json.error.code).toBe("adaptive_review_panel_invalid");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("an unsupported-version stored panel fails CLOSED", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "unsupported_version" });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(409);
      expect(json.error.code).toBe("adaptive_review_panel_invalid");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    /**
     * CRITICAL, deliberate asymmetry (§30's own non-negotiable): the
     * single-reviewer ASSIGNMENT lookup fails OPEN on a read failure
     * (tested above — "an assignment-lookup failure fails open"). The
     * PANEL lookup must fail CLOSED instead — an infrastructure failure
     * here must never silently let a direct decision bypass an active
     * panel's governance. This is the one place these two gates are
     * REQUIRED to behave oppositely; both behaviors are tested explicitly,
     * side by side, so a future refactor that accidentally unifies them
     * is caught immediately.
     */
    it("a panel-lookup failure (firestore_unavailable) fails CLOSED — 503, decision blocked, opposite of the assignment lookup's fail-open behavior", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "firestore_unavailable" });
      const { response, json } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(503);
      expect(json.error.code).toBe("adaptive_review_panel_unavailable");
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });

    it("a panel-lookup failure (read_failed) also fails CLOSED", async () => {
      setupHappyPath();
      mockedGetPanel.mockResolvedValueOnce({ status: "read_failed" });
      const { response } = await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT });
      expect(response.status).toBe(503);
      expect(mockedSubmitReview).not.toHaveBeenCalled();
    });
  });
});
