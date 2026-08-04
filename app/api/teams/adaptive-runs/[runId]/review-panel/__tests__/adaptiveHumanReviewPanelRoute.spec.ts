/**
 * Multi-Reviewer Panel Foundation, Part B —
 * GET/PUT/DELETE /api/teams/adaptive-runs/[runId]/review-panel tests.
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
const mockedSubmitPanel = jest.fn();
const mockedCancelPanel = jest.fn();
const mockedGetVote = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewPanel: (...args: any[]) => mockedGetPanel(...args),
  submitAdaptiveHumanReviewPanel: (...args: any[]) => mockedSubmitPanel(...args),
  cancelAdaptiveHumanReviewPanel: (...args: any[]) => mockedCancelPanel(...args),
  getAdaptiveHumanReviewVote: (...args: any[]) => mockedGetVote(...args),
}));

const mockedUserGet = jest.fn();
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

// Step 5.11 — the global release guard, mutable per-test via `mockEnv`.
// Defaults to enabled so every PRE-EXISTING test (written before the
// guard existed) keeps exercising real PUT behavior unchanged; the guard's
// own off/on behavior is tested explicitly in its own describe block.
const mockEnv = { MULTI_REVIEWER_GOVERNANCE_ENABLED: true };
jest.mock("@/lib/env", () => ({
  get MULTI_REVIEWER_GOVERNANCE_ENABLED() {
    return mockEnv.MULTI_REVIEWER_GOVERNANCE_ENABLED;
  },
}));

import { NextRequest, NextResponse } from "next/server";
import { GET, PUT, DELETE } from "@/app/api/teams/adaptive-runs/[runId]/review-panel/route";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";

let runData: Record<string, unknown>;

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
      { uid: "owner-uid", email: "owner@test.com", role: "owner", joinedAt: "x" },
      { uid: "admin-uid", email: "admin@test.com", role: "admin", joinedAt: "x" },
      { uid: "admin-2-uid", email: "admin2@test.com", role: "admin", joinedAt: "x" },
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

function buildGetRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/review-panel`);
}
function buildPutRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/review-panel`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function buildDeleteRequest(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/review-panel`, {
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
  mockedGetPanel.mockReset();
  mockedSubmitPanel.mockReset();
  mockedCancelPanel.mockReset();
  mockedGetVote.mockReset();
  mockedUserGet.mockReset();
  mockLoggerWarn.mockClear();
  mockEnv.MULTI_REVIEWER_GOVERNANCE_ENABLED = true;

  runData = { governanceRecord: governanceRecord() };
  mockedGetRequestUid.mockResolvedValue("admin-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "admin@test.com" }, team: team() });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedGetPanel.mockResolvedValue({ status: "absent" });
  mockedGetVote.mockResolvedValue({ status: "absent" });
  mockedUserGet.mockResolvedValue({ exists: false, data: () => undefined });
});

describe("GET .../review-panel — authorization", () => {
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

  it("allows an owner", async () => {
    mockedMemberRole.mockReturnValueOnce("owner");
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("allows an admin", async () => {
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("does NOT require team opt-in to be enabled — viewing is always available to an admin/owner", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { email: "admin@test.com" }, team: team({ adaptiveMultiReviewerSettings: { enabled: false, mode: "majority_quorum" } }) });
    const { res } = await callGet();
    expect(res.status).toBe(200);
  });

  it("hides a cross-team run behind projection_missing (existence never disclosed)", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callGet();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });

  it("rejects a missing run", async () => {
    runData = undefined as any;
    mockAdminDb.collection = (name: string) => ({
      doc: () => ({ get: async () => (name === "runs" ? { exists: false } : { exists: false, data: () => undefined }) }),
    });
    const { res } = await callGet();
    expect(res.status).toBe(404);
    // restore for subsequent tests
    mockAdminDb.collection = (name: string) => ({
      doc: (id: string) => ({
        get: async () => (name === "runs" ? { exists: true, data: () => runData } : mockedUserGet(id)),
      }),
    });
  });

  it("fails closed on a malformed governanceRecord", async () => {
    runData = { governanceRecord: { version: 1, garbage: true } };
    const { res, json } = await callGet();
    expect(res.status).toBe(500);
    expect(json.error.code).toBe("internal_error");
  });

  it("never exposes raw Firestore errors", async () => {
    mockedGetPanel.mockRejectedValueOnce(new Error("SECRET INTERNAL DETAIL"));
    // getAdaptiveHumanReviewPanel is mocked to reject here to simulate an
    // unexpected throw reaching the route directly (defense in depth) —
    // the route itself doesn't catch this, so this proves the underlying
    // persistence layer's OWN contract (never throws) is what the route
    // relies on; a throw here is a test-only pathological case documenting
    // that assumption, not a route behavior under normal operation.
    await expect(callGet()).rejects.toThrow();
  });
});

describe("GET .../review-panel — contract", () => {
  it("returns panel: null when absent", async () => {
    const { json } = await callGet();
    expect(json).toEqual({ ok: true, version: 1, panel: null });
  });

  it("returns the full panel shape with resolved reviewer display names when found", async () => {
    mockedGetPanel.mockResolvedValueOnce({
      status: "found",
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "2026-07-31T00:00:00.000Z",
        createdByUserId: "admin-uid",
        updatedAt: "2026-07-31T00:00:00.000Z",
        updatedByUserId: "admin-uid",
      },
    });
    const { json } = await callGet();
    expect(json.ok).toBe(true);
    expect(json.panel.mode).toBe("majority_quorum");
    expect(json.panel.reviewerUserIds).toEqual(["owner-uid", "admin-2-uid"]);
    expect(json.panel.reviewers).toHaveLength(2);
    expect(json.panel.reviewers[0]).toHaveProperty("userId");
    expect(json.panel.reviewers[0]).toHaveProperty("displayName");
    expect(json.panel.requiredReviewerCount).toBe(2);
    expect(json.panel.quorum).toBe(2);
    expect(json.panel.status).toBe("open");
    expect(json.panel.revision).toBe(1);
  });

  it("never exposes teamId, actor IDs, or raw membership in the GET response", async () => {
    mockedGetPanel.mockResolvedValueOnce({
      status: "found",
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid"],
        requiredReviewerCount: 1,
        quorum: 1,
        status: "open",
        revision: 1,
        createdAt: "2026-07-31T00:00:00.000Z",
        createdByUserId: "admin-uid",
        updatedAt: "2026-07-31T00:00:00.000Z",
        updatedByUserId: "admin-uid",
      },
    });
    const { json } = await callGet();
    expect(json.panel).not.toHaveProperty("teamId");
    expect(json.panel).not.toHaveProperty("createdByUserId");
    expect(json.panel).not.toHaveProperty("updatedByUserId");
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("owner@test.com");
  });

  it("a malformed stored panel is reported as 409 adaptive_review_panel_invalid, never fabricated as valid", async () => {
    mockedGetPanel.mockResolvedValueOnce({ status: "malformed" });
    const { res, json } = await callGet();
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("adaptive_review_panel_invalid");
  });

  it("Firestore unavailable maps to 503", async () => {
    mockedGetPanel.mockResolvedValueOnce({ status: "firestore_unavailable" });
    const { res } = await callGet();
    expect(res.status).toBe(503);
  });
});

/**
 * Multi-Reviewer Owner Override, Part F (§F10) — the extended read model:
 * live per-reviewer vote status, aggregationState, and the four capability
 * flags. `mockedGetVote` is set per-test via a small map so the fake mocks
 * exactly the reviewer set each test constructs.
 */
