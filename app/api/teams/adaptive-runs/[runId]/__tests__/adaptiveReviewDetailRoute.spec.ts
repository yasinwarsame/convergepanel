/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — read-only adaptive
 * review-detail route (`GET /api/teams/adaptive-runs/{runId}`) tests.
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
const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => mockedRunGet(name, id),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: (...args: unknown[]) => mockLoggerInfo(...args), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "@/app/api/teams/adaptive-runs/[runId]/route";

const TEAM_ID = "team-1";
const RUN_ID = "run-1";

function validProjection(overrides: Record<string, unknown> = {}) {
  return {
    projectionVersion: 1,
    adaptive: true,
    teamId: TEAM_ID,
    runId: RUN_ID,
    humanReviewStatus: "unreviewed",
    ...overrides,
  };
}

function validGovernanceRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    automatedGovernance: { status: "flagged", reasons: ["a reason"], evaluatedAt: "2026-07-29T00:00:00.000Z", policyVersion: 3 },
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "The panel recommends option A.",
      basis: ["basis 1"],
      assumptions: ["assumption 1"],
      uncertainties: ["uncertainty 1"],
      limitations: ["limitation 1"],
      sources: ["source A"],
      sourceBacked: true,
      humanReviewNeeded: false,
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/teams/adaptive-runs/${RUN_ID}`);
}

async function callRoute() {
  const res = await GET(buildRequest(), { params: { runId: RUN_ID } });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedGetProjection.mockReset();
  mockedRunGet.mockReset();
  mockLoggerWarn.mockClear();
  mockLoggerInfo.mockClear();

  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: { id: TEAM_ID } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
  mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ governanceRecord: validGovernanceRecord() }) });
});

describe("GET /api/teams/adaptive-runs/[runId] — authorization", () => {
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

  it("allows an owner", async () => {
    mockedMemberRole.mockReturnValueOnce("owner");
    const { res } = await callRoute();
    expect(res.status).toBe(200);
  });

  it("allows an admin", async () => {
    const { res } = await callRoute();
    expect(res.status).toBe(200);
  });

  it("hides a wrong-team projection (structurally not found)", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });

  it("rejects a projection whose stored teamId does not match the caller's team", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ teamId: "some-other-team" }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_invalid");
  });
});

describe("GET /api/teams/adaptive-runs/[runId] — projection state", () => {
  it("missing projection -> 404 projection_missing", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_missing");
  });

  it("malformed projection (adaptive discriminator false) -> 404 projection_invalid", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ adaptive: false }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_invalid");
  });

  it("wrong stored runId -> 404 projection_invalid", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ runId: "different-run" }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("projection_invalid");
  });

  it("unsupported projection version -> safe 500, no detail exposed", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ projectionVersion: 2 }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain("projectionVersion");
  });
});

describe("GET /api/teams/adaptive-runs/[runId] — parent run state", () => {
  it("missing parent run -> 404 not_found", async () => {
    mockedRunGet.mockResolvedValueOnce({ exists: false });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("not_found");
  });

  it("governance record absent -> 404 governance_record_absent", async () => {
    mockedRunGet.mockResolvedValueOnce({ exists: true, data: () => ({}) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.error.code).toBe("governance_record_absent");
  });

  it("malformed governance record -> safe 500", async () => {
    mockedRunGet.mockResolvedValueOnce({ exists: true, data: () => ({ governanceRecord: { garbage: true } }) });
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(JSON.stringify(json)).not.toContain("garbage");
  });

  it("unsupported governance version -> safe 500", async () => {
    mockedRunGet.mockResolvedValueOnce({ exists: true, data: () => ({ governanceRecord: validGovernanceRecord({ version: 2 }) }) });
    const { res } = await callRoute();
    expect(res.status).toBe(500);
  });

  it("Firestore unavailable (projection read) -> 503", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "firestore_unavailable" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(503);
    expect(json.error.code).toBe("firestore_unavailable");
  });
});

describe("GET /api/teams/adaptive-runs/[runId] — canonicality", () => {
  it("returns the parent human-review status, not the projection's", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ humanReviewStatus: "approved" }) });
    mockedRunGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ governanceRecord: validGovernanceRecord({ humanReview: { status: "unreviewed" } }) }),
    });
    const { json } = await callRoute();
    expect(json.review.humanReview.status).toBe("unreviewed");
  });

  it("returns the parent automated-governance status", async () => {
    mockedRunGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ governanceRecord: validGovernanceRecord({ automatedGovernance: { status: "blocked", reasons: [], evaluatedAt: "2026-07-29T00:00:00.000Z", policyVersion: 1 } }) }),
    });
    const { json } = await callRoute();
    expect(json.review.automatedGovernance.status).toBe("blocked");
  });

  it("returns the parent updatedAt", async () => {
    const { json } = await callRoute();
    expect(json.review.updatedAt).toBe("2026-07-29T00:00:00.000Z");
  });

  it("logs a mismatch between projection and parent humanReviewStatus, metadata only", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ humanReviewStatus: "approved" }) });
    await callRoute();
    expect(mockLoggerInfo).toHaveBeenCalled();
    const loggedArgs = JSON.stringify(mockLoggerInfo.mock.calls);
    expect(loggedArgs).not.toContain("approved");
    expect(loggedArgs).not.toContain("unreviewed");
  });

  it("never repairs the projection (no write call exists in this route)", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ humanReviewStatus: "approved" }) });
    await callRoute();
    // getAdaptiveTeamRunProjection is a read-only helper; no
    // create/sync/update function is imported or called by this route at all.
    expect(mockedGetProjection).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/teams/adaptive-runs/[runId] — privacy", () => {
  it("never exposes reviewer identity, comment, conditions, sources, reasons, policy internals, question, model output, team/user/projection IDs", async () => {
    const { json } = await callRoute();
    const serialized = JSON.stringify(json);
    for (const forbidden of [
      "reviewerId",
      "reviewerName",
      "comment",
      "conditions",
      "\"sources\"",
      "reasons",
      "policyRules",
      "question",
      "rawModelOutput",
      "teamId",
      "userId",
      "projectionVersion",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("GET /api/teams/adaptive-runs/[runId] — reviewability", () => {
  it.each([
    ["unreviewed", true],
    ["pending", true],
    ["approved", false],
    ["approved_with_conditions", false],
    ["changes_requested", false],
    ["rejected", false],
  ])("humanReview.status=%s -> reviewable=%s", async (status, expected) => {
    mockedRunGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({ governanceRecord: validGovernanceRecord({ humanReview: { status } }) }),
    });
    const { json } = await callRoute();
    expect(json.review.reviewable).toBe(expected);
  });
});
