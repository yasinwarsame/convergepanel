/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — versioned team-run
 * list route (`GET /api/teams/runs?version=1`) tests. The legacy,
 * unversioned response path is deliberately untouched by this file — no
 * regression test existed for it before this step either (§24.5), and it
 * is unmodified here.
 */

const teamRunDocs = new Map<string, Record<string, any>>();
// Path-keyed store for the enrichment reads this route now performs:
// "runs/{runId}" (governanceRecord), "runs/{runId}/humanReviewAssignment/current",
// "runs/{runId}/humanReviewPanel/current", "runs/{runId}/humanReviewVotes/{voteId}".
const pathStore = new Map<string, Record<string, any>>();
let getAllShouldThrow = false;

function makeDocRef(path: string): any {
  return {
    __path: path,
    id: path.split("/").pop(),
    get: async () => ({ exists: pathStore.has(path), data: () => pathStore.get(path) }),
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}

function makeCollectionRef(path: string): any {
  return {
    doc: (id: string) => makeDocRef(`${path}/${id}`),
  };
}

const mockAdminDb = {
  collection: (name: string) => {
    if (name === "teamRuns") {
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => {
            const matches = [...teamRunDocs.entries()].filter(([, data]) => data[field] === value);
            return { docs: matches.map(([id, data]) => ({ id, data: () => data })) };
          },
        }),
      };
    }
    return makeCollectionRef(name);
  },
  getAll: async (...refs: Array<{ __path: string }>) => {
    if (getAllShouldThrow) throw new Error("batch read boom");
    return refs.map((ref) => ({ exists: pathStore.has(ref.__path), data: () => pathStore.get(ref.__path) }));
  },
};

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
}));

// Identity resolution is already covered end-to-end by
// lib/governance/__tests__/reviewerIdentity.spec.ts (including its own
// db.getAll() batching) — mocked here so this file can assert precisely
// on WHICH uids the route collects and batches, independent of the
// resolver's own internal correctness.
const mockedResolveReviewerDisplayNames = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: (...args: any[]) => mockedResolveReviewerDisplayNames(...args),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
}));

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

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/teams/runs/route";

const TEAM_ID = "team-1";

function fakeTimestamp(iso: string) {
  return { toMillis: () => new Date(iso).getTime() };
}