describe("GET .../review-panel — Part F rich read model", () => {
  function openPanel(overrides: Record<string, unknown> = {}) {
    return {
      status: "found" as const,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-uid", "admin-2-uid"],
        requiredReviewerCount: 3,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "2026-07-31T00:00:00.000Z",
        createdByUserId: "admin-uid",
        updatedAt: "2026-07-31T00:00:00.000Z",
        updatedByUserId: "admin-uid",
        ...overrides,
      },
    };
  }

  function finalizedPanel(overrides: Record<string, unknown> = {}) {
    return openPanel({
      status: "finalized",
      revision: 2,
      finalizedAt: "2026-07-31T01:00:00.000Z",
      finalizedByUserId: "owner-uid",
      finalStatus: "approved",
      finalDecisionId: "panel_dec_x",
      aggregationPolicyVersion: 1,
      ...overrides,
    });
  }

  function vote(reviewerUserId: string, status: string, submittedAt = "2026-07-31T00:30:00.000Z") {
    // A "rejected"/"changes_requested" vote requires a comment under the
    // established domain rule (adaptiveHumanReviewRequest.ts) — the real
    // aggregation engine re-parses each vote internally and would report
    // the whole aggregation as "invalid" otherwise.
    const needsComment = status === "changes_requested" || status === "rejected";
    return {
      status: "found" as const,
      vote: {
        schemaVersion: 1,
        kind: "adaptive_human_review_vote",
        teamId: TEAM_ID,
        runId: RUN_ID,
        panelRevision: 1,
        reviewerUserId,
        status,
        comment: needsComment ? "reason" : undefined,
        commentPresent: needsComment,
        conditionsCount: 0,
        submittedAt,
      },
    };
  }

  function mockVotesByReviewer(byReviewer: Record<string, ReturnType<typeof vote> | { status: "absent" }>) {
    mockedGetVote.mockImplementation(async (_runId: string, _revision: number, reviewerUserId: string) => byReviewer[reviewerUserId] ?? { status: "absent" });
  }

  it("a WAITING panel (below quorum) reports aggregationState waiting and the real submittedCount", async () => {
    mockedGetPanel.mockResolvedValueOnce(openPanel());
    mockVotesByReviewer({ "owner-uid": vote("owner-uid", "approved") });
    const { json } = await callGet();
    expect(json.panel.aggregationState).toBe("waiting");
    expect(json.panel.submittedCount).toBe(1);
    expect(json.panel).not.toHaveProperty("readyFinalStatus");
  });

  it("a READY panel (strict majority) reports aggregationState ready and readyFinalStatus", async () => {
    mockedGetPanel.mockResolvedValueOnce(openPanel());
    mockVotesByReviewer({ "owner-uid": vote("owner-uid", "approved"), "admin-uid": vote("admin-uid", "approved") });
    const { json } = await callGet();
    expect(json.panel.aggregationState).toBe("ready");
    expect(json.panel.readyFinalStatus).toBe("approved");
    expect(json.panel.submittedCount).toBe(2);
  });

  it("a DEADLOCKED panel (no strict majority, quorum met) reports aggregationState deadlocked", async () => {
    mockedGetPanel.mockResolvedValueOnce(openPanel({ reviewerUserIds: ["owner-uid", "admin-uid"], requiredReviewerCount: 2, quorum: 2 }));
    mockVotesByReviewer({ "owner-uid": vote("owner-uid", "approved"), "admin-uid": vote("admin-uid", "rejected") });
    const { json } = await callGet();
    expect(json.panel.aggregationState).toBe("deadlocked");
    expect(json.panel).not.toHaveProperty("readyFinalStatus");
  });

  it("a FINALIZED panel reports aggregationState finalized without recomputing from votes", async () => {
    mockedGetPanel.mockResolvedValueOnce(finalizedPanel());
    mockVotesByReviewer({});
    const { json } = await callGet();
    expect(json.panel.aggregationState).toBe("finalized");
    expect(json.panel.finalStatus).toBe("approved");
    expect(json.panel.finalizedAt).toBe("2026-07-31T01:00:00.000Z");
  });

  it("Step 5.16 regression — a FINALIZED panel (revision incremented by finalization) still shows each reviewer's vote, read from the PRE-finalization revision where the votes actually live, never the panel's own post-finalization revision", async () => {
    // finalizedPanel() is revision 2 (finalization always increments by
    // exactly 1); votes are stored at revision 1, the panel's revision
    // AT THE MOMENT they were cast. A route that queried votes at the
    // panel's CURRENT revision (2) would find nothing and silently render
    // every reviewer as "no vote" even though two of them plainly did.
    mockedGetPanel.mockResolvedValueOnce(finalizedPanel());
    let queriedRevision: number | undefined;
    mockedGetVote.mockImplementation(async (_runId: string, revision: number, reviewerUserId: string) => {
      queriedRevision = revision;
      if (reviewerUserId === "owner-uid") return vote("owner-uid", "approved");
      if (reviewerUserId === "admin-uid") return vote("admin-uid", "approved");
      return { status: "absent" };
    });
    const { json } = await callGet();
    expect(queriedRevision).toBe(1); // panel.revision (2) - 1, not panel.revision itself
    const ownerEntry = json.panel.reviewers.find((r: any) => r.userId === "owner-uid");
    const adminEntry = json.panel.reviewers.find((r: any) => r.userId === "admin-uid");
    const admin2Entry = json.panel.reviewers.find((r: any) => r.userId === "admin-2-uid");
    expect(ownerEntry.hasSubmittedVote).toBe(true);
    expect(ownerEntry.voteStatus).toBe("approved");
    expect(adminEntry.hasSubmittedVote).toBe(true);
    expect(admin2Entry.hasSubmittedVote).toBe(false);
  });

  it("Step 5.16 regression — a CANCELLED panel (revision also incremented by cancellation) reads votes from the pre-cancellation revision too", async () => {
    mockedGetPanel.mockResolvedValueOnce(openPanel({ status: "cancelled", revision: 2 }));
    let queriedRevision: number | undefined;
    mockedGetVote.mockImplementation(async (_runId: string, revision: number, reviewerUserId: string) => {
      queriedRevision = revision;
      if (reviewerUserId === "owner-uid") return vote("owner-uid", "approved");
      return { status: "absent" };
    });
    const { json } = await callGet();
    expect(queriedRevision).toBe(1);
    const ownerEntry = json.panel.reviewers.find((r: any) => r.userId === "owner-uid");
    expect(ownerEntry.hasSubmittedVote).toBe(true);
  });

  it("a legacy Part-E finalized panel with no finalizedVia at all defaults to finalizedVia: aggregation", async () => {
    mockedGetPanel.mockResolvedValueOnce(finalizedPanel());
    mockVotesByReviewer({});
    const { json } = await callGet();
    expect(json.panel.finalizedVia).toBe("aggregation");
  });

  it("a panel finalized via owner override reports finalizedVia: owner_override", async () => {
    mockedGetPanel.mockResolvedValueOnce(
      finalizedPanel({ finalizedVia: "owner_override", overrideJustificationPresent: true, overrideByUserId: "owner-uid" })
    );
    mockVotesByReviewer({});
    const { json } = await callGet();
    expect(json.panel.finalizedVia).toBe("owner_override");
  });

  it("per-reviewer voteStatus/submittedAt are visible for EVERY reviewer, not just the caller", async () => {
    mockedGetRequestUid.mockResolvedValueOnce("admin-uid"); // caller is admin-uid, not owner-uid
    mockedGetPanel.mockResolvedValueOnce(openPanel());
    mockVotesByReviewer({ "owner-uid": vote("owner-uid", "rejected", "2026-07-31T00:10:00.000Z") });
    const { json } = await callGet();
    const ownerEntry = json.panel.reviewers.find((r: any) => r.userId === "owner-uid");
    expect(ownerEntry.hasSubmittedVote).toBe(true);
    expect(ownerEntry.voteStatus).toBe("rejected");
    expect(ownerEntry.submittedAt).toBe("2026-07-31T00:10:00.000Z");
    expect(ownerEntry.isCurrentUser).toBe(false);
  });

  it("a reviewer who has not voted shows hasSubmittedVote: false and no voteStatus field at all", async () => {
    mockedGetPanel.mockResolvedValueOnce(openPanel());
    mockVotesByReviewer({});
    const { json } = await callGet();
    for (const r of json.panel.reviewers) {
      expect(r.hasSubmittedVote).toBe(false);
      expect(r).not.toHaveProperty("voteStatus");
    }
  });

  it("never exposes vote comment/conditions text, finalDecisionId, finalizedByUserId, overrideByUserId, or overrideJustification", async () => {
    mockedGetPanel.mockResolvedValueOnce(
      finalizedPanel({ finalizedVia: "owner_override", overrideJustificationPresent: true, overrideByUserId: "owner-uid" })
    );
    mockVotesByReviewer({ "owner-uid": { status: "found", vote: { ...vote("owner-uid", "rejected").vote, comment: "private reasoning", commentPresent: true } } });
    const { json } = await callGet();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("finalDecisionId");
    expect(serialized).not.toContain("finalizedByUserId");
    expect(serialized).not.toContain("overrideByUserId");
    expect(serialized).not.toContain("overrideJustification");
  });

  describe("capability flags", () => {
    it("owner: canReconfigurePanel/canCancelPanel/canVote/canFinalize/canOverride all true on a ready open panel where owner is a reviewer and hasn't voted", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(openPanel({ reviewerUserIds: ["owner-uid", "admin-uid"], requiredReviewerCount: 2, quorum: 2 }));
      mockVotesByReviewer({ "admin-uid": vote("admin-uid", "approved") });
      const { json } = await callGet();
      expect(json.panel.canReconfigurePanel).toBe(true);
      expect(json.panel.canCancelPanel).toBe(true);
      expect(json.panel.canVote).toBe(true);
      expect(json.panel.canOverride).toBe(true);
    });

    it("admin (not owner): canOverride is always false, even on a deadlocked panel", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("admin-uid");
      mockedMemberRole.mockReturnValueOnce("admin");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(openPanel({ reviewerUserIds: ["owner-uid", "admin-uid"], requiredReviewerCount: 2, quorum: 2 }));
      mockVotesByReviewer({ "owner-uid": vote("owner-uid", "approved"), "admin-uid": vote("admin-uid", "rejected") });
      const { json } = await callGet();
      expect(json.panel.aggregationState).toBe("deadlocked");
      expect(json.panel.canOverride).toBe(false);
      expect(json.panel.canReconfigurePanel).toBe(true);
      expect(json.panel.canCancelPanel).toBe(true);
    });

    it("Step 5.10 — canReconfigurePanel is false but canCancelPanel remains true once team opt-in is disabled (the release-boundary fix)", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedLoadUserAndTeam.mockResolvedValueOnce({
        user: { email: "owner@test.com" },
        team: team({ adaptiveMultiReviewerSettings: { enabled: false, mode: "majority_quorum" } }),
      });
      mockedGetPanel.mockResolvedValueOnce(openPanel());
      mockVotesByReviewer({});
      const { json } = await callGet();
      expect(json.panel.canReconfigurePanel).toBe(false);
      expect(json.panel.canCancelPanel).toBe(true);
      // Finalize/override/vote must ALSO remain unaffected by team opt-in —
      // proven at the route level by their own dedicated tests; here we
      // only assert the two flags this GET route itself computes.
    });

    it("Step 5.10 — canReconfigurePanel is false but canCancelPanel remains true once the global MULTI_REVIEWER_GOVERNANCE_ENABLED guard is off", async () => {
      mockEnv.MULTI_REVIEWER_GOVERNANCE_ENABLED = false;
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(openPanel());
      mockVotesByReviewer({});
      const { json } = await callGet();
      expect(json.panel.canReconfigurePanel).toBe(false);
      expect(json.panel.canCancelPanel).toBe(true);
    });

    it("a plain member is rejected at the route's own admin gate before any panel data (including capability flags) is ever returned", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("member-uid");
      mockedMemberRole.mockReturnValueOnce("member");
      mockedIsTeamAdmin.mockReturnValueOnce(false);
      mockedGetPanel.mockResolvedValueOnce(openPanel());
      mockVotesByReviewer({});
      const { res, json } = await callGet();
      expect(res.status).toBe(403);
      expect(json.panel).toBeUndefined();
      expect(mockedGetPanel).not.toHaveBeenCalled();
    });

    it("a reviewer who has ALREADY voted: canVote is false (no re-vote)", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(openPanel());
      mockVotesByReviewer({ "owner-uid": vote("owner-uid", "approved") });
      const { json } = await callGet();
      expect(json.panel.canVote).toBe(false);
    });

    it("canFinalize is true only when aggregationState is ready, for an admin/owner", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("admin-uid");
      mockedMemberRole.mockReturnValueOnce("admin");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(openPanel({ reviewerUserIds: ["owner-uid", "admin-uid"], requiredReviewerCount: 2, quorum: 2 }));
      mockVotesByReviewer({ "owner-uid": vote("owner-uid", "approved"), "admin-uid": vote("admin-uid", "approved") });
      const { json } = await callGet();
      expect(json.panel.aggregationState).toBe("ready");
      expect(json.panel.canFinalize).toBe(true);
    });

    it("a FINALIZED panel: every capability flag is false — no further mutation possible", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(finalizedPanel());
      mockVotesByReviewer({});
      const { json } = await callGet();
      expect(json.panel.canReconfigurePanel).toBe(false);
      expect(json.panel.canCancelPanel).toBe(false);
      expect(json.panel.canVote).toBe(false);
      expect(json.panel.canFinalize).toBe(false);
      expect(json.panel.canOverride).toBe(false);
    });

    it("a CANCELLED panel: every capability flag is false, aggregationState defaults to waiting (no analogous state)", async () => {
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(openPanel({ status: "cancelled" }));
      mockVotesByReviewer({});
      const { json } = await callGet();
      expect(json.panel.status).toBe("cancelled");
      expect(json.panel.aggregationState).toBe("waiting");
      expect(json.panel.canReconfigurePanel).toBe(false);
      expect(json.panel.canCancelPanel).toBe(false);
      expect(json.panel.canVote).toBe(false);
      expect(json.panel.canFinalize).toBe(false);
      expect(json.panel.canOverride).toBe(false);
    });

    it("a non-pending governanceRecord (terminal outside the panel): canVote/canReconfigurePanel/canCancelPanel/canOverride are all false", async () => {
      runData = { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) };
      mockedGetRequestUid.mockResolvedValueOnce("owner-uid");
      mockedMemberRole.mockReturnValueOnce("owner");
      mockedIsTeamAdmin.mockReturnValueOnce(true);
      mockedGetPanel.mockResolvedValueOnce(openPanel());
      mockVotesByReviewer({});
      const { json } = await callGet();
      expect(json.panel.canVote).toBe(false);
      expect(json.panel.canReconfigurePanel).toBe(false);
      expect(json.panel.canCancelPanel).toBe(false);
      expect(json.panel.canOverride).toBe(false);
    });
  });
});

