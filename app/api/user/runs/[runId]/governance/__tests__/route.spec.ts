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
  REVIEWER_UNAVAILABLE_LABEL: "Reviewer unavailable",
}));

// Personal-workspace runs (`workspaceId: personal-<owner>`) resolve as the
// owner's own personal workspace; any other workspace id is not found. Legacy
// runs (no `workspaceId`) never reach the resolver.
const mockedResolveWorkspace = jest.fn();
jest.mock("@/lib/workspaces/workspaceResolver", () => {
  const { getPersonalWorkspaceId } = jest.requireActual("@/lib/workspaces/personalWorkspaceId");
  return {
    resolveWorkspaceContextForResource: async (args: { workspaceId: string; legacyOwnerUserId: string }) => {
      mockedResolveWorkspace(args);
      const personal = getPersonalWorkspaceId(args.legacyOwnerUserId);
      if (personal.ok && personal.workspaceId === args.workspaceId) {
        return { kind: "resolved", context: { mode: "workspace", workspaceId: args.workspaceId, workspaceType: "personal", ownerUserId: args.legacyOwnerUserId } };
      }
      return { kind: "not_found" };
    },
  };
});

const mockLoggerWarn = jest.fn();
// Every logger level is recorded with its full structured payload, so the
// pre-authorization-oracle tests below can compare what an unauthorized
// request writes to the server log, not just the message text.
const mockLoggerCalls: Array<[string, ...unknown[]]> = [];
jest.mock("@/lib/logger", () => ({
  logger: {
    warn: (...args: unknown[]) => {
      mockLoggerCalls.push(["warn", ...args]);
      mockLoggerWarn(...args);
    },
    info: (...args: unknown[]) => mockLoggerCalls.push(["info", ...args]),
    error: (...args: unknown[]) => mockLoggerCalls.push(["error", ...args]),
    debug: (...args: unknown[]) => mockLoggerCalls.push(["debug", ...args]),
  },
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
    expect(json.governance.assignment).toMatchObject({ reviewerDisplayName: "Name-reviewer-1" });
    expect(json.governance.panel).toMatchObject({
      status: "open",
      requiredReviewerCount: 2,
      quorum: 2,
      submittedCount: 1,
      approvalCount: 1,
    });
    expect(json.governance.panel.reviewers).toEqual([
      { reviewerKey: "panelist-0", displayName: "Name-reviewer-1", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
      { reviewerKey: "panelist-1", displayName: "Name-reviewer-2", hasVoted: false },
    ]);

    // Comment/justification text must never leak into the response, even
    // though both the canonical humanReview and the vote have it populated.
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("internal note that must never leak");
    // Governance Follow-Up Hardening — raw reviewer/owner uid FIELDS must
    // never appear in the response, only resolved display names. A
    // substring scan for the raw uid itself is unreliable here (this
    // file's mock resolver returns "Name-<uid>", so the uid IS a
    // substring of the safe, expected display name) — assert field
    // absence instead, which is exact.
    expect(json.governance.assignment).not.toHaveProperty("reviewerUserId");
    expect(json.governance.assignment).not.toHaveProperty("assignedByUserId");
    for (const reviewer of json.governance.panel.reviewers) {
      expect(reviewer).not.toHaveProperty("userId");
    }
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

describe("GET /api/user/runs/[runId]/governance — automatedGovernance exposure (corrective pass on PR #37: fixes the misleading 'Unknown' badge)", () => {
  it("includes status/evaluatedAt/policyVersion when the run has a real automated-governance record — mirrors AdaptiveReviewDetailResponseV1's own exposure exactly", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: UID,
        governanceRecord: baseGovernanceRecord({
          automatedGovernance: { status: "flagged", reasons: ["policy X", "policy Y"], evaluatedAt: "2026-08-13T09:00:00.000Z", policyVersion: 3 },
        }),
      }),
    });
    const { json } = await callRoute();
    expect(json.automatedGovernance).toEqual({ status: "flagged", evaluatedAt: "2026-08-13T09:00:00.000Z", policyVersion: 3 });
  });

  it("never includes 'reasons' — policy-internal text, never exposed to any reviewer/owner surface (same discipline as AdaptiveReviewDetailResponseV1)", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: UID,
        governanceRecord: baseGovernanceRecord({
          automatedGovernance: { status: "blocked", reasons: ["PRIVATE POLICY REASON TEXT"], evaluatedAt: "2026-08-13T09:00:00.000Z", policyVersion: 1 },
        }),
      }),
    });
    const { json } = await callRoute();
    expect(json.automatedGovernance).not.toHaveProperty("reasons");
    expect(JSON.stringify(json)).not.toContain("PRIVATE POLICY REASON TEXT");
  });

  it("is undefined (never a fabricated placeholder) when the run genuinely has no automated-governance record at all — the exact condition that used to render a misleading 'Unknown' badge on the client", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }), // no automatedGovernance key
    });
    const { json } = await callRoute();
    expect(json.automatedGovernance).toBeUndefined();
  });

  it("is undefined for the legacy family (no governanceRecord at all) — same as every other governanceRecord-only field on this response", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceStatus: "approved", governanceReviewedBy: "reviewer-9" }),
    });
    const { json } = await callRoute();
    expect(json.automatedGovernance).toBeUndefined();
  });

  it("a genuine 'not_evaluated' status is passed through as real data, distinct from the field being absent", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({
        userId: UID,
        governanceRecord: baseGovernanceRecord({
          automatedGovernance: { status: "not_evaluated", reasons: [], evaluatedAt: "2026-08-13T09:00:00.000Z", policyVersion: 1 },
        }),
      }),
    });
    const { json } = await callRoute();
    expect(json.automatedGovernance).toEqual({ status: "not_evaluated", evaluatedAt: "2026-08-13T09:00:00.000Z", policyVersion: 1 });
  });
});

