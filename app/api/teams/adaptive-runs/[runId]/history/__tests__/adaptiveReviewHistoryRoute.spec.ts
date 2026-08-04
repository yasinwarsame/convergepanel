/**
 * Immutable Adaptive Review History and Admin Audit Integration —
 * GET /api/teams/adaptive-runs/[runId]/history tests.
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

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/teams/adaptive-runs/[runId]/history/route";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";

function validProjection(overrides: Record<string, unknown> = {}) {
  return { projectionVersion: 1, adaptive: true, teamId: TEAM_ID, runId: RUN_ID, ...overrides };
}

function validHistoryDoc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "adaptive_human_review",
    priorStatus: "unreviewed",
    newStatus: "approved",
    reviewedAt: "2026-07-30T00:00:00.000Z",
    commentPresent: false,
    conditionsCount: 0,
    ...overrides,
  };
}

function fakeHistorySnap(docs: Array<{ id: string; data: Record<string, unknown> }>) {
  return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) };
}

async function callRoute() {
  const req = new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}/history`);
  const res = await GET(req, { params: { runId: RUN_ID } });
  return { res, json: await res.json() };
}

beforeEach(() => {
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedGetProjection.mockReset();
  mockedRunGet.mockReset();
  mockedHistoryGet.mockReset();
  mockLoggerWarn.mockClear();

  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: { id: TEAM_ID } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedRunGet.mockResolvedValue({ exists: true });
  mockedHistoryGet.mockResolvedValue(fakeHistorySnap([]));
});

describe("GET .../history — authorization", () => {
  it("rejects an unauthenticated request", async () => {
    mockedGetRequestUid.mockResolvedValueOnce(NextResponse.json({ ok: false, error: { code: "unauthorized", message: "no" } }, { status: 401 }));
    const { res } = await callRoute();
    expect(res.status).toBe(401);
  });

  it("rejects a caller with no team", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
    const { res } = await callRoute();
    expect(res.status).toBe(403);
  });

  it("rejects a plain member", async () => {
    mockedIsTeamAdmin.mockReturnValueOnce(false);
    const { res } = await callRoute();
    expect(res.status).toBe(403);
  });

  it("allows an owner/admin", async () => {
    const { res } = await callRoute();
    expect(res.status).toBe(200);
  });

  it("hides a cross-team run — projection not found, never distinguished from any other missing case", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });

  it("rejects a projection with a mismatched teamId", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ teamId: "other-team" }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_invalid");
  });

  it("returns 404 when the parent run is missing", async () => {
    mockedRunGet.mockResolvedValueOnce({ exists: false });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });
});

describe("GET .../history — contract", () => {
  it("returns an empty items array when no history exists yet", async () => {
    const { json } = await callRoute();
    expect(json).toEqual({ ok: true, version: 1, runId: RUN_ID, items: [] });
  });

  it("returns exactly one item for a single committed decision", async () => {
    mockedHistoryGet.mockResolvedValueOnce(fakeHistorySnap([{ id: "dec_abc", data: validHistoryDoc() }]));
    const { json } = await callRoute();
    expect(json.items).toHaveLength(1);
    expect(json.items[0]).toEqual({
      priorStatus: "unreviewed",
      newStatus: "approved",
      reviewedAt: "2026-07-30T00:00:00.000Z",
      commentPresent: false,
      conditionsCount: 0,
    });
  });

  it("never exposes reviewerId, reviewerName, comment, conditions, teamId, userId, or raw governance data", async () => {
    mockedHistoryGet.mockResolvedValueOnce(
      fakeHistorySnap([{ id: "dec_abc", data: validHistoryDoc({ reviewerId: "SECRET-uid", teamId: "SECRET-team", comment: "SECRET" }) }])
    );
    const { json } = await callRoute();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("SECRET");
    expect(json.items[0]).not.toHaveProperty("reviewerId");
    expect(json.items[0]).not.toHaveProperty("teamId");
  });

  it("orders items by reviewedAt ascending", async () => {
    mockedHistoryGet.mockResolvedValueOnce(
      fakeHistorySnap([
        { id: "later", data: validHistoryDoc({ reviewedAt: "2026-07-30T02:00:00.000Z" }) },
        { id: "earlier", data: validHistoryDoc({ reviewedAt: "2026-07-30T01:00:00.000Z" }) },
      ])
    );
    const { json } = await callRoute();
    expect(json.items.map((i: any) => i.reviewedAt)).toEqual(["2026-07-30T01:00:00.000Z", "2026-07-30T02:00:00.000Z"]);
  });

  it("skips a malformed or unsupported-version row, logging metadata only", async () => {
    mockedHistoryGet.mockResolvedValueOnce(
      fakeHistorySnap([
        { id: "good", data: validHistoryDoc() },
        { id: "bad-version", data: validHistoryDoc({ version: 2 }) },
        { id: "bad-shape", data: { garbage: true } },
      ])
    );
    const { json } = await callRoute();
    expect(json.items).toHaveLength(1);
    expect(mockLoggerWarn).toHaveBeenCalled();
    const logged = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(logged).not.toContain("garbage");
  });

  it("returns 503 safely when the history read fails", async () => {
    mockedHistoryGet.mockRejectedValueOnce(new Error("boom"));
    const { res, json } = await callRoute();
    expect(res.status).toBe(503);
    expect(json.error.code).toBe("firestore_unavailable");
  });
});
