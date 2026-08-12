/**
 * Review & Governance report completion — GET /api/user/runs/[runId]/governance
 * tests. Mocks only the I/O boundaries (Firestore run doc, the
 * assignment/panel/vote getters, team lookup, and identity resolution) —
 * `parseGovernanceRecord` and `buildReviewGovernanceViewModel` run for
 * real, so this test also exercises the real wiring between them.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: any[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedRunGet = jest.fn();
// Tracks every collection name this route ever asks Firestore for — used by
// the canonical-precedence regression test below to prove `teamRuns` is
// never queried by this endpoint at all (not just that its content is
// ignored if queried).
const collectionCalls: string[] = [];
const mockAdminDb: any = {
  collection: (name: string) => {
    collectionCalls.push(name);
    if (name === "teamRuns") {
      // If this route ever DID query teamRuns, this stale/conflicting
      // projection would be exactly the kind of data that must never win
      // over canonical governanceRecord — see the regression test below.
      return {
        doc: () => ({
          get: async () => ({
            exists: true,
            data: () => ({
              humanReviewStatus: "unreviewed",
              reviewedAt: null,
              projectionVersion: 1,
              adaptive: true,
            }),
          }),
        }),
      };
    }
    return {
      doc: () => ({
        get: async () => mockedRunGet(),
      }),
    };
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

const mockedGetAssignment = jest.fn();
const mockedGetPanel = jest.fn();
const mockedGetVote = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetAssignment(...args),
  getAdaptiveHumanReviewPanel: (...args: any[]) => mockedGetPanel(...args),
  getAdaptiveHumanReviewVote: (...args: any[]) => mockedGetVote(...args),
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
}));

const mockedResolveReviewerDisplayNames = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: (...args: any[]) => mockedResolveReviewerDisplayNames(...args),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/governance/route";

const UID = "owner-1";
const RUN_ID = "run-1";

function baseGovernanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "c",
      basis: [],
      assumptions: [],
      uncertainties: [],
      limitations: [],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: false,
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${RUN_ID}/governance`);
}

async function callRoute() {
  const res = await GET(buildRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  collectionCalls.length = 0;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
  mockedGetPanel.mockResolvedValue({ status: "absent" });
  mockedGetVote.mockResolvedValue({ status: "absent" });
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "owner@example.com" }, team: null });
  mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((uid) => [uid, `Name-${uid}`])));
});

describe("GET /api/user/runs/[runId]/governance — auth", () => {
  it("401s when unauthenticated (missing credentials)", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(401);
    expect(json.message).toMatch(/sign in/i);
  });

  it("401s with a generic message (not a credential-specific leak) for a non-missing-credentials auth failure (invalid/expired/mismatched token)", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "credential_mismatch" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(401);
    expect(json.message).toMatch(/authentication failed/i);
    expect(json.governance).toBeUndefined();
  });

  it("404s when the run does not exist", async () => {
    mockedRunGet.mockResolvedValue({ exists: false });
    const { res } = await callRoute();
    expect(res.status).toBe(404);
  });

  it("403s when the caller is not the run owner, and leaks no governance/reviewer data in the response", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: "someone-else", governanceRecord: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: "reviewer-1" } }) }),
    });
    const { res, json } = await callRoute();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
    expect(json.governance).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("reviewer-1");
    expect(JSON.stringify(json)).not.toContain("Name-");
    // No identity resolution should even be attempted for an unauthorized caller.
    expect(mockedResolveReviewerDisplayNames).not.toHaveBeenCalled();
  });

  it("never fetches assignment/panel/vote data for an unauthenticated request (fails closed before any read beyond auth)", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    await callRoute();
    expect(mockedRunGet).not.toHaveBeenCalled();
    expect(mockedGetAssignment).not.toHaveBeenCalled();
    expect(mockedGetPanel).not.toHaveBeenCalled();
  });
});

describe("GET /api/user/runs/[runId]/governance — family classification", () => {
  it("returns not_configured when neither governanceRecord nor a legacy status exists", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.governance).toEqual({ family: "not_configured" });
  });

  it("returns legacy with a resolved reviewer when governanceStatus + governanceReviewedBy exist", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: UID,
        governanceStatus: "approved",
        governanceReasons: ["ok"],
        governanceReviewedBy: "reviewer-9",
        governanceReviewedAt: "2026-08-12T09:00:00.000Z",
        governanceReviewComment: "This is a private legacy comment that must never leak.",
      }),
    });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.governance).toEqual({
      family: "legacy",
      status: "approved",
      reasons: ["ok"],
      reviewer: { displayName: "Name-reviewer-9" },
      reviewedAt: "2026-08-12T09:00:00.000Z",
    });
    expect(JSON.stringify(json)).not.toContain("private legacy comment");
  });

  it("500s with governance_data_invalid (never not_configured) when governanceRecord is malformed", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID, governanceRecord: { version: 1 } }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(json.errorCode).toBe("governance_data_invalid");
    expect(json.governance).toBeUndefined();
  });

  it("returns milestone2 with assignment/panel/vote detail wired from the Firestore getters", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: UID,
        governanceRecord: baseGovernanceRecord({
          humanReview: { status: "unreviewed", comment: "internal note that must never leak" },
        }),
      }),
    });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: {
        schemaVersion: 1,
        teamId: "team-1",
        runId: RUN_ID,
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: "admin-1",
        updatedAt: "2026-08-12T10:31:00.000Z",
        updatedByUserId: "admin-1",
        revision: 1,
      },
    });
    mockedGetPanel.mockResolvedValue({
      status: "found",
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: "team-1",
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["reviewer-1", "reviewer-2"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "open",
        revision: 1,
        createdAt: "2026-08-12T10:00:00.000Z",
        createdByUserId: "admin-1",
        updatedAt: "2026-08-12T10:00:00.000Z",
        updatedByUserId: "admin-1",
      },
    });
    mockedGetVote.mockImplementation(async (_runId: string, _rev: number, reviewerId: string) => {
      if (reviewerId === "reviewer-1") {
        return {
          status: "found",
          vote: {
            schemaVersion: 1,
            kind: "adaptive_human_review_vote",
            teamId: "team-1",
            runId: RUN_ID,
            panelRevision: 1,
            reviewerUserId: "reviewer-1",
            status: "approved",
            comment: "a private vote comment that must never leak",
            commentPresent: true,
            conditionsCount: 0,
            submittedAt: "2026-08-12T10:44:00.000Z",
          },
        };
      }
      return { status: "absent" };
    });

    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.governance.family).toBe("milestone2");
    expect(json.governance.assignment).toMatchObject({ reviewerUserId: "reviewer-1", reviewerDisplayName: "Name-reviewer-1" });
    expect(json.governance.panel).toMatchObject({
      status: "open",
      requiredReviewerCount: 2,
      quorum: 2,
      submittedCount: 1,
      approvalCount: 1,
    });
    expect(json.governance.panel.reviewers).toEqual([
      { userId: "reviewer-1", displayName: "Name-reviewer-1", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
      { userId: "reviewer-2", displayName: "Name-reviewer-2", hasVoted: false },
    ]);

    // Comment/justification text must never leak into the response, even
    // though both the canonical humanReview and the vote have it populated.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("internal note that must never leak");
    expect(raw).not.toContain("a private vote comment that must never leak");
    expect(raw).not.toContain('"comment"');
    expect(raw).not.toContain("overrideJustification");
  });

  it("returns a deliberate DTO — never the raw governance/panel/vote/assignment documents wholesale (no internal version/audit metadata)", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }),
    });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: {
        schemaVersion: 1,
        teamId: "team-1",
        runId: RUN_ID,
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: "admin-1",
        updatedAt: "2026-08-12T10:31:00.000Z",
        updatedByUserId: "admin-1",
        revision: 1,
      },
    });
    mockedGetPanel.mockResolvedValue({
      status: "found",
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: "team-1",
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["reviewer-1", "reviewer-2"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "finalized",
        revision: 3,
        createdAt: "2026-08-12T10:00:00.000Z",
        createdByUserId: "admin-1",
        updatedAt: "2026-08-12T10:05:00.000Z",
        updatedByUserId: "admin-1",
        finalizedAt: "2026-08-12T10:05:00.000Z",
        finalizedByUserId: "admin-1",
        finalStatus: "rejected",
        finalDecisionId: "decision-internal-id-xyz",
        aggregationPolicyVersion: 1,
        finalizedVia: "owner_override",
        overrideJustificationPresent: true,
        overrideByUserId: "admin-1",
      },
    });
    mockedGetVote.mockResolvedValue({ status: "absent" });

    const { json } = await callRoute();
    const raw = JSON.stringify(json);

    // Internal/audit/version metadata that exists on the underlying stored
    // documents must never appear in the presentation DTO — the client only
    // ever needs status/identity/timestamps, never storage-layer internals.
    for (const forbidden of [
      "schemaVersion",
      "\"kind\"",
      "\"revision\"",
      "panelRevision",
      "aggregationPolicyVersion",
      "\"teamId\"",
      "\"runId\"", // the run's own id is already known by the caller (it's in the URL) — never redundantly echoed inside the DTO
      "createdByUserId",
      "updatedByUserId",
      "finalizedByUserId",
      "finalDecisionId",
      "mode",
      "overrideJustificationPresent",
      "overrideJustification",
      "\"comment\"",
      "idToken",
      "customClaims",
      "email", // no raw email anywhere — identity is always a resolved displayName, via the mocked resolver
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("does not fetch votes for a cancelled panel", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }) });
    mockedGetPanel.mockResolvedValue({
      status: "found",
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: "team-1",
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["reviewer-1", "reviewer-2"],
        requiredReviewerCount: 2,
        quorum: 2,
        status: "cancelled",
        revision: 2,
        createdAt: "2026-08-12T10:00:00.000Z",
        createdByUserId: "admin-1",
        updatedAt: "2026-08-12T10:05:00.000Z",
        updatedByUserId: "admin-1",
      },
    });
    const { json } = await callRoute();
    expect(mockedGetVote).not.toHaveBeenCalled();
    expect(json.governance.panel.status).toBe("cancelled");
  });
});

describe("GET /api/user/runs/[runId]/governance — identity resolution is batched, not N+1 (final review request)", () => {
  it("resolves every reviewer identity in exactly ONE call, never one call per reviewer", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }) });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: {
        schemaVersion: 1,
        teamId: "team-1",
        runId: RUN_ID,
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: "admin-1",
        updatedAt: "2026-08-12T10:31:00.000Z",
        updatedByUserId: "admin-1",
        revision: 1,
      },
    });
    mockedGetPanel.mockResolvedValue({
      status: "found",
      panel: {
        schemaVersion: 1,
        kind: "adaptive_review_panel",
        teamId: "team-1",
        runId: RUN_ID,
        mode: "majority_quorum",
        reviewerUserIds: ["reviewer-1", "reviewer-2", "reviewer-3", "reviewer-4", "reviewer-5"],
        requiredReviewerCount: 5,
        quorum: 3,
        status: "open",
        revision: 1,
        createdAt: "2026-08-12T10:00:00.000Z",
        createdByUserId: "admin-1",
        updatedAt: "2026-08-12T10:00:00.000Z",
        updatedByUserId: "admin-1",
      },
    });
    mockedGetVote.mockResolvedValue({ status: "absent" });

    await callRoute();

    // Exactly one batched call for the whole request, regardless of how
    // many distinct uids (assignment reviewer + assigner + 5 panel
    // reviewers = up to 7 candidate uids here) needed resolving — never
    // one independent Firestore round-trip per reviewer.
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledTimes(1);
    const [calledUids] = mockedResolveReviewerDisplayNames.mock.calls[0];
    expect(new Set(calledUids)).toEqual(new Set(["reviewer-1", "reviewer-2", "reviewer-3", "reviewer-4", "reviewer-5", "admin-1"]));
  });

  it("deduplicates a uid appearing in multiple roles (e.g. assigned reviewer who is also a panel reviewer) into one entry", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }) });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: {
        schemaVersion: 1,
        teamId: "team-1",
        runId: RUN_ID,
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: "reviewer-1",
        updatedAt: "2026-08-12T10:31:00.000Z",
        updatedByUserId: "reviewer-1",
        revision: 1,
      },
    });
    mockedGetPanel.mockResolvedValue({ status: "absent" });

    await callRoute();

    const [calledUids] = mockedResolveReviewerDisplayNames.mock.calls[0];
    expect(calledUids).toEqual(["reviewer-1"]);
  });
});

describe("GET /api/user/runs/[runId]/governance — canonical governance precedence over teamRuns (regression)", () => {
  it("never queries the teamRuns collection at all — canonical governanceRecord is the only source consulted", async () => {
    // A stale/conflicting teamRuns projection is wired into the shared
    // adminDb mock (see mockAdminDb.collection above) — if this route ever
    // read it, `collectionCalls` would contain "teamRuns". It must not,
    // regardless of the run's actual state.
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: "reviewer-1", decidedVia: "single_reviewer" } }) }),
    });
    const { json } = await callRoute();
    expect(collectionCalls).not.toContain("teamRuns");
    expect(json.governance.singleReviewer).toMatchObject({ userId: "reviewer-1" });
  });

  it("canonical humanReview=approved wins even though a stale teamRuns projection (wired into the mock) claims unreviewed", async () => {
    // This is the concrete scenario the review asked for: teamRuns says
    // unreviewed/in-queue (via the mock's fixed stale projection above),
    // canonical governanceRecord says approved. The response must reflect
    // ONLY the canonical value.
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: UID,
        governanceRecord: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: "reviewer-1", decidedVia: "single_reviewer", reviewedAt: "2026-08-12T10:44:00.000Z" } }),
      }),
    });
    const { json } = await callRoute();
    expect(json.governance.family).toBe("milestone2");
    expect(json.governance.singleReviewer).toEqual({ userId: "reviewer-1", displayName: "Name-reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z" });
    // The stale projection's "unreviewed" claim must not surface anywhere.
    expect(JSON.stringify(json)).not.toMatch(/"status":"unreviewed"/);
  });

  it("the reverse mismatch: canonical humanReview=unreviewed is not overridden by a hypothetical teamRuns claim of completion", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }), // default humanReview.status: "unreviewed"
    });
    const { json } = await callRoute();
    expect(collectionCalls).not.toContain("teamRuns");
    expect(json.governance.singleReviewer).toBeNull();
    expect(json.governance.assignment).toBeNull();
  });
});

describe("GET /api/user/runs/[runId]/governance — personal reviewer access", () => {
  const REVIEWER_UID = "reviewer-1";
  const OTHER_UID = "other-1";

  function personalAssignment(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      teamId: null,
      runId: RUN_ID,
      assignedReviewerUserId: REVIEWER_UID,
      assignedAt: "2026-08-12T18:00:00.000Z",
      assignedByUserId: UID,
      updatedAt: "2026-08-12T18:00:00.000Z",
      updatedByUserId: UID,
      revision: 1,
      ...overrides,
    };
  }

  it("the currently-assigned personal reviewer is granted access, viewerRole: personal_reviewer, and sees their own assignment", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }),
    });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment() });

    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.viewerRole).toBe("personal_reviewer");
    expect(json.governance.family).toBe("milestone2");
    expect(json.governance.assignment).toMatchObject({ reviewerUserId: REVIEWER_UID });
  });

  it("an unrelated user (not owner, no assignment) is denied and leaks nothing", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: REVIEWER_UID } }) }),
    });
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });

    const { res, json } = await callRoute();
    expect(res.status).toBe(403);
    expect(json.governance).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain(REVIEWER_UID);
  });

  it("Part 21 cross-run IDOR: a reviewer assigned to a different run (assignment names someone else) is denied for this run", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }),
    });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment({ assignedReviewerUserId: REVIEWER_UID }) });

    const { res } = await callRoute();
    expect(res.status).toBe(403);
  });

  it("a TEAM assignment (real teamId) never grants access through this owner-only-plus-personal route", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }),
    });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment({ teamId: "team-abc" }) });

    const { res } = await callRoute();
    expect(res.status).toBe(403);
  });

  it("exposes decisionReceipt/schemaId/answerShape/governanceUpdatedAt for a personal reviewer (Part 10/11) — needed for the review detail page and decision form's optimistic-concurrency token", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord({ decisionReceipt: { conclusion: "The panel recommends X.", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: true } }) }),
    });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment() });

    const { json } = await callRoute();
    expect(json.decisionReceipt.conclusion).toBe("The panel recommends X.");
    expect(json.schemaId).toBe("deep_research");
    expect(json.governanceUpdatedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(json.humanReviewStatus).toBe("unreviewed");
  });

  it("humanReviewStatus is sourced from the parsed governanceRecord directly — never gated behind a separate adaptiveOutput envelope check the way /api/user/runs/[runId] is (a real regression this feature introduced and fixed)", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: REVIEWER_UID } }) }),
    });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment() });
    const { json } = await callRoute();
    expect(json.humanReviewStatus).toBe("approved");
  });

  it("Part 22: an OLD assignment's reviewer keeps access to that run even though this test never touches any 'current default reviewer' concept at all — access is purely per-run canonical assignment", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: REVIEWER_UID, decidedVia: "single_reviewer" } }) }),
    });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment() });

    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.governance.singleReviewer).toMatchObject({ userId: REVIEWER_UID });
  });
});