function adaptiveDoc(overrides: Record<string, unknown> = {}) {
  return {
    teamId: TEAM_ID,
    userId: "owner-uid",
    projectionVersion: 1,
    adaptive: true,
    runId: "run-1",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "The panel recommends option A.",
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "flagged",
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function legacyDoc(overrides: Record<string, unknown> = {}) {
  return {
    teamId: TEAM_ID,
    userId: "owner-uid",
    userEmail: "owner@test.com",
    type: "research",
    query: "What is the best CRM for a 20-person sales team?",
    consensusScore: 40,
    policyFlags: ["weak_evidence"],
    timestamp: fakeTimestamp("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

function buildRequest(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/teams/runs?version=1${qs}`);
}

beforeEach(() => {
  teamRunDocs.clear();
  pathStore.clear();
  getAllShouldThrow = false;
  mockLoggerWarn.mockClear();
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedResolveReviewerDisplayNames.mockReset();

  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "caller@test.com" }, team: { id: TEAM_ID, members: [] } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((uid) => [uid, `Name-${uid}`])));
});

/** Seeds a canonical governanceRecord for an adaptive row's runId. */
function setGovernanceRecord(runId: string, humanReview: Record<string, unknown>) {
  pathStore.set(`runs/${runId}`, {
    governanceRecord: {
      version: 1,
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      adaptiveOutputVersion: 1,
      humanReview,
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
    },
  });
}

/** Seeds a humanReviewAssignment/current doc for a runId. */
function setAssignment(runId: string, overrides: Record<string, unknown> = {}) {
  pathStore.set(`runs/${runId}/humanReviewAssignment/current`, {
    schemaVersion: 1,
    teamId: TEAM_ID,
    runId,
    assignedReviewerUserId: "reviewer-1",
    assignedAt: "2026-08-12T10:31:00.000Z",
    assignedByUserId: "admin-1",
    updatedAt: "2026-08-12T10:31:00.000Z",
    updatedByUserId: "admin-1",
    revision: 1,
    ...overrides,
  });
}

/** Seeds a humanReviewPanel/current doc for a runId. */
function setPanel(runId: string, overrides: Record<string, unknown> = {}) {
  pathStore.set(`runs/${runId}/humanReviewPanel/current`, {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: TEAM_ID,
    runId,
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
    ...overrides,
  });
}

/** Seeds a humanReviewVotes/{voteId} doc — voteId matches buildAdaptiveHumanReviewVoteId's own `r{revision}:{encodeURIComponent(reviewerId)}` format. */
function setVote(runId: string, panelRevision: number, reviewerUserId: string, overrides: Record<string, unknown> = {}) {
  const voteId = `r${panelRevision}:${encodeURIComponent(reviewerUserId)}`;
  pathStore.set(`runs/${runId}/humanReviewVotes/${voteId}`, {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: TEAM_ID,
    runId,
    panelRevision,
    reviewerUserId,
    status: "approved",
    commentPresent: false,
    conditionsCount: 0,
    submittedAt: "2026-08-12T10:44:00.000Z",
    ...overrides,
  });
}

describe("GET /api/teams/runs?version=1 — authorization", () => {
  it("rejects an unauthenticated request", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const res = await GET(buildRequest(""));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the caller has no team", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
    const res = await GET(buildRequest(""));
    expect(res.status).toBe(403);
  });

  it("owner sees all team rows", async () => {
    teamRunDocs.set("l1", legacyDoc({ userId: "someone-else" }));
    mockedMemberRole.mockReturnValueOnce("owner");
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items).toHaveLength(1);
  });

  it("admin sees all team rows", async () => {
    teamRunDocs.set("l1", legacyDoc({ userId: "someone-else" }));
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items).toHaveLength(1);
  });

  it("member sees only their own rows", async () => {
    teamRunDocs.set("mine", legacyDoc({ userId: "caller-uid" }));
    teamRunDocs.set("theirs", legacyDoc({ userId: "someone-else" }));
    mockedIsTeamAdmin.mockReturnValue(false);
    mockedMemberRole.mockReturnValue("member");
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].teamRunId).toBe("mine");
  });

  it("excludes rows belonging to a different team", async () => {
    teamRunDocs.set("other-team-row", legacyDoc({ teamId: "some-other-team" }));
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items).toHaveLength(0);
  });
});

describe("GET /api/teams/runs?version=1 — response contract", () => {
  it("returns version 1 and every item tagged with a kind", async () => {
    teamRunDocs.set("a1", adaptiveDoc());
    teamRunDocs.set("l1", legacyDoc());
    const body = await (await GET(buildRequest(""))).json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);
    for (const item of body.items) {
      expect(["legacy", "adaptive"]).toContain(item.kind);
    }
  });

  it("maps a valid adaptive row with only the approved fields", async () => {
    teamRunDocs.set("a1", adaptiveDoc());
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.kind === "adaptive");
    expect(item).toMatchObject({
      kind: "adaptive",
      runId: "run-1",
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      humanReviewStatus: "unreviewed",
      reviewable: true,
    });
    expect(item).not.toHaveProperty("teamId");
    expect(item).not.toHaveProperty("userId");
  });

  it("maps a valid legacy row", async () => {
    teamRunDocs.set("l1", legacyDoc());
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.kind === "legacy");
    expect(item.querySummary).toBe("What is the best CRM for a 20-person sales team?");
    expect(item.blockedByPolicy).toBe(true);
  });

  it("never exposes sensitive or hidden fields on any item", async () => {
    teamRunDocs.set("a1", adaptiveDoc());
    teamRunDocs.set("l1", legacyDoc());
    const serialized = JSON.stringify(await (await GET(buildRequest(""))).json());
    for (const forbidden of ["consensusSummary", "auditBundle", "claims", "rawModelOutput", "reviewerId", "reviewerName", "comment", "conditions", "sources", "basis", "assumptions", "uncertainties"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("GET /api/teams/runs?version=1 — classification", () => {
  it("skips a malformed adaptive row without failing the response", async () => {
    teamRunDocs.set("bad-adaptive", adaptiveDoc({ schemaId: "not_a_real_schema" }));
    teamRunDocs.set("good-legacy", legacyDoc());
    const res = await GET(buildRequest(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("legacy");
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("a malformed adaptive row never falls back to the legacy mapper", async () => {
    teamRunDocs.set("bad-adaptive", adaptiveDoc({ receiptConclusion: 12345 }));
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items).toHaveLength(0);
  });

  it("skips a malformed legacy row (invalid timestamp)", async () => {
    teamRunDocs.set("bad-legacy", legacyDoc({ timestamp: "not-a-timestamp" }));
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items).toHaveLength(0);
  });

  it("skips an adaptive row with an unsupported projectionVersion", async () => {
    teamRunDocs.set("future-version", adaptiveDoc({ projectionVersion: 2 }));
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items).toHaveLength(0);
  });
});

describe("GET /api/teams/runs?version=1 — filtering", () => {
  beforeEach(() => {
    teamRunDocs.set("a-flagged", adaptiveDoc({ runId: "run-flagged", automatedGovernanceStatus: "flagged", humanReviewStatus: "unreviewed" }));
    teamRunDocs.set("a-passed", adaptiveDoc({ runId: "run-passed", automatedGovernanceStatus: "passed", humanReviewStatus: "approved" }));
    teamRunDocs.set("l-flagged", legacyDoc({ policyFlags: ["x"] }));
    teamRunDocs.set("l-clean", legacyDoc({ policyFlags: [] }));
  });

  it("kind=adaptive", async () => {
    const body = await (await GET(buildRequest("&kind=adaptive"))).json();
    expect(body.items.every((i: any) => i.kind === "adaptive")).toBe(true);
    expect(body.items).toHaveLength(2);
  });

  it("kind=legacy", async () => {
    const body = await (await GET(buildRequest("&kind=legacy"))).json();
    expect(body.items.every((i: any) => i.kind === "legacy")).toBe(true);
    expect(body.items).toHaveLength(2);
  });

  it("flagged=true matches both kinds", async () => {
    const body = await (await GET(buildRequest("&flagged=true"))).json();
    expect(body.items).toHaveLength(2);
  });

  it("flagged=false matches both kinds", async () => {
    const body = await (await GET(buildRequest("&flagged=false"))).json();
    expect(body.items).toHaveLength(2);
  });

  it("reviewable=true excludes legacy rows", async () => {
    const body = await (await GET(buildRequest("&reviewable=true"))).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].kind).toBe("adaptive");
  });

  it("humanReviewStatus filter matches only adaptive rows with that status", async () => {
    const body = await (await GET(buildRequest("&humanReviewStatus=approved"))).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].runId).toBe("run-passed");
  });

  it("rejects an invalid kind with 400", async () => {
    const res = await GET(buildRequest("&kind=bogus"));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid boolean with 400", async () => {
    const res = await GET(buildRequest("&flagged=maybe"));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid page with 400", async () => {
    const res = await GET(buildRequest("&page=0"));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid limit with 400", async () => {
    const res = await GET(buildRequest("&limit=abc"));
    expect(res.status).toBe(400);
  });

  it("enforces the maximum page size", async () => {
    const body = await (await GET(buildRequest("&limit=99999"))).json();
    expect(body.pagination.limit).toBe(100);
  });
});

describe("GET /api/teams/runs?version=1 — ordering and pagination", () => {
  it("sorts adaptive and legacy rows together, deterministically, newest first", async () => {
    teamRunDocs.set("old-legacy", legacyDoc({ timestamp: fakeTimestamp("2020-01-01T00:00:00.000Z") }));
    teamRunDocs.set("new-adaptive", adaptiveDoc({ runId: "run-new", updatedAt: "2026-07-29T00:00:00.000Z" }));
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items[0].teamRunId).toBe("new-adaptive");
    expect(body.items[1].teamRunId).toBe("old-legacy");
  });

  it("adaptive rows never sort as infinitely old due to a missing legacy timestamp field", async () => {
    teamRunDocs.set("legacy-recent", legacyDoc({ timestamp: fakeTimestamp("2026-07-01T00:00:00.000Z") }));
    teamRunDocs.set("adaptive-recent", adaptiveDoc({ runId: "run-recent", updatedAt: "2026-07-29T00:00:00.000Z" }));
    const body = await (await GET(buildRequest(""))).json();
    expect(body.items[0].teamRunId).toBe("adaptive-recent");
  });

  it("breaks ties deterministically by teamRunId", async () => {
    teamRunDocs.set("b-doc", adaptiveDoc({ runId: "run-b", updatedAt: "2026-07-29T00:00:00.000Z" }));
    teamRunDocs.set("a-doc", adaptiveDoc({ runId: "run-a", updatedAt: "2026-07-29T00:00:00.000Z" }));
    const body1 = await (await GET(buildRequest(""))).json();
    const body2 = await (await GET(buildRequest(""))).json();
    expect(body1.items.map((i: any) => i.teamRunId)).toEqual(body2.items.map((i: any) => i.teamRunId));
  });

  it("computes correct pagination metadata and never duplicates items across pages", async () => {
    for (let i = 0; i < 30; i++) {
      teamRunDocs.set(`run-${i}`, adaptiveDoc({ runId: `run-${i}`, updatedAt: new Date(2026, 0, i + 1).toISOString() }));
    }
    const page1 = await (await GET(buildRequest("&limit=25&page=1"))).json();
    const page2 = await (await GET(buildRequest("&limit=25&page=2"))).json();
    expect(page1.items).toHaveLength(25);
    expect(page2.items).toHaveLength(5);
    expect(page1.pagination).toEqual({ page: 1, limit: 25, total: 30, hasNextPage: true, hasPreviousPage: false });
    expect(page2.pagination).toEqual({ page: 2, limit: 25, total: 30, hasNextPage: false, hasPreviousPage: true });
    const overlap = page1.items.map((i: any) => i.teamRunId).filter((id: string) => page2.items.map((i: any) => i.teamRunId).includes(id));
    expect(overlap).toHaveLength(0);
  });

  it("pagination metadata is calculated after filtering, not the raw collection size", async () => {
    teamRunDocs.set("a-flagged", adaptiveDoc({ runId: "run-flagged", automatedGovernanceStatus: "flagged" }));
    teamRunDocs.set("a-passed", adaptiveDoc({ runId: "run-passed", automatedGovernanceStatus: "passed" }));
    const body = await (await GET(buildRequest("&flagged=true"))).json();
    expect(body.pagination.total).toBe(1);
  });

  it("returns an empty result for a page beyond the last, without error", async () => {
    teamRunDocs.set("only-one", adaptiveDoc());
    const res = await GET(buildRequest("&page=5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(0);
  });
});

describe("GET /api/teams/runs?version=1 — failure handling", () => {
  it("does not expose raw Firestore error details in the malformed-row log", async () => {
    teamRunDocs.set("bad", adaptiveDoc({ schemaId: "garbage" }));
    await GET(buildRequest(""));
    const loggedArgs = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(loggedArgs).not.toContain("garbage");
  });

  it("a mix of malformed and valid rows never fails the whole response", async () => {
    teamRunDocs.set("bad1", adaptiveDoc({ schemaId: "garbage" }));
    teamRunDocs.set("bad2", legacyDoc({ timestamp: undefined }));
    teamRunDocs.set("good", legacyDoc());
    const res = await GET(buildRequest(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
  });
});

describe("GET /api/teams/runs?version=1 — reviewer display (final task)", () => {
  it("shows the assigned reviewer for an adaptive row awaiting review", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-assigned" }));
    setGovernanceRecord("run-assigned", { status: "unreviewed" });
    setAssignment("run-assigned");
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-assigned");
    expect(item.assignment).toMatchObject({ reviewerUserId: "reviewer-1", reviewerDisplayName: "Name-reviewer-1" });
    expect(item.singleReviewer).toBeNull();
  });

  it("shows the completed single-reviewer result and timestamp", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-done", humanReviewStatus: "approved" }));
    setGovernanceRecord("run-done", { status: "approved", reviewerId: "reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z", decidedVia: "single_reviewer" });
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-done");
    expect(item.singleReviewer).toEqual({ userId: "reviewer-1", displayName: "Name-reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z" });
  });

  it("shows peer-review panel progress with individual reviewer results", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-panel" }));
    setGovernanceRecord("run-panel", { status: "unreviewed" });
    setPanel("run-panel");
    setVote("run-panel", 1, "reviewer-1", { status: "approved" });
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-panel");
    expect(item.panel).toMatchObject({ status: "open", requiredReviewerCount: 2, quorum: 2, submittedCount: 1, approvalCount: 1 });
    expect(item.panel.reviewers).toEqual([
      { userId: "reviewer-1", displayName: "Name-reviewer-1", hasVoted: true, voteStatus: "approved", submittedAt: "2026-08-12T10:44:00.000Z" },
      { userId: "reviewer-2", displayName: "Name-reviewer-2", hasVoted: false },
    ]);
  });

  it("shows owner override distinctly from an ordinary finalized result", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-override", humanReviewStatus: "rejected" }));
    setGovernanceRecord("run-override", { status: "rejected", reviewerId: "admin-1", decidedVia: "multi_reviewer_owner_override" });
    setPanel("run-override", {
      status: "finalized",
      updatedAt: "2026-08-12T10:55:00.000Z",
      finalStatus: "rejected",
      finalizedAt: "2026-08-12T10:55:00.000Z",
      finalizedByUserId: "admin-1",
      finalDecisionId: "decision-1",
      aggregationPolicyVersion: 1,
      finalizedVia: "owner_override",
      overrideJustificationPresent: true,
      overrideByUserId: "admin-1",
    });
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-override");
    expect(item.panel).toMatchObject({ finalizedVia: "owner_override", overrideBy: { userId: "admin-1", displayName: "Name-admin-1" } });
    expect(item.singleReviewer).toBeNull(); // override identity surfaces via panel.overrideBy, never duplicated
  });

  it("shows cancellation and does not present a stale assignment as active", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-cancelled" }));
    setGovernanceRecord("run-cancelled", { status: "unreviewed" });
    setAssignment("run-cancelled"); // pre-existing single-reviewer assignment, superseded by the panel
    setPanel("run-cancelled", { status: "cancelled" });
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-cancelled");
    expect(item.panel.status).toBe("cancelled");
  });

  it("resolves a legacy row's decider to a safe display name", async () => {
    teamRunDocs.set("l1", legacyDoc({ humanDecision: { action: "approved", decidedAt: "2026-08-12T10:00:00.000Z", decidedBy: "reviewer-1" } }));
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.kind === "legacy");
    expect(item.humanDecision).toEqual({ action: "approved", decidedAt: "2026-08-12T10:00:00.000Z", reviewer: { displayName: "Name-reviewer-1" } });
  });

  it("a legacy row with no decision yet has no humanDecision object at all (not a fake 'pending reviewer')", async () => {
    teamRunDocs.set("l1", legacyDoc());
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.kind === "legacy");
    expect(item.humanDecision).toBeUndefined();
  });
});

describe("GET /api/teams/runs?version=1 — identity batching, never N+1 (final task, Step 12)", () => {
  it("resolves every reviewer identity on the page in exactly ONE call, across multiple rows and reviewers", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-1" }));
    setGovernanceRecord("run-1", { status: "unreviewed" });
    setAssignment("run-1", { assignedReviewerUserId: "reviewer-1", assignedByUserId: "admin-1" });

    teamRunDocs.set("a2", adaptiveDoc({ runId: "run-2" }));
    setGovernanceRecord("run-2", { status: "unreviewed" });
    setPanel("run-2", { reviewerUserIds: ["reviewer-2", "reviewer-3"], requiredReviewerCount: 2, quorum: 2 });

    teamRunDocs.set("l1", legacyDoc({ humanDecision: { action: "approved", decidedAt: "2026-08-12T10:00:00.000Z", decidedBy: "reviewer-4" } }));

    await GET(buildRequest(""));

    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledTimes(1);
    const [calledUids] = mockedResolveReviewerDisplayNames.mock.calls[0];
    expect(new Set(calledUids)).toEqual(new Set(["reviewer-1", "admin-1", "reviewer-2", "reviewer-3", "reviewer-4"]));
  });

  it("issues a bounded number of batched Firestore reads for governance/assignment/panel data, not one read per row", async () => {
    for (let i = 0; i < 5; i++) {
      teamRunDocs.set(`a${i}`, adaptiveDoc({ runId: `run-${i}` }));
      setGovernanceRecord(`run-${i}`, { status: "unreviewed" });
    }
    const getAllSpy = jest.spyOn(mockAdminDb, "getAll");
    await GET(buildRequest(""));
    // One batched db.getAll() call per read TYPE (runs, assignment, panel —
    // each its own chunked batch, ≤10 refs so 1 call each here) = 3 total,
    // no votes (no panels exist) — never one call per ROW (which would be
    // 5), let alone one per row per field (15 individual .get() calls).
    expect(getAllSpy.mock.calls.length).toBe(3);
    getAllSpy.mockRestore();
  });

  it("does not call the identity resolver at all when the page has zero adaptive/legacy reviewer data", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-empty" }));
    setGovernanceRecord("run-empty", { status: "unreviewed" });
    teamRunDocs.set("l1", legacyDoc());
    await GET(buildRequest(""));
    expect(mockedResolveReviewerDisplayNames).toHaveBeenCalledWith([], expect.anything(), expect.anything());
  });
});

describe("GET /api/teams/runs?version=1 — canonical precedence over the adaptive teamRuns projection (Step 12/13)", () => {
  it("a stale/contradictory teamRuns.humanReviewStatus never overrides the canonical governanceRecord-derived reviewer/result", async () => {
    // teamRuns projection claims "unreviewed" (as if still pending)...
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-mismatch", humanReviewStatus: "unreviewed" }));
    // ...but the canonical governanceRecord says it was actually approved by reviewer-1.
    setGovernanceRecord("run-mismatch", { status: "approved", reviewerId: "reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z", decidedVia: "single_reviewer" });

    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-mismatch");
    // The enriched, canonical-derived fields show the real, approved state...
    expect(item.singleReviewer).toEqual({ userId: "reviewer-1", displayName: "Name-reviewer-1", reviewedAt: "2026-08-12T10:44:00.000Z" });
    // ...even though the discovery/base field from teamRuns itself is left
    // untouched (this route has never redefined humanReviewStatus's own
    // meaning — it is a projection field, disclosed as such; the important
    // guarantee is that the NEW canonical-derived fields are never
    // overridden by it).
    expect(item.humanReviewStatus).toBe("unreviewed");
  });
});

describe("GET /api/teams/runs?version=1 — privacy on enriched fields (Step 10)", () => {
  it("never leaks vote comment, override justification, or internal governance metadata even when fully populated", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-priv" }));
    setGovernanceRecord("run-priv", {
      status: "rejected",
      reviewerId: "admin-1",
      decidedVia: "multi_reviewer_owner_override",
      overrideJustification: "PRIVATE justification text",
      comment: "PRIVATE reviewer comment",
    });
    setPanel("run-priv", {
      status: "finalized",
      updatedAt: "2026-08-12T10:55:00.000Z",
      finalStatus: "rejected",
      finalizedAt: "2026-08-12T10:55:00.000Z",
      finalizedByUserId: "admin-1",
      finalDecisionId: "decision-secret-id",
      aggregationPolicyVersion: 1,
      finalizedVia: "owner_override",
      overrideJustificationPresent: true,
      overrideByUserId: "admin-1",
    });
    setVote("run-priv", 1, "reviewer-1", { comment: "PRIVATE vote comment", commentPresent: true });

    const raw = JSON.stringify(await (await GET(buildRequest(""))).json());
    for (const forbidden of ["PRIVATE", "decision-secret-id", "overrideJustification", '"comment"', "schemaVersion", "aggregationPolicyVersion"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("never renders a raw reviewer uid anywhere except inside an already-resolved reviewer object's own userId field (never as free text)", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-uid-check" }));
    setGovernanceRecord("run-uid-check", { status: "unreviewed" });
    setAssignment("run-uid-check", { assignedReviewerUserId: "reviewer-1", assignedByUserId: "admin-1" });
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-uid-check");
    // The uid is only ever present alongside its own resolved displayName.
    expect(item.assignment.reviewerUserId).toBe("reviewer-1");
    expect(item.assignment.reviewerDisplayName).toBe("Name-reviewer-1");
  });
});

describe("GET /api/teams/runs?version=1 — enrichment failure resilience (Step 17 loading/error behavior)", () => {
  it("a batched-read failure degrades enrichment for affected rows without removing them from the queue or failing the request", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-enrich-fail" }));
    setGovernanceRecord("run-enrich-fail", { status: "approved", reviewerId: "reviewer-1", decidedVia: "single_reviewer" });
    getAllShouldThrow = true;

    const res = await GET(buildRequest(""));
    expect(res.status).toBe(200);
    const body = await res.json();
    const item = body.items.find((i: any) => i.runId === "run-enrich-fail");
    expect(item).toBeDefined(); // row is NOT removed from the queue
    expect(item.singleReviewer).toBeNull(); // enrichment degraded, not fabricated
    // Distinguishable from a genuine "nothing configured" row — Step 17.
    expect(item.enrichmentUnavailable).toBe(true);
  });

  it("does NOT set enrichmentUnavailable for a row that genuinely has no assignment/panel configured (real absence, not a failure)", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ runId: "run-genuinely-unconfigured" }));
    setGovernanceRecord("run-genuinely-unconfigured", { status: "unreviewed" });
    const body = await (await GET(buildRequest(""))).json();
    const item = body.items.find((i: any) => i.runId === "run-genuinely-unconfigured");
    expect(item.enrichmentUnavailable).toBeUndefined();
    expect(item.singleReviewer).toBeNull();
    expect(item.assignment).toBeNull();
    expect(item.panel).toBeNull();
  });
});