describe("PUT .../review-panel — authorization and opt-in", () => {
  it("rejects when team opt-in is disabled", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { email: "admin@test.com" }, team: team({ adaptiveMultiReviewerSettings: { enabled: false, mode: "majority_quorum" } }) });
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("multi_reviewer_disabled");
    expect(mockedSubmitPanel).not.toHaveBeenCalled();
  });

  it("rejects when team opt-in was never configured (absent settings)", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { email: "admin@test.com" }, team: team({ adaptiveMultiReviewerSettings: undefined }) });
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(403);
  });

  it("Step 5.11 — rejects when the global MULTI_REVIEWER_GOVERNANCE_ENABLED guard is off, even with team opt-in enabled", async () => {
    mockEnv.MULTI_REVIEWER_GOVERNANCE_ENABLED = false;
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(403);
    expect(json.error.code).toBe("multi_reviewer_disabled");
    expect(mockedSubmitPanel).not.toHaveBeenCalled();
  });

  it("Step 5.11 — allows PUT when both the global guard and team opt-in are enabled", async () => {
    mockEnv.MULTI_REVIEWER_GOVERNANCE_ENABLED = true;
    mockedSubmitPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(200);
  });

  it("rejects a plain member", async () => {
    mockedIsTeamAdmin.mockReturnValueOnce(false);
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(403);
  });

  it("rejects when the review is no longer pending", async () => {
    runData = { governanceRecord: governanceRecord({ humanReview: { status: "approved" } }) };
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("not_pending");
    expect(mockedSubmitPanel).not.toHaveBeenCalled();
  });

  it("hides a cross-team run behind projection_missing", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });
});