describe("GET /api/user/runs/[runId]/governance — reviewer identity fallback (personal-review-reviewer-identity fix)", () => {
  it("passes REVIEWER_UNAVAILABLE_LABEL as the resolver's unresolved-label fallback for a personal assignment, never UNKNOWN_REVIEWER_LABEL", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }) });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: RUN_ID,
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: UID,
        updatedAt: "2026-08-12T10:31:00.000Z",
        updatedByUserId: UID,
        revision: 1,
      },
    });
    await callRoute();
    const call = mockedResolveReviewerDisplayNames.mock.calls[0];
    expect(call[3]).toBe("Reviewer unavailable");
  });

  it("a personal assignment whose reviewer identity genuinely fails to resolve shows 'Reviewer unavailable', never 'Unknown reviewer' — the exact defect this fix addresses", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }) });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: {
        schemaVersion: 1,
        teamId: null,
        runId: RUN_ID,
        assignedReviewerUserId: "reviewer-1",
        assignedAt: "2026-08-12T10:31:00.000Z",
        assignedByUserId: UID,
        updatedAt: "2026-08-12T10:31:00.000Z",
        updatedByUserId: UID,
        revision: 1,
      },
    });
    // Simulates the real resolver's own behavior of filling every requested
    // uid with the caller-supplied unresolvedLabel (see
    // reviewerIdentity.spec.ts) rather than ever omitting an entry.
    mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[], _emailByUid: unknown, _callerEmail: unknown, unresolvedLabel: string) => new Map(uids.map((uid) => [uid, unresolvedLabel])));
    const { json } = await callRoute();
    expect(json.governance.assignment.reviewerDisplayName).toBe("Reviewer unavailable");
    expect(json.governance.assignment.reviewerDisplayName).not.toBe("Unknown reviewer");
  });

  it("cross-surface consistency: the SAME reviewer uid resolves to the SAME display name whether it's an in-progress assignment or a completed singleReviewer decision", async () => {
    mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((uid) => [uid, `Resolved-${uid}`])));

    // Pending: assignment only.
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord() }) });
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: { schemaVersion: 1, teamId: null, runId: RUN_ID, assignedReviewerUserId: "reviewer-1", assignedAt: "2026-08-12T10:31:00.000Z", assignedByUserId: UID, updatedAt: "2026-08-12T10:31:00.000Z", updatedByUserId: UID, revision: 1 },
    });
    const pending = await callRoute();
    expect(pending.json.governance.assignment.reviewerDisplayName).toBe("Resolved-reviewer-1");

    // Same reviewer, now a completed decision — identity source shifts from
    // assignment to singleReviewer, but must resolve to the identical name.
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, governanceRecord: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: "reviewer-1", decidedVia: "single_reviewer" } }) }),
    });
    const completed = await callRoute();
    expect(completed.json.governance.singleReviewer.displayName).toBe("Resolved-reviewer-1");
    expect(completed.json.governance.singleReviewer.displayName).toBe(pending.json.governance.assignment.reviewerDisplayName);
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
    expect(json.governance.singleReviewer).toMatchObject({ displayName: "Name-reviewer-1" });
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
    expect(json.governance.singleReviewer).toEqual({ displayName: "Name-reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z" });
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
    expect(json.governance.assignment).toBeDefined();
    expect(json.governance.assignment).not.toHaveProperty("reviewerUserId");
    expect(json.governance.assignment).not.toHaveProperty("assignedByUserId");
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
    expect(json.governance.singleReviewer).toBeDefined();
    expect(json.governance.singleReviewer).not.toHaveProperty("userId");
  });
});

