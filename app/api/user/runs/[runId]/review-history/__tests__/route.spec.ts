/**
 * Governance Follow-Up Hardening — GET /api/user/runs/[runId]/review-history
 * tests. `resolveAdaptiveRunAccess` and `classifyAdaptiveHumanReviewHistoryRow`
 * are left REAL (pure, independently unit-tested elsewhere) so this file
 * proves genuine end-to-end wiring, not just that a mock was called.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: any[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedGetAssignment = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...args: any[]) => mockedGetAssignment(...args),
}));

const mockedResolveReviewerDisplayNames = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: (...args: any[]) => mockedResolveReviewerDisplayNames(...args),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
  REVIEWER_UNAVAILABLE_LABEL: "Reviewer unavailable",
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
}));

const mockedRunGet = jest.fn();
const mockedHistoryGet = jest.fn();
const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => mockedRunGet(name, id),
      collection: (subName: string) => ({
        get: async () => mockedHistoryGet(name, id, subName),
      }),
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

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/review-history/route";

const RUN_ID = "run-1";
const OWNER_UID = "owner-1";
const REVIEWER_UID = "reviewer-1";
const OTHER_UID = "other-1";

function validGovernanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "approved" },
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
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function personalAssignment(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    teamId: null,
    runId: RUN_ID,
    assignedReviewerUserId: REVIEWER_UID,
    assignedAt: "2026-08-12T10:31:00.000Z",
    assignedByUserId: OWNER_UID,
    updatedAt: "2026-08-12T10:31:00.000Z",
    updatedByUserId: OWNER_UID,
    revision: 1,
    ...overrides,
  };
}

function validHistoryDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "adaptive_human_review",
    priorStatus: "unreviewed",
    newStatus: "approved",
    reviewedAt: "2026-08-12T23:06:38.207Z",
    commentPresent: false,
    conditionsCount: 0,
    reviewerId: REVIEWER_UID,
    teamId: null,
    runId: RUN_ID,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    decisionId: "dec_1",
    ...overrides,
  };
}

function fakeHistorySnap(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
}

async function callRoute(runId: string = RUN_ID) {
  const req = new NextRequest(`http://localhost/api/user/runs/${runId}/review-history`);
  const res = await GET(req, { params: Promise.resolve({ runId }) });
  return { res, json: await res.json() };
}

beforeEach(() => {
  mockedResolveRequestIdentity.mockReset();
  mockedLogIdentityResolutionFailure.mockReset();
  mockedGetAssignment.mockReset();
  mockedResolveReviewerDisplayNames.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedRunGet.mockReset();
  mockedHistoryGet.mockReset();
  mockLoggerWarn.mockClear();

  mockedLoadUserAndTeam.mockResolvedValue(null);
  mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((uid) => [uid, `Name-${uid}`])));
  mockedRunGet.mockResolvedValue({
    exists: true,
    data: () => ({ userId: OWNER_UID, governanceRecord: validGovernanceRecord() }),
  });
  mockedHistoryGet.mockResolvedValue(fakeHistorySnap([{ id: "dec_1", data: validHistoryDoc() }]));
  mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment() });
});

describe("GET /api/user/runs/[runId]/review-history — auth", () => {
  it("401 when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callRoute();
    expect(res.status).toBe(401);
  });

  it("404 when the run does not exist", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedRunGet.mockResolvedValue({ exists: false });
    const { res } = await callRoute();
    expect(res.status).toBe(404);
  });
});

describe("GET /api/user/runs/[runId]/review-history — authorization (Part 16)", () => {
  it("owner allowed", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("assigned personal reviewer allowed", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("unassigned/unrelated user denied", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(403);
    expect(json.ok).toBe(false);
  });

  it("cross-run IDOR: a reviewer assigned to a DIFFERENT run (assignment names someone else here) is denied for this run — no enumeration", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment({ assignedReviewerUserId: REVIEWER_UID }) });
    const { res } = await callRoute();
    expect(res.status).toBe(403);
  });

  it("a TEAM-assigned reviewer (real teamId) is never granted access through this route — never routes personal history through fake team membership", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
    mockedGetAssignment.mockResolvedValue({ status: "found", assignment: personalAssignment({ teamId: "team-abc" }) });
    const { res } = await callRoute();
    expect(res.status).toBe(403);
  });

  it("owner of a run with no assignment at all is still allowed (owner role never depends on an assignment existing)", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
    const { res } = await callRoute();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/user/runs/[runId]/review-history — canonical history only (Part 7)", () => {
  it("returns exactly the canonical humanReviewHistory rows, never synthesized from current status/assignment", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    const { json } = await callRoute();
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toMatchObject({ newStatus: "approved", priorStatus: "unreviewed", reviewedAt: "2026-08-12T23:06:38.207Z" });
  });

  it("returns an empty array (not an error) when no history exists yet — a real, distinct empty state", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedHistoryGet.mockResolvedValue(fakeHistorySnap([]));
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.items).toEqual([]);
  });

  it("skips a malformed history row rather than fabricating or crashing", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedHistoryGet.mockResolvedValue(fakeHistorySnap([{ id: "bad_1", data: { version: 1, kind: "adaptive_human_review", newStatus: "not_a_real_status" } }]));
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.items).toEqual([]);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("degrades to 503 on a genuine Firestore read failure — never a false empty list", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedHistoryGet.mockRejectedValue(new Error("boom"));
    const { res } = await callRoute();
    expect(res.status).toBe(503);
  });

  it("orders multiple entries by reviewedAt ascending, same as the team route's own comparator", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedHistoryGet.mockResolvedValue(
      fakeHistorySnap([
        { id: "dec_2", data: validHistoryDoc({ reviewedAt: "2026-08-13T00:00:00.000Z", decisionId: "dec_2" }) },
        { id: "dec_1", data: validHistoryDoc({ reviewedAt: "2026-08-12T00:00:00.000Z", decisionId: "dec_1" }) },
      ])
    );
    const { json } = await callRoute();
    expect(json.items.map((i: any) => i.reviewedAt)).toEqual(["2026-08-12T00:00:00.000Z", "2026-08-13T00:00:00.000Z"]);
  });
});

describe("GET /api/user/runs/[runId]/review-history — Part 8 safe DTO / Part 17 privacy", () => {
  it("includes a resolved reviewerDisplayName per item", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    const { json } = await callRoute();
    expect(json.items[0].reviewerDisplayName).toBe(`Name-${REVIEWER_UID}`);
  });

  it("resolves display names in exactly one batched call, not one per row", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedHistoryGet.mockResolvedValue(
      fakeHistorySnap([
        { id: "dec_1", data: validHistoryDoc({ decisionId: "dec_1" }) },
        { id: "dec_2", data: validHistoryDoc({ decisionId: "dec_2", reviewedAt: "2026-08-13T00:00:00.000Z" }) },
      ])
    );
    await callRoute();
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledTimes(1);
  });

  it("never exposes a raw reviewer/owner uid, comment text, or audit metadata — only the documented safe fields", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    mockedHistoryGet.mockResolvedValue(
      fakeHistorySnap([{ id: "dec_1", data: validHistoryDoc({ comment: "PRIVATE comment text", overrideJustification: "PRIVATE justification" }) }])
    );
    const { json } = await callRoute();
    expect(json.items[0]).not.toHaveProperty("reviewerId");
    expect(json.items[0]).not.toHaveProperty("comment");
    expect(json.items[0]).not.toHaveProperty("overrideJustification");
    expect(json.items[0]).not.toHaveProperty("teamId");
    expect(json.items[0]).not.toHaveProperty("decisionId");
    const raw = JSON.stringify(json);
    expect(raw).not.toContain("PRIVATE");
    // Field-presence check, not a substring scan — this mock's resolved
    // display name is literally "Name-<uid>", so the raw uid IS a
    // substring of the safe, expected output (same pitfall documented in
    // reviewGovernanceViewModel.spec.ts). The toHaveProperty assertions
    // above are the real guarantee.
    expect(raw).toContain(`Name-${REVIEWER_UID}`);
  });

  it("an unrelated user's denial response leaks nothing about the run's history", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    mockedGetAssignment.mockResolvedValue({ status: "unassigned" });
    const { json } = await callRoute();
    expect(json.items).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain(REVIEWER_UID);
  });
});

describe("GET /api/user/runs/[runId]/review-history — reviewer identity fallback (personal-review-reviewer-identity fix)", () => {
  it("passes REVIEWER_UNAVAILABLE_LABEL as the resolver's unresolved-label fallback, never the generic UNKNOWN_REVIEWER_LABEL", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    await callRoute();
    const call = mockedResolveReviewerDisplayNames.mock.calls[0];
    expect(call[3]).toBe("Reviewer unavailable");
  });

  it("a canonical history row whose reviewerId genuinely fails to resolve shows 'Reviewer unavailable', never 'Unknown reviewer'", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID });
    // Simulates the real resolver's own terminal-fallback behavior (it
    // always fills every requested uid using whatever unresolvedLabel it
    // was given — see reviewerIdentity.spec.ts) rather than ever omitting
    // an entry, so the route's own `?? REVIEWER_UNAVAILABLE_LABEL` default
    // is a pure defensive backstop, not the primary path under test here.
    mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[], _emailByUid: unknown, _callerEmail: unknown, unresolvedLabel: string) => new Map(uids.map((uid) => [uid, unresolvedLabel])));
    const { json } = await callRoute();
    expect(json.items[0].reviewerDisplayName).toBe("Reviewer unavailable");
    expect(json.items[0].reviewerDisplayName).not.toBe("Unknown reviewer");
  });
});