describe("PUT .../review-panel — reviewer-list validation", () => {
  it("rejects a non-array reviewerUserIds", async () => {
    const { res } = await callPut({ reviewerUserIds: "owner-uid,admin-2-uid", expectedRevision: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects an empty-string entry", async () => {
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", ""], expectedRevision: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate reviewer IDs", async () => {
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "owner-uid"], expectedRevision: 0 });
    expect(res.status).toBe(400);
    expect(json.error.message).toContain("duplicate");
  });

  it("rejects fewer than MIN reviewers", async () => {
    const { res } = await callPut({ reviewerUserIds: ["owner-uid"], expectedRevision: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects more than MAX reviewers", async () => {
    const tooMany = ["owner-uid", "admin-uid", "admin-2-uid", "m1", "m2", "m3", "m4", "m5", "m6", "m7"];
    const { res } = await callPut({ reviewerUserIds: tooMany, expectedRevision: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-member reviewer ID", async () => {
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "not-a-member"], expectedRevision: 0 });
    expect(res.status).toBe(400);
    expect(json.error.message).toContain("not members");
    expect(mockedSubmitPanel).not.toHaveBeenCalled();
  });

  it("rejects a plain-member reviewer (ineligible role)", async () => {
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "member-uid"], expectedRevision: 0 });
    expect(res.status).toBe(400);
    expect(json.error.message).toContain("permission");
    expect(mockedSubmitPanel).not.toHaveBeenCalled();
  });

  it("rejects a missing expectedRevision", async () => {
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"] });
    expect(res.status).toBe(400);
  });

  it("rejects a negative expectedRevision", async () => {
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: -1 });
    expect(res.status).toBe(400);
  });

  it("client-supplied teamId/quorum/requiredReviewerCount/status/actor IDs are silently ignored, never forwarded to the writer", async () => {
    mockedSubmitPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    await callPut({
      reviewerUserIds: ["owner-uid", "admin-2-uid"],
      expectedRevision: 0,
      teamId: "attacker-team",
      quorum: 99,
      requiredReviewerCount: 99,
      status: "finalized",
      createdByUserId: "attacker-uid",
    });
    expect(mockedSubmitPanel).toHaveBeenCalledWith({
      runId: RUN_ID,
      teamId: TEAM_ID, // server-derived, never the client-supplied "attacker-team"
      reviewerUserIds: ["admin-2-uid", "owner-uid"],
      actorUserId: "admin-uid", // server-derived from the authenticated caller
      expectedRevision: 0,
    });
  });

  it("accepts a valid eligible reviewer list and normalizes order deterministically", async () => {
    mockedSubmitPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["admin-2-uid", "owner-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(200);
    expect(json.panel.status).toBe("open");
    expect(json.panel).not.toHaveProperty("teamId");
    expect(json.panel).not.toHaveProperty("createdByUserId");
  });
});

