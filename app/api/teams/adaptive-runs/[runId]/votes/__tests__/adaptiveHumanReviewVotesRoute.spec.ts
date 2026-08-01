/**
 * Immutable Multi-Reviewer Vote Contract and Submission, Part C —
 * POST/GET /api/teams/adaptive-runs/[runId]/votes tests.
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

const mockedGetPanel = jest.fn();
const mockedGetVote = jest.fn();
const mockedSubmitVote = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewPanel: (...args: any[]) => mockedGetPanel(...args),
  getAdaptiveHumanReviewVote: (...args: any[]) => mockedGetVote(...args),
  submitAdaptiveHumanReviewVote: (...args: any[]) => mockedSubmitVote(...args),
}));

const mockedUserGet = jest.fn();
let runData: Record<string, unknown>;
const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => (name === "runs" ? { exists: true, data: () => runData } : mockedUserGet(id)),
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
import { POST, GET } from "@/app/api/teams/adaptive-runs/[runId]/votes/route";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";
const REVIEWER_A = "reviewer-a-uid";
const REVIEWER_B = "reviewer-b-uid";

function governanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "x",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function team(overrides: Record<string, unknown> = {}) {
  return {
    id: TEAM_ID,
    name: "Test Team",
    createdBy: "owner-uid",
    createdAt: null,
    members: [
      { uid: REVIEWER_A, email: "a@test.com", role: "admin", joinedAt: "x" },
      { uid: REVIEWER_B, email: "b@test.com", role: "owner", joinedAt: "x" },
      { uid: "member-uid", email: "member@test.com", role: "member", joinedAt: "x" },
    ],
    policyRules: [],
    settings: {},
    adaptiveMultiReviewerSettings: { enabled: true, mode: "majority_quorum" },
    ...overrides,
  };
}

function foundPanel(overrides: Record<string, unknown> = {}) {
  return {
    status: "found",
    panel: {
      schemaVersion: 1,
      kind: "adaptive_review_panel",
      teamId: TEAM_ID,
      runId: RUN_ID,
      mode: "majority_quorum",
      reviewerUserIds: [REVIEWER_A, REVIEWER_B],
      requiredReviewerCount: 2,
      quorum: 2,
      status: "open",
      revision: 1,
      createdAt: "x",
      createdByUserId: "admin-uid",
      updatedAt: "x",
      updatedByUserId: "admin-uid",
      ...overrides,
    },
  };
}

function validProjection(overrides: Record<string, unknown> = {}) {
  return { projectionVersion: 1, adaptive: true, teamId: TEAM_ID, runId: RUN_ID, ...overrides };
}

function buildPostRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/votes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function buildGetRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/votes`);
}

async function callPost(body: unknown) {
  const res = await POST(buildPostRequest(body), { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}
async function callGet() {
  const res = await GET(buildGetRequest(), { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

beforeEach(() => {
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedGetProjection.mockReset();
  mockedGetPanel.mockReset();
  mockedGetVote.mockReset();
  mockedSubmitVote.mockReset();
  mockedUserGet.mockReset();
  mockLoggerWarn.mockClear();

  runData = { governanceRecord: governanceRecord() };
  mockedGetRequestUid.mockResolvedValue(REVIEWER_A);
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "a@test.com" }, team: team() });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedGetPanel.mockResolvedValue(foundPanel());
  mockedGetVote.mockResolvedValue({ status: "absent" });
  mockedUserGet.mockResolvedValue({ exists: false, data: () => undefined });
});

describe("POST .../votes — authorization and preconditions", () => {
  it("rejects an unauthenticated request", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const { res } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(401);
    expect(mockedSubmitVote).not.toHaveBeenCalled();
  });

  it("rejects a caller with no team", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
    const { res } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(403);
  });

  it("hides a cross-team run behind projection_missing", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });

  it("rejects when the review is no longer pending", async () => {
    runData = { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) };
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("not_pending");
    expect(mockedSubmitVote).not.toHaveBeenCalled();
  });

  it("rejects an invalid vote body (validation error)", async () => {
    const { res } = await callPost({ panelRevision: 1, status: "approved", conditions: ["x"] }); // approved forbids conditions
    expect(res.status).toBe(400);
    expect(mockedSubmitVote).not.toHaveBeenCalled();
  });

  it("rejects when no panel exists", async () => {
    mockedGetPanel.mockResolvedValueOnce({ status: "absent" });
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("panel_absent");
  });

  it("rejects when the panel is malformed", async () => {
    mockedGetPanel.mockResolvedValueOnce({ status: "malformed" });
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("adaptive_review_panel_invalid");
  });

  it("rejects when the panel is cancelled", async () => {
    mockedGetPanel.mockResolvedValueOnce(foundPanel({ status: "cancelled" }));
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_cancelled");
  });

  it("rejects a stale panelRevision", async () => {
    mockedGetPanel.mockResolvedValueOnce(foundPanel({ revision: 3 }));
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_stale");
  });

  it("rejects a caller not listed on the panel", async () => {
    mockedGetRequestUid.mockResolvedValueOnce("uninvolved-admin-uid");
    mockedLoadUserAndTeam.mockResolvedValueOnce({
      user: { email: "z@test.com" },
      team: team({ members: [...team().members, { uid: "uninvolved-admin-uid", email: "z@test.com", role: "admin", joinedAt: "x" }] }),
    });
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("reviewer_not_assigned");
    expect(mockedSubmitVote).not.toHaveBeenCalled();
  });

  it("does not require isTeamAdmin as a standalone gate — panel membership + eligibility is the authority", async () => {
    // Even with mockedIsTeamAdmin never consulted for POST at all (it's
    // simply not called anywhere in the POST handler), a listed, eligible
    // reviewer can still vote.
    mockedSubmitVote.mockResolvedValueOnce({
      ok: true,
      submissionStatus: "submitted",
      vote: { status: "approved", submittedAt: "x", commentPresent: false, conditionsCount: 0 },
    });
    const { res } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(200);
    expect(mockedIsTeamAdmin).not.toHaveBeenCalled();
  });
});

describe("POST .../votes — success and outcome mapping", () => {
  it("submits successfully and returns the caller's own vote in full", async () => {
    mockedSubmitVote.mockResolvedValueOnce({
      ok: true,
      submissionStatus: "submitted",
      vote: { status: "rejected", submittedAt: "2026-07-31T00:00:00.000Z", commentPresent: true, conditionsCount: 0, comment: "not acceptable" },
    });
    const { res, json } = await callPost({ panelRevision: 1, status: "rejected", comment: "not acceptable" });
    expect(res.status).toBe(200);
    expect(json.submissionStatus).toBe("submitted");
    expect(json.vote.comment).toBe("not acceptable");
  });

  it("client-supplied reviewerUserId/teamId/actor fields are ignored — server-derived values are what reach the writer", async () => {
    mockedSubmitVote.mockResolvedValueOnce({
      ok: true,
      submissionStatus: "submitted",
      vote: { status: "approved", submittedAt: "x", commentPresent: false, conditionsCount: 0 },
    });
    await callPost({ panelRevision: 1, status: "approved", reviewerUserId: "attacker-uid", teamId: "attacker-team" });
    expect(mockedSubmitVote).toHaveBeenCalledWith({
      runId: RUN_ID,
      teamId: TEAM_ID,
      reviewerUserId: REVIEWER_A, // the authenticated caller, never "attacker-uid"
      panelRevision: 1,
      status: "approved",
      comment: undefined,
      conditions: undefined,
    });
  });

  it("vote_conflict maps to 409 vote_already_submitted", async () => {
    mockedSubmitVote.mockResolvedValueOnce({ ok: false, reason: "vote_conflict" });
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("vote_already_submitted");
  });

  it("panel_stale (raised by the transaction itself, not just the pre-check) maps to 409 panel_stale", async () => {
    mockedSubmitVote.mockResolvedValueOnce({ ok: false, reason: "panel_stale" });
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_stale");
  });

  it("reviewer_not_assigned (raised by the transaction) maps to 403", async () => {
    mockedSubmitVote.mockResolvedValueOnce({ ok: false, reason: "reviewer_not_assigned" });
    const { res, json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("reviewer_not_assigned");
  });

  it("firestore_unavailable maps to 503", async () => {
    mockedSubmitVote.mockResolvedValueOnce({ ok: false, reason: "firestore_unavailable" });
    const { res } = await callPost({ panelRevision: 1, status: "approved" });
    expect(res.status).toBe(503);
  });

  it("never exposes a raw Firestore error or the internal vote document ID", async () => {
    mockedSubmitVote.mockResolvedValueOnce({
      ok: true,
      submissionStatus: "submitted",
      vote: { status: "approved", submittedAt: "x", commentPresent: false, conditionsCount: 0 },
    });
    const { json } = await callPost({ panelRevision: 1, status: "approved" });
    expect(JSON.stringify(json)).not.toMatch(/r1:/);
    expect(json).not.toHaveProperty("teamId");
  });
});

describe("GET .../votes — authorization", () => {
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

  it("rejects a plain, non-admin member", async () => {
    mockedIsTeamAdmin.mockReturnValueOnce(false);
    const { res } = await callGet();
    expect(res.status).toBe(403);
  });

  it("allows a panel reviewer (who is, in this codebase, always also admin/owner)", async () => {
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("allows an owner/admin who is not on this particular panel", async () => {
    mockedGetRequestUid.mockResolvedValueOnce("uninvolved-admin-uid");
    mockedLoadUserAndTeam.mockResolvedValueOnce({
      user: { email: "z@test.com" },
      team: team({ members: [...team().members, { uid: "uninvolved-admin-uid", email: "z@test.com", role: "admin", joinedAt: "x" }] }),
    });
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("hides a cross-team run behind projection_missing", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });

  it("rejects when no panel exists", async () => {
    mockedGetPanel.mockResolvedValueOnce({ status: "absent" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("panel_absent");
  });
});

describe("GET .../votes — contract", () => {
  it("returns version 1, panelRevision, panelStatus, reviewerCount, submittedCount, votes", async () => {
    const { json } = await callGet();
    expect(json.ok).toBe(true);
    expect(json.version).toBe(1);
    expect(json.panelRevision).toBe(1);
    expect(json.panelStatus).toBe("open");
    expect(json.reviewerCount).toBe(2);
    expect(json.submittedCount).toBe(0);
    expect(json.votes).toEqual([]);
  });

  it("zero votes submitted yet — empty votes array, submittedCount 0", async () => {
    mockedGetVote.mockResolvedValue({ status: "absent" });
    const { json } = await callGet();
    expect(json.votes).toHaveLength(0);
    expect(json.submittedCount).toBe(0);
  });

  it("one vote submitted — appears in the array, submittedCount 1", async () => {
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) =>
      reviewerId === REVIEWER_A
        ? { status: "found", vote: { reviewerUserId: REVIEWER_A, status: "approved", submittedAt: "x", commentPresent: false, conditionsCount: 0 } }
        : { status: "absent" }
    );
    const { json } = await callGet();
    expect(json.votes).toHaveLength(1);
    expect(json.submittedCount).toBe(1);
    expect(json.votes[0].reviewerUserId).toBe(REVIEWER_A);
  });

  it("multiple votes submitted, in deterministic panel-reviewer order", async () => {
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) => ({
      status: "found",
      vote: { reviewerUserId: reviewerId, status: "approved", submittedAt: "x", commentPresent: false, conditionsCount: 0 },
    }));
    const { json } = await callGet();
    expect(json.votes.map((v: any) => v.reviewerUserId)).toEqual([REVIEWER_A, REVIEWER_B]);
    expect(json.submittedCount).toBe(2);
  });

  it("a cancelled panel still returns its historical votes and an accurate submittedCount", async () => {
    mockedGetPanel.mockResolvedValueOnce(foundPanel({ status: "cancelled" }));
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) =>
      reviewerId === REVIEWER_A
        ? { status: "found", vote: { reviewerUserId: REVIEWER_A, status: "rejected", submittedAt: "x", commentPresent: true, conditionsCount: 0 } }
        : { status: "absent" }
    );
    const { json } = await callGet();
    expect(json.panelStatus).toBe("cancelled");
    expect(json.votes).toHaveLength(1);
    expect(json.submittedCount).toBe(1);
  });

  it("a malformed stored vote is skipped safely, never surfaced as an error or fabricated entry", async () => {
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) =>
      reviewerId === REVIEWER_A ? { status: "malformed" } : { status: "absent" }
    );
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.votes).toHaveLength(0);
  });

  it("an unsupported-version stored vote is skipped safely", async () => {
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) =>
      reviewerId === REVIEWER_A ? { status: "unsupported_version" } : { status: "absent" }
    );
    const { res, json } = await callGet();
    expect(res.status).toBe(200);
    expect(json.votes).toHaveLength(0);
  });

  it("own vote includes comment/conditions; other reviewers' votes never do, even for the same viewer", async () => {
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) => ({
      status: "found",
      vote: {
        reviewerUserId: reviewerId,
        status: reviewerId === REVIEWER_A ? "rejected" : "approved_with_conditions",
        submittedAt: "x",
        commentPresent: reviewerId === REVIEWER_A,
        conditionsCount: reviewerId === REVIEWER_B ? 1 : 0,
        comment: reviewerId === REVIEWER_A ? "my private reason" : "their private reason",
        conditions: reviewerId === REVIEWER_B ? ["their private condition"] : undefined,
      },
    }));
    // Caller is REVIEWER_A (from beforeEach).
    const { json } = await callGet();
    const own = json.votes.find((v: any) => v.reviewerUserId === REVIEWER_A);
    const other = json.votes.find((v: any) => v.reviewerUserId === REVIEWER_B);
    expect(own.isCurrentUser).toBe(true);
    expect(own.comment).toBe("my private reason");
    expect(other.isCurrentUser).toBe(false);
    expect(other.comment).toBeUndefined();
    expect(other.conditions).toBeUndefined();
    // Status/timestamp summary is still visible for the other reviewer:
    expect(other.status).toBe("approved_with_conditions");
    expect(other.conditionsCount).toBe(1);
  });

  it("this is a deliberate narrowing from the original design (owner full-text access) — even an OWNER caller never sees another reviewer's comment/conditions in Part C", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(REVIEWER_B); // REVIEWER_B is role "owner" in the team() fixture
    mockedMemberRole.mockReturnValueOnce("owner");
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) => ({
      status: "found",
      vote: {
        reviewerUserId: reviewerId,
        status: "rejected",
        submittedAt: "x",
        commentPresent: true,
        conditionsCount: 0,
        comment: reviewerId === REVIEWER_A ? "reviewer A's private reason" : "owner's own reason",
      },
    }));
    const { json } = await callGet();
    const otherReviewersVote = json.votes.find((v: any) => v.reviewerUserId === REVIEWER_A);
    expect(otherReviewersVote.comment).toBeUndefined();
    const ownVote = json.votes.find((v: any) => v.reviewerUserId === REVIEWER_B);
    expect(ownVote.comment).toBe("owner's own reason");
  });

  it("never exposes ANOTHER reviewer's raw email, teamId, the internal vote document ID, or raw membership (the caller's OWN email may appear unmasked per maskEmail()'s existing, established precedent)", async () => {
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) => ({
      status: "found",
      vote: { reviewerUserId: reviewerId, status: "approved", submittedAt: "x", commentPresent: false, conditionsCount: 0 },
    }));
    // Caller is REVIEWER_A/a@test.com — only b@test.com (another
    // reviewer's email) must never appear raw.
    const { json } = await callGet();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("b@test.com");
    expect(json).not.toHaveProperty("teamId");
    expect(serialized).not.toMatch(/r1:/);
  });

  it("no aggregate or final-decision fields exist anywhere in the response", async () => {
    const { json } = await callGet();
    expect(json).not.toHaveProperty("finalDecision");
    expect(json).not.toHaveProperty("aggregate");
    expect(json).not.toHaveProperty("quorumMet");
    expect(json).not.toHaveProperty("readyToFinalize");
  });

  it("firestore_unavailable on the panel read maps to 503", async () => {
    mockedGetPanel.mockResolvedValueOnce({ status: "firestore_unavailable" });
    const { res } = await callGet();
    expect(res.status).toBe(503);
  });
});
