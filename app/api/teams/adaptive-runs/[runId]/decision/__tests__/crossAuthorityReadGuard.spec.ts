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


/**
 * PHASE 1 CROSS-AUTHORITY READ GUARD — residual Finding A.
 *
 * This route's panel-presence gate and single-reviewer assignment check USED to
 * run before the projection lookup and before the Workspace-domain guard, which
 * made an otherwise-blocked mutation endpoint an information ORACLE: an
 * authenticated admin of ANY legacy team could probe an arbitrary run id and
 * distinguish "panel open" (409 `adaptive_review_panel_active`) from "no panel",
 * and "reviewer assigned" (403 `reviewer_assigned`) from "unassigned" — for runs
 * belonging to other teams and to Workspaces they hold no capability in.
 * `evaluateAdaptiveReviewPanelGate()` also calls `getAdaptiveHumanReviewPanel()`
 * with NO teamId, so the panel's own team binding is never validated; the only
 * thing standing between the caller and that document is where the reads sit.
 *
 * Each case below asserts BOTH that the denial is the route's own concealed
 * not-found AND that neither canonical document was fetched on the way to it. A
 * route that reads the panel and its assignment and only then normalises the
 * response has not closed the disclosure.
 */
describe("POST decision — Workspace-bound run is refused before any canonical review read", () => {
  beforeEach(() => {
    setupHappyPath();
    // A real open panel and a real assignment exist — the oracle's payload.
    mockedGetPanel.mockResolvedValue({
      status: "found",
      panel: { schemaVersion: 1, kind: "adaptive_review_panel", teamId: TEAM_ID, runId: RUN_ID, mode: "majority_quorum", reviewerUserIds: ["a", "b"], requiredReviewerCount: 2, quorum: 2, status: "open", revision: 1, createdAt: "x", createdByUserId: "x", updatedAt: "x", updatedByUserId: "x" },
    });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: { assignedReviewerUserId: "someone-else", assignedAt: "x", assignedByUserId: "x", revision: 1 },
    });
  });

  it.each([
    ["a Team Workspace", { workspaceId: "ws-team-1" }],
    ["its owner's Personal Workspace", { workspaceId: "personal-owner-uid" }],
    ["a malformed binding", { workspaceId: 12345 }],
  ])("conceals a run bound to %s, and fetches neither panel nor assignment", async (_label, binding) => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ governanceRecord: validGovernanceRecord(), userId: "owner-uid", ...(binding as Record<string, unknown>) }),
    });

    const res = await POST(buildRequest({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT }), { params: { runId: RUN_ID } });
    const json = await res.json();

    // Byte-identical to a genuinely absent run: no Workspace named, no panel
    // state revealed, no distinct status that would separate the two cases.
    expect({ status: res.status, json }).toEqual({
      status: 404,
      json: { ok: false, error: { code: "not_found", message: "Run not found." } },
    });
    expect(mockedGetPanel).not.toHaveBeenCalled();
    expect(mockedGetAssignment).not.toHaveBeenCalled();
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it("does not become an oracle for a run belonging to another team either", async () => {
    // No projection for this caller's team: the deterministic lookup now runs
    // BEFORE the panel read, so an unrelated team's admin learns nothing about
    // the panel's existence.
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });

    const res = await POST(buildRequest({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT }), { params: { runId: RUN_ID } });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
    expect(mockedGetPanel).not.toHaveBeenCalled();
    expect(mockedGetAssignment).not.toHaveBeenCalled();
  });

  it("CONTROL — a genuinely legacy run still reaches the panel gate", async () => {
    // Without this, a route that refused everything would satisfy the above.
    const res = await POST(buildRequest({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT }), { params: { runId: RUN_ID } });
    expect(mockedGetPanel).toHaveBeenCalled();
    // The open panel legitimately blocks a direct decision for a legacy run.
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("adaptive_review_panel_active");
  });

  it("CONTROL — a genuinely legacy run with no panel reaches the assignment check", async () => {
    mockedGetPanel.mockResolvedValue({ status: "absent" });
    const res = await POST(buildRequest({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT }), { params: { runId: RUN_ID } });
    expect(mockedGetAssignment).toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("reviewer_assigned");
  });
});