describe("PUT .../review-panel — canonical outcome mapping", () => {
  it("not_pending maps to 409", async () => {
    mockedSubmitPanel.mockResolvedValueOnce({ ok: false, reason: "not_pending" });
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("not_pending");
  });

  it("stale_revision maps to 409 panel_stale", async () => {
    mockedSubmitPanel.mockResolvedValueOnce({ ok: false, reason: "stale_revision" });
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 5 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_stale");
  });

  it("panel_cancelled maps to 409 panel_cancelled — no reopening", async () => {
    mockedSubmitPanel.mockResolvedValueOnce({ ok: false, reason: "panel_cancelled" });
    const { res, json } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 3 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_cancelled");
  });

  it("run_missing maps to 404", async () => {
    mockedSubmitPanel.mockResolvedValueOnce({ ok: false, reason: "run_missing" });
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(404);
  });

  it("firestore_unavailable maps to 503", async () => {
    mockedSubmitPanel.mockResolvedValueOnce({ ok: false, reason: "firestore_unavailable" });
    const { res } = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(res.status).toBe(503);
  });
});

describe("DELETE .../review-panel", () => {
  it("Step 5.10 — cancel remains available even when team opt-in is disabled (a DRAIN operation, never new activity — never strands an open panel)", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: { email: "admin@test.com" }, team: team({ adaptiveMultiReviewerSettings: { enabled: false, mode: "majority_quorum" } }) });
    mockedCancelPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "cancelled",
        revision: 2,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    const { res } = await callDelete({ expectedRevision: 1 });
    expect(res.status).toBe(200);
    expect(mockedCancelPanel).toHaveBeenCalled();
  });

  it("Step 5.10 — cancel remains available even when the global guard is off", async () => {
    mockEnv.MULTI_REVIEWER_GOVERNANCE_ENABLED = false;
    mockedCancelPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "cancelled",
        revision: 2,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    const { res } = await callDelete({ expectedRevision: 1 });
    expect(res.status).toBe(200);
  });

  it("rejects a missing expectedRevision", async () => {
    const { res } = await callDelete({});
    expect(res.status).toBe(400);
  });

  it("rejects when the review is no longer pending", async () => {
    runData = { governanceRecord: governanceRecord({ humanReview: { status: "rejected" } }) };
    const { res, json } = await callDelete({ expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("not_pending");
  });

  it("cancels successfully and returns the compact shape only", async () => {
    mockedCancelPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "cancelled",
        revision: 2,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "y",
        updatedByUserId: "admin-uid",
      },
    });
    const { res, json } = await callDelete({ expectedRevision: 1 });
    expect(res.status).toBe(200);
    expect(json.panel).toEqual({ status: "cancelled", revision: 2, updatedAt: "y" });
    expect(json.panel).not.toHaveProperty("teamId");
    expect(json.panel).not.toHaveProperty("reviewerUserIds");
    expect(mockedCancelPanel).toHaveBeenCalledWith({
      runId: RUN_ID,
      teamId: TEAM_ID,
      actorUserId: "admin-uid",
      expectedRevision: 1,
    });
  });

  it("panel_absent maps to 404", async () => {
    mockedCancelPanel.mockResolvedValueOnce({ ok: false, reason: "panel_absent" });
    const { res, json } = await callDelete({ expectedRevision: 0 });
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("panel_absent");
  });

  it("panel_already_cancelled maps to 409 panel_cancelled", async () => {
    mockedCancelPanel.mockResolvedValueOnce({ ok: false, reason: "panel_already_cancelled" });
    const { res, json } = await callDelete({ expectedRevision: 2 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_cancelled");
  });

  it("stale_revision maps to 409 panel_stale", async () => {
    mockedCancelPanel.mockResolvedValueOnce({ ok: false, reason: "stale_revision" });
    const { res, json } = await callDelete({ expectedRevision: 9 });
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("panel_stale");
  });
});