// ─── Order 6: P2_PREAUTH_GOVERNANCE_ERROR_ORACLE_REVIEW_REQUIRED ───────────
//
// An unauthorized caller must not be able to tell an unreadable governance
// record from an absent or readable one: same status, body, headers, read
// sequence and logging for every record state. Authorized viewers (owner,
// current personal reviewer) keep the existing semantics, including the 500
// for an unreadable record.
describe("GET /api/user/runs/[runId]/governance — pre-authorization oracle (record state is invisible to unauthorized callers)", () => {
  const REVIEWER_UID = "reviewer-1";

  const RECORD_STATES: Record<string, { present: boolean; value?: unknown }> = {
    absent: { present: false },
    null: { present: true, value: null },
    valid: { present: true, value: baseGovernanceRecord() },
    decided: { present: true, value: baseGovernanceRecord({ humanReview: { status: "approved", reviewerId: REVIEWER_UID, reviewedAt: "2026-08-12T10:00:00.000Z", decidedVia: "single_reviewer" } }) },
    malformed: { present: true, value: { version: 1 } },
    unsupported_version: { present: true, value: { ...baseGovernanceRecord(), version: 2 } },
    non_object: { present: true, value: "garbage" },
    array: { present: true, value: [baseGovernanceRecord()] },
  };
  const UNREADABLE = ["malformed", "unsupported_version", "non_object", "array"];

  const RUN_KINDS: Record<string, Record<string, unknown>> = {
    legacy: {},
    personal_workspace: { workspaceId: `personal-${UID}` },
  };

  function assignment(overrides: Record<string, unknown> = {}) {
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

  // Every unauthorized shape the route can see. "Former reviewer" and
  // "unrelated reviewer" both reach the route as an assignment that names
  // someone else; they are kept as separate rows to document both scenarios.
  const UNAUTHORIZED: Record<string, { uid: string; assignmentResult: unknown }> = {
    unrelated_signed_in: { uid: "stranger-9", assignmentResult: { status: "unassigned" } },
    former_reviewer: { uid: "former-reviewer", assignmentResult: { status: "found", assignment: assignment() } },
    unrelated_reviewer: { uid: "reviewer-of-another-run", assignmentResult: { status: "found", assignment: assignment() } },
    team_assignee: { uid: REVIEWER_UID, assignmentResult: { status: "found", assignment: assignment({ teamId: "team-abc" }) } },
    stranger_assignment_read_failed: { uid: "stranger-9", assignmentResult: { status: "read_failed" } },
  };

  const FORBIDDEN_BODY = { ok: false, errorCode: "forbidden", message: "You do not have access to this run." };

  function setRun(kind: string, state: string) {
    const doc: Record<string, unknown> = { userId: UID, ...RUN_KINDS[kind] };
    if (RECORD_STATES[state].present) doc.governanceRecord = RECORD_STATES[state].value;
    mockedRunGet.mockResolvedValue({ exists: true, data: () => doc });
  }

  /** Calls the route and records everything an unauthorized caller could observe, plus every dependency the route touched. */
  async function observe() {
    const res = await GET(buildRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
    const body = await res.json();
    const headers = Object.fromEntries(res.headers.entries());
    delete headers["content-length"];
    return {
      status: res.status,
      body,
      headers,
      reads: {
        run: mockedRunGet.mock.calls.length,
        assignment: mockedGetAssignment.mock.calls.length,
        panel: mockedGetPanel.mock.calls.length,
        vote: mockedGetVote.mock.calls.length,
        team: mockedLoadUserAndTeam.mock.calls.length,
        displayNames: mockedResolveReviewerDisplayNames.mock.calls.length,
        workspace: mockedResolveWorkspace.mock.calls.length,
      },
      warns: mockLoggerWarn.mock.calls.map((c) => c[0]),
      // Every server-log call at every level, with its full structured payload.
      logs: mockLoggerCalls.map((c) => [...c]),
    };
  }

  function resetCallCounts() {
    jest.clearAllMocks();
    mockLoggerCalls.length = 0;
    mockedGetPanel.mockResolvedValue({ status: "absent" });
    mockedGetVote.mockResolvedValue({ status: "absent" });
    mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "x@example.com" }, team: null });
    mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((u) => [u, `Name-${u}`])));
  }

  for (const kind of Object.keys(RUN_KINDS)) {
    for (const [caller, setup] of Object.entries(UNAUTHORIZED)) {
      it(`${kind} run, ${caller}: every record state gives the identical 403 — status, body, headers, reads and logging`, async () => {
        const seen: Record<string, Awaited<ReturnType<typeof observe>>> = {};
        for (const state of Object.keys(RECORD_STATES)) {
          resetCallCounts();
          mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: setup.uid });
          mockedGetAssignment.mockResolvedValue(setup.assignmentResult);
          setRun(kind, state);
          seen[state] = await observe();
        }
        const reference = seen.valid;
        expect(reference.status).toBe(403);
        expect(reference.body).toEqual(FORBIDDEN_BODY);
        // Authorization needs exactly the run read and the assignment read — no panel,
        // vote, team or identity lookups for a caller who is denied.
        expect(reference.reads).toEqual({
          run: 1,
          assignment: 1,
          panel: 0,
          vote: 0,
          team: 0,
          displayNames: 0,
          workspace: kind === "personal_workspace" ? 1 : 0,
        });
        for (const [state, o] of Object.entries(seen)) {
          // Includes `logs`: every server-log call, at every level, with its full
          // payload, must be identical across record states.
          expect({ state, ...o }).toEqual({ state, ...reference });
          // An unauthorized caller can never trigger the unreadable-record warning.
          expect(o.warns).not.toContain("[user/runs/governance] Unreadable governanceRecord");
          // Nor put anything about the governance record into any log payload:
          // no parser outcome, no review status, no record content.
          const logged = JSON.stringify(o.logs);
          for (const token of ["malformed", "unsupported_version", "absent", "unreviewed", "approved", "garbage", "governanceRecord", "humanReview"]) {
            expect({ state, token, found: logged.includes(token) }).toEqual({ state, token, found: false });
          }
        }
      });
    }
  }

  for (const kind of Object.keys(RUN_KINDS)) {
    describe(`${kind} run — authorized viewers keep the existing semantics`, () => {
      const AUTHORIZED: Record<string, { uid: string; assignmentResult: unknown; role: string }> = {
        owner: { uid: UID, assignmentResult: { status: "unassigned" }, role: "owner" },
        current_personal_reviewer: { uid: REVIEWER_UID, assignmentResult: { status: "found", assignment: assignment() }, role: "personal_reviewer" },
      };

      for (const [who, setup] of Object.entries(AUTHORIZED)) {
        for (const state of UNREADABLE) {
          it(`${who} + ${state} record → 500 governance_data_invalid, logged once with runId and reason only, after the access check`, async () => {
            resetCallCounts();
            mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: setup.uid });
            mockedGetAssignment.mockResolvedValue(setup.assignmentResult);
            setRun(kind, state);
            const o = await observe();
            expect(o.status).toBe(500);
            expect(o.body).toEqual({ ok: false, errorCode: "governance_data_invalid", message: "Review information unavailable." });
            expect(o.warns).toEqual(["[user/runs/governance] Unreadable governanceRecord"]);
            expect(Object.keys(mockLoggerWarn.mock.calls[0][1] as object).sort()).toEqual(["reason", "runId"]);
            // Authorization (which needs the assignment) is resolved before the 500.
            expect(o.reads.assignment).toBe(1);
            expect(o.reads.panel).toBe(0);
            expect(o.reads.displayNames).toBe(0);
          });
        }

        for (const state of ["absent", "null"]) {
          it(`${who} + ${state} record → 200 not_configured (the absent-record exemption)`, async () => {
            resetCallCounts();
            mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: setup.uid });
            mockedGetAssignment.mockResolvedValue(setup.assignmentResult);
            setRun(kind, state);
            const o = await observe();
            expect(o.status).toBe(200);
            expect(o.body.governance).toEqual({ family: "not_configured" });
            expect(o.body.viewerRole).toBe(setup.role);
            expect(o.warns).not.toContain("[user/runs/governance] Unreadable governanceRecord");
          });
        }

        it(`${who} + valid record → 200 milestone2`, async () => {
          resetCallCounts();
          mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: setup.uid });
          mockedGetAssignment.mockResolvedValue(setup.assignmentResult);
          setRun(kind, "valid");
          const o = await observe();
          expect(o.status).toBe(200);
          expect(o.body.governance.family).toBe("milestone2");
          expect(o.body.viewerRole).toBe(setup.role);
          expect(o.warns).toEqual([]);
        });
      }
    });
  }

  it("unauthenticated caller → the same 401 before any read, whatever the record holds", async () => {
    for (const state of Object.keys(RECORD_STATES)) {
      resetCallCounts();
      mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
      setRun("legacy", state);
      const o = await observe();
      expect(o.status).toBe(401);
      expect(o.body).toEqual({ ok: false, errorCode: "unauthorized", message: "Please sign in." });
      expect(o.reads.run).toBe(0);
      expect(o.reads.assignment).toBe(0);
    }
  });

  it("a Team-bound run (workspaceId that is not the owner's personal workspace) is still 404 for owner and stranger alike, before the record or the assignment is touched", async () => {
    for (const uid of [UID, "stranger-9"]) {
      for (const state of Object.keys(RECORD_STATES)) {
        resetCallCounts();
        mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid });
        mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
        const doc: Record<string, unknown> = { userId: UID, workspaceId: "team-ws-abc" };
        if (RECORD_STATES[state].present) doc.governanceRecord = RECORD_STATES[state].value;
        mockedRunGet.mockResolvedValue({ exists: true, data: () => doc });
        const o = await observe();
        expect(o.status).toBe(404);
        expect(o.body).toEqual({ ok: false, errorCode: "not_found", message: "Run not found." });
        expect(o.reads.assignment).toBe(0);
        expect(o.warns).toEqual(["[user/runs/governance] workspace_run_integrity_failed"]);
      }
    }
  });

  it("authorization does not depend on the record: across every record state a stranger is always denied and the current reviewer is never denied", async () => {
    for (const kind of Object.keys(RUN_KINDS)) {
      for (const state of Object.keys(RECORD_STATES)) {
        resetCallCounts();
        mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: "stranger-9" });
        mockedGetAssignment.mockResolvedValue({ status: "found", assignment: assignment() });
        setRun(kind, state);
        expect((await observe()).status).toBe(403);

        resetCallCounts();
        mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
        mockedGetAssignment.mockResolvedValue({ status: "found", assignment: assignment() });
        setRun(kind, state);
        expect((await observe()).status).not.toBe(403);
      }
    }
  });
});
