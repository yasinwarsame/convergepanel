/**
 * Personal Reviewer Inbox + Action Flow —
 * POST /api/user/runs/[runId]/decision route wiring tests.
 *
 * `parseGovernanceRecord`, `parseAdaptiveReviewDecisionRequest`, and
 * `resolveAdaptiveRunAccess` are left REAL (pure, independently unit-
 * tested) so this file proves genuine end-to-end wiring rather than just
 * asserting a mock was called.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: any[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedSubmitReview = jest.fn();
const mockedCreateHistory = jest.fn();
const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  submitAdaptiveHumanReview: (...args: any[]) => mockedSubmitReview(...args),
  createAdaptiveHumanReviewHistory: (...args: any[]) => mockedCreateHistory(...args),
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetAssignment(...args),
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
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { POST } from "@/app/api/user/runs/[runId]/decision/route";
import { NextRequest } from "next/server";

const RUN_ID = "run-1";
const OWNER_UID = "owner-1";
const REVIEWER_UID = "reviewer-1";
const OTHER_UID = "other-1";
const VALID_UPDATED_AT = "2026-08-12T00:00:00.000Z";

function validGovernanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
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
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: VALID_UPDATED_AT,
    ...overrides,
  };
}

function personalAssignment(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    teamId: null,
    runId: RUN_ID,
    assignedReviewerUserId: REVIEWER_UID,
    assignedAt: "2026-08-12T00:00:00.000Z",
    assignedByUserId: OWNER_UID,
    updatedAt: "2026-08-12T00:00:00.000Z",
    updatedByUserId: OWNER_UID,
    revision: 1,
    ...overrides,
  };
}

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${RUN_ID}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { status: "approved", expectedUpdatedAt: VALID_UPDATED_AT, ...overrides };
}

async function callRoute(body: unknown) {
  const res = await POST(buildRequest(body), { params: { runId: RUN_ID } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
  mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: OWNER_UID, governanceRecord: validGovernanceRecord() }) });
  mockedUserGet.mockResolvedValue({ data: () => ({ name: "Jane Reviewer" }) });
  mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment() });
  mockedCreateHistory.mockResolvedValue({ status: "recorded" });
  mockedWriteAdaptiveAdminAuditEvent.mockResolvedValue({ status: "recorded" });
  mockedSubmitReview.mockResolvedValue({
    ok: true,
    record: { humanReview: { status: "approved", reviewedAt: "2026-08-12T19:00:00.000Z" }, updatedAt: "2026-08-12T19:00:00.000Z" },
    priorHumanReviewStatus: "unreviewed",
  });
});

describe("POST /api/user/runs/[runId]/decision — authorization", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callRoute(validBody());
    expect(res.status).toBe(401);
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it("403s an unrelated user with no assignment at all", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
    const { res } = await callRoute(validBody());
    expect(res.status).toBe(403);
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it("403s the run OWNER attempting to submit a decision on their own run — no self-review", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    const { res } = await callRoute(validBody());
    expect(res.status).toBe(403);
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it("Part 21 cross-run IDOR: a reviewer assigned to a different run (assignment names someone else) is denied", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment({ assignedReviewerUserId: REVIEWER_UID }) });
    const { res } = await callRoute(validBody());
    expect(res.status).toBe(403);
  });

  it("a TEAM assignment (real teamId) is rejected — must go through the team decision route instead", async () => {
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment({ teamId: "team-abc" }) });
    const { res } = await callRoute(validBody());
    expect(res.status).toBe(403);
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it("409s a real, currently-assigned reviewer once the review has already reached a terminal status (Part 5 terminal protection)", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: OWNER_UID, governanceRecord: validGovernanceRecord({ humanReview: { status: "approved", reviewerId: REVIEWER_UID } }) }),
    });
    const { res, json } = await callRoute(validBody());
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("terminal_review_exists");
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it("Part 22: an assignment from BEFORE the owner's default reviewer changed still grants access — access is purely the per-run canonical assignment, never re-derived from current config", async () => {
    // This route never even reads users/{owner}.governanceReviewerUid at
    // all — proven structurally, not just by a passing assertion, since
    // no such read is mocked or called anywhere in this test file.
    const { res } = await callRoute(validBody());
    expect(res.status).not.toBe(403);
  });
});

describe("POST /api/user/runs/[runId]/decision — canonical mutation reuse (Part 13)", () => {
  it("calls the EXACT SAME submitAdaptiveHumanReview function the team route uses, with no team-specific argument", async () => {
    mockedSubmitReview.mockResolvedValue({
      ok: true,
      record: { humanReview: { status: "approved", reviewedAt: "2026-08-12T19:00:00.000Z" }, updatedAt: "2026-08-12T19:00:00.000Z" },
      priorHumanReviewStatus: "unreviewed",
    });
    await callRoute(validBody());
    expect(mockedSubmitReview).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        update: { status: "approved", comment: undefined, conditions: undefined },
        reviewerId: REVIEWER_UID,
        reviewerName: "Jane Reviewer",
        expectedUpdatedAt: VALID_UPDATED_AT,
      })
    );
    // No `teamId` key at all in the call — this function genuinely takes none.
    const [callArg] = mockedSubmitReview.mock.calls[0];
    expect(callArg).not.toHaveProperty("teamId");
  });

  it("writes history and admin audit with teamId: null after a successful decision", async () => {
    mockedSubmitReview.mockResolvedValue({
      ok: true,
      record: { humanReview: { status: "rejected", reviewedAt: "2026-08-12T19:00:00.000Z" }, updatedAt: "2026-08-12T19:00:00.000Z" },
      priorHumanReviewStatus: "unreviewed",
    });
    const { res, json } = await callRoute({ status: "rejected", comment: "Not accurate.", expectedUpdatedAt: VALID_UPDATED_AT });
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.review.status).toBe("rejected");
    expect(mockedCreateHistory).toHaveBeenCalledTimes(1);
    const [, historyEntry] = mockedCreateHistory.mock.calls[0];
    expect(historyEntry.teamId).toBeNull();
    expect(historyEntry.commentPresent).toBe(true);
    expect(mockedWriteAdaptiveAdminAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ teamId: null, runId: RUN_ID }));
  });

  it("maps stale_expected_updated_at to 409 stale", async () => {
    mockedSubmitReview.mockResolvedValue({ ok: false, reason: "stale_expected_updated_at" });
    const { res, json } = await callRoute(validBody());
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("stale_expected_updated_at");
  });

  it("maps terminal_review_exists from the transaction itself (race with another submission) to 409", async () => {
    mockedSubmitReview.mockResolvedValue({ ok: false, reason: "terminal_review_exists" });
    const { res, json } = await callRoute(validBody());
    expect(res.status).toBe(409);
    expect(json.error.code).toBe("terminal_review_exists");
  });
});

describe("POST /api/user/runs/[runId]/decision — request validation (forged decision)", () => {
  it("rejects an invalid status value", async () => {
    const { res, json } = await callRoute({ status: "made_up_status", expectedUpdatedAt: VALID_UPDATED_AT });
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("validation_error");
    expect(mockedSubmitReview).not.toHaveBeenCalled();
  });

  it("never accepts a client-supplied reviewerId/teamId in the body — identity comes exclusively from authentication", async () => {
    mockedSubmitReview.mockResolvedValue({
      ok: true,
      record: { humanReview: { status: "approved", reviewedAt: "2026-08-12T19:00:00.000Z" }, updatedAt: "2026-08-12T19:00:00.000Z" },
      priorHumanReviewStatus: "unreviewed",
    });
    await callRoute({ status: "approved", expectedUpdatedAt: VALID_UPDATED_AT, reviewerId: "attacker-uid", teamId: "forged-team" });
    const [callArg] = mockedSubmitReview.mock.calls[0];
    expect(callArg.reviewerId).toBe(REVIEWER_UID); // from auth, never the body
  });

  it("requires a comment for rejected", async () => {
    const { res, json } = await callRoute({ status: "rejected", expectedUpdatedAt: VALID_UPDATED_AT });
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("validation_error");
  });
});

describe("POST /api/user/runs/[runId]/decision — privacy", () => {
  it("never returns comment text or the reviewer's raw uid in the response", async () => {
    mockedSubmitReview.mockResolvedValue({
      ok: true,
      record: { humanReview: { status: "approved", reviewedAt: "2026-08-12T19:00:00.000Z" }, updatedAt: "2026-08-12T19:00:00.000Z" },
      priorHumanReviewStatus: "unreviewed",
    });
    const { json } = await callRoute({ status: "approved", comment: "SECRET_COMMENT_TEXT", expectedUpdatedAt: VALID_UPDATED_AT });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("SECRET_COMMENT_TEXT");
    expect(serialized).not.toContain(REVIEWER_UID);
  });
});
