/**
 * Personal Reviewer Inbox + Action Flow — GET /api/user/reviews tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

const mockedLogIdentityResolutionFailure = jest.fn();
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: (...args: any[]) => mockedLogIdentityResolutionFailure(...args),
}));

const mockedResolveReviewerDisplayNames = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: (...args: any[]) => mockedResolveReviewerDisplayNames(...args),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// A minimal, purpose-built Firestore mock: collectionGroup(...).where().where().orderBy().limit().get()
// plus adminDb.getAll(...refs) batching, matching this route's exact call shape.
type AssignmentDoc = { runId: string; assignedReviewerUserId: string; teamId: string | null; assignedAt: string };
let assignmentFixtures: AssignmentDoc[] = [];
const runDocsByRunId = new Map<string, Record<string, unknown> | undefined>();
const getAllCalls: string[][] = [];
let collectionGroupQueryError: Error | null = null;

function makeRunRef(runId: string) {
  return {
    id: runId,
    __isRunRef: true,
  } as any;
}

function makeQuery(filters: Record<string, unknown>): any {
  return {
    where(field: string, _op: string, value: unknown) {
      return makeQuery({ ...filters, [field]: value });
    },
    orderBy() {
      return makeQuery(filters);
    },
    limit() {
      return makeQuery(filters);
    },
    async get() {
      if (collectionGroupQueryError) throw collectionGroupQueryError;
      const matches = assignmentFixtures.filter(
        (a) => a.assignedReviewerUserId === filters.assignedReviewerUserId && a.teamId === filters.teamId
      );
      return {
        docs: matches.map((a) => ({
          data: () => ({ assignedAt: a.assignedAt }),
          ref: { parent: { parent: makeRunRef(a.runId) } },
        })),
      };
    },
  };
}

const mockAdminDb: any = {
  collectionGroup: (name: string) => {
    if (name !== "humanReviewAssignment") throw new Error(`unexpected collectionGroup: ${name}`);
    return makeQuery({});
  },
  getAll: async (...refs: any[]) => {
    getAllCalls.push(refs.map((r) => r.id));
    return refs.map((r) => {
      const data = runDocsByRunId.get(r.id);
      return { id: r.id, exists: data !== undefined, data: () => data };
    });
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/reviews/route";

const REVIEWER_UID = "reviewer-1";

function runData(overrides: Record<string, unknown> = {}) {
  return {
    userId: "owner-1",
    question: "What are the trends?",
    governanceRecord: {
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      humanReview: { status: "unreviewed" },
    },
    ...overrides,
  };
}

function buildRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/user/reviews${query}`);
}

async function callRoute(query = "") {
  const res = await GET(buildRequest(query));
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  assignmentFixtures = [];
  runDocsByRunId.clear();
  getAllCalls.length = 0;
  collectionGroupQueryError = null;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER_UID });
  mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((uid) => [uid, `Name-${uid}`])));
});

describe("GET /api/user/reviews — auth", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const { res } = await callRoute();
    expect(res.status).toBe(401);
  });

  it("Part 8: the uid comes exclusively from authentication — a query param cannot substitute another reviewer's uid", async () => {
    assignmentFixtures = [{ runId: "run-1", assignedReviewerUserId: "someone-else", teamId: null, assignedAt: "2026-08-12T18:00:00.000Z" }];
    runDocsByRunId.set("run-1", runData());
    // Even if a client tried to pass a uid override, this route accepts no such parameter at all.
    const { json } = await callRoute("?uid=someone-else");
    expect(json.items).toHaveLength(0);
  });
});

describe("GET /api/user/reviews — discovery", () => {
  it("returns an empty list when no assignments exist", async () => {
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.items).toEqual([]);
  });

  it("returns the caller's own personal (teamId: null) assignments only", async () => {
    assignmentFixtures = [
      { runId: "run-1", assignedReviewerUserId: REVIEWER_UID, teamId: null, assignedAt: "2026-08-12T18:00:00.000Z" },
      { runId: "run-team", assignedReviewerUserId: REVIEWER_UID, teamId: "team-abc", assignedAt: "2026-08-12T18:00:00.000Z" },
    ];
    runDocsByRunId.set("run-1", runData());
    runDocsByRunId.set("run-team", runData());

    const { json } = await callRoute();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].runId).toBe("run-1");
  });

  it("never exposes another reviewer's assignments (Part 8 no-enumeration)", async () => {
    assignmentFixtures = [{ runId: "run-1", assignedReviewerUserId: "different-reviewer", teamId: null, assignedAt: "2026-08-12T18:00:00.000Z" }];
    runDocsByRunId.set("run-1", runData());
    const { json } = await callRoute();
    expect(json.items).toHaveLength(0);
  });

  it("skips a run that no longer exists rather than crashing", async () => {
    assignmentFixtures = [{ runId: "run-gone", assignedReviewerUserId: REVIEWER_UID, teamId: null, assignedAt: "2026-08-12T18:00:00.000Z" }];
    // Never call runDocsByRunId.set for run-gone — simulates a deleted run doc.
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.items).toEqual([]);
  });

  it("skips a run with a malformed governance record rather than fabricating a row", async () => {
    assignmentFixtures = [{ runId: "run-bad", assignedReviewerUserId: REVIEWER_UID, teamId: null, assignedAt: "2026-08-12T18:00:00.000Z" }];
    runDocsByRunId.set("run-bad", { userId: "owner-1", question: "q" }); // no governanceRecord
    const { json } = await callRoute();
    expect(json.items).toEqual([]);
  });

  it("a Firestore query failure degrades to 503, never a false empty list", async () => {
    collectionGroupQueryError = new Error("boom");
    const { res, json } = await callRoute();
    expect(res.status).toBe(503);
    expect(json.ok).toBe(false);
  });
});

describe("GET /api/user/reviews — filtering (Part 32/33)", () => {
  beforeEach(() => {
    assignmentFixtures = [
      { runId: "run-assigned", assignedReviewerUserId: REVIEWER_UID, teamId: null, assignedAt: "2026-08-12T18:00:00.000Z" },
      { runId: "run-approved", assignedReviewerUserId: REVIEWER_UID, teamId: null, assignedAt: "2026-08-12T17:00:00.000Z" },
    ];
    runDocsByRunId.set("run-assigned", runData());
    runDocsByRunId.set(
      "run-approved",
      runData({ governanceRecord: { schemaId: "decision_support", answerShape: "decision_support_view", humanReview: { status: "approved", reviewedAt: "2026-08-12T19:00:00.000Z" } } })
    );
  });

  it("default (all) returns both", async () => {
    const { json } = await callRoute();
    expect(json.items).toHaveLength(2);
  });

  it("pending returns only the assigned (non-terminal) row", async () => {
    const { json } = await callRoute("?filter=pending");
    expect(json.items.map((i: any) => i.runId)).toEqual(["run-assigned"]);
  });

  it("completed returns only the terminal row, with completedAt", async () => {
    const { json } = await callRoute("?filter=completed");
    expect(json.items.map((i: any) => i.runId)).toEqual(["run-approved"]);
    expect(json.items[0].completedAt).toBe("2026-08-12T19:00:00.000Z");
    expect(json.items[0].status).toBe("approved");
  });

  it("rejects an invalid filter value", async () => {
    const { res } = await callRoute("?filter=bogus");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/user/reviews — batching, no N+1 (Part 18/37)", () => {
  it("issues exactly ONE identity-resolution call and ONE batched run-read pass across many rows", async () => {
    assignmentFixtures = Array.from({ length: 15 }, (_, i) => ({
      runId: `run-${i}`,
      assignedReviewerUserId: REVIEWER_UID,
      teamId: null,
      assignedAt: "2026-08-12T18:00:00.000Z",
    }));
    for (let i = 0; i < 15; i++) runDocsByRunId.set(`run-${i}`, runData({ userId: `owner-${i % 3}` }));

    const { json } = await callRoute();
    expect(json.items).toHaveLength(15);
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledTimes(1);
    // Deduplicated to 3 distinct owners across 15 rows.
    const [ownerUidsArg] = mockedResolveReviewerDisplayNames.mock.calls[0];
    expect(new Set(ownerUidsArg).size).toBe(3);
    // getAll is called in chunks of <=10 — 15 refs -> 2 calls, never 15 individual reads.
    expect(getAllCalls.length).toBe(2);
  });
});

describe("GET /api/user/reviews — privacy (Part 9/31)", () => {
  it("never exposes billing fields, raw uids, or comment text", async () => {
    assignmentFixtures = [{ runId: "run-1", assignedReviewerUserId: REVIEWER_UID, teamId: null, assignedAt: "2026-08-12T18:00:00.000Z" }];
    runDocsByRunId.set(
      "run-1",
      runData({
        userId: "owner-1",
        stripeCustomerId: "cus_SECRET",
        tokensUsedCurrentPeriod: 12345,
        governanceRecord: {
          schemaId: "decision_support",
          answerShape: "decision_support_view",
          humanReview: { status: "approved", reviewerId: REVIEWER_UID, comment: "PRIVATE_COMMENT", reviewedAt: "2026-08-12T19:00:00.000Z" },
        },
      })
    );
    // A resolver implementation that does NOT embed the raw uid as a
    // substring, so this test can distinguish "the resolved display name
    // happens to contain it" from "the raw uid actually leaked".
    mockedResolveReviewerDisplayNames.mockResolvedValue(new Map([["owner-1", "Jane Owner"]]));

    const { json } = await callRoute();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("cus_SECRET");
    expect(serialized).not.toContain("12345");
    expect(serialized).not.toContain("PRIVATE_COMMENT");
    expect(serialized).not.toContain("owner-1"); // raw owner uid never shown, only the resolved display name
    expect(serialized).toContain("Jane Owner");
  });
});
