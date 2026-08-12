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
const mockAdminDb: any = {
  collection: () => ({
    doc: () => ({
      get: async () => mockedRunGet(),
    }),
  }),
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

const mockedResolveReviewerDisplayName = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayName: (...args: any[]) => mockedResolveReviewerDisplayName(...args),
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
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
  mockedGetPanel.mockResolvedValue({ status: "absent" });
  mockedGetVote.mockResolvedValue({ status: "absent" });
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "owner@example.com" }, team: null });
  mockedResolveReviewerDisplayName.mockImplementation(async (uid: string) => `Name-${uid}`);
});

describe("GET /api/user/runs/[runId]/governance — auth", () => {
  it("401s when unauthenticated (missing credentials)", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(401);
    expect(json.message).toMatch(/sign in/i);
  });

  it("404s when the run does not exist", async () => {
    mockedRunGet.mockResolvedValue({ exists: false });
    const { res } = await callRoute();
    expect(res.status).toBe(404);
  });

  it("403s when the caller is not the run owner", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: "someone-else" }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
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
