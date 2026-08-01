/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — versioned team-run
 * list route (`GET /api/teams/runs?version=1`) tests. The legacy,
 * unversioned response path is deliberately untouched by this file — no
 * regression test existed for it before this step either (§24.5), and it
 * is unmodified here.
 */

const teamRunDocs = new Map<string, Record<string, any>>();

const mockAdminDb = {
  collection: (name: string) => ({
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => {
        const matches = [...teamRunDocs.entries()].filter(([, data]) => data[field] === value);
        return { docs: matches.map(([id, data]) => ({ id, data: () => data })) };
      },
    }),
  }),
};

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
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
  mockLoggerWarn.mockClear();
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();

  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: { id: TEAM_ID } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
});

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