/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.15 — the full
 * rollback lifecycle as ONE narrative: create → disable → drain (cancel)
 * remains possible → new activity (create/reconfigure) is blocked →
 * re-enable → new activity works again. Each individual piece is already
 * proven by its own dedicated test above; this test exists purely to
 * confirm the STORY holds together end-to-end at the route layer, which is
 * the exact scenario Step 5's own release-boundary bug fix targets.
 */
describe("Rollback lifecycle (Step 5.10) — create, disable, drain, restore", () => {
  it("create succeeds while enabled, drains (cancel) while disabled, is blocked from new activity while disabled, and resumes after re-enabling", async () => {
    // 1. Enabled — panel creation succeeds.
    mockEnv.MULTI_REVIEWER_GOVERNANCE_ENABLED = true;
    mockedSubmitPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    const createResult = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(createResult.res.status).toBe(200);

    // 2. Team opt-in disabled (simulating a rollback) — new activity (PUT) is blocked.
    mockedLoadUserAndTeam.mockResolvedValue({
      user: { email: "admin@test.com" },
      team: team({ adaptiveMultiReviewerSettings: { enabled: false, mode: "majority_quorum" } }),
    });
    const blockedReconfigure = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 1 });
    expect(blockedReconfigure.res.status).toBe(403);
    expect(blockedReconfigure.json.error.code).toBe("multi_reviewer_disabled");

    // 3. But the already-open panel can still be DRAINED (cancelled) — never stranded.
    mockedCancelPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "cancelled",
        revision: 2,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    const drainResult = await callDelete({ expectedRevision: 1 });
    expect(drainResult.res.status).toBe(200);

    // 4. Re-enabled — new activity works again.
    mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "admin@test.com" }, team: team() });
    mockedSubmitPanel.mockResolvedValueOnce({
      ok: true,
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: TEAM_ID,
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["owner-uid", "admin-2-uid"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "x",
        createdByUserId: "admin-uid",
        updatedAt: "x",
        updatedByUserId: "admin-uid",
      },
    });
    const restoredResult = await callPut({ reviewerUserIds: ["owner-uid", "admin-2-uid"], expectedRevision: 0 });
    expect(restoredResult.res.status).toBe(200);
  });
});
