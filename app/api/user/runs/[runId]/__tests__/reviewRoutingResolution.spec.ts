/**
 * Adaptive Synthesis Report, Phase 1 — GET /api/user/runs/[runId]'s
 * `reviewRouting` derivation on history reload.
 *
 * Covers the fix for a real defect found during review: a genuine
 * Firestore read failure on the teamRuns projection lookup
 * (getAdaptiveTeamRunProjection never throws — "firestore_unavailable"/
 * "read_failed" come back as ordinary return values) was being collapsed
 * into the exact same "not_configured" outcome as a confirmed absence of
 * review routing. "not_configured" must only ever mean "positively
 * confirmed no review config exists" — every unresolved/error/malformed
 * case must resolve to "unknown" instead, which reportStatus.ts already
 * renders identically to "in_queue" ("Unreviewed — in queue"), never as
 * the false "no review configured" claim.
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

const mockedRunDocumentToPublicResults = jest.fn();
jest.mock("@/lib/user/runDocumentToPublicResults", () => ({
  runDocumentToPublicResults: (...args: any[]) => mockedRunDocumentToPublicResults(...args),
}));

const mockedPublicizePanelResults = jest.fn();
jest.mock("@/lib/panel/publicize", () => ({
  publicizePanelResults: (...args: any[]) => mockedPublicizePanelResults(...args),
}));

const mockedParsePersistedAdaptiveOutput = jest.fn();
// Phase 2 pilot history-reload fix — the route now also imports and calls
// parsePersistedLegacyAdaptiveOutput (procedural-only envelope, unrelated
// to this file's own reviewRouting-derivation scope). Mocked to a fixed
// "absent" default below so the route's new call succeeds without this
// file needing to know anything about that envelope's shape.
const mockedParsePersistedLegacyAdaptiveOutput = jest.fn();
jest.mock("@/lib/adaptiveSchema/persistedOutput", () => ({
  parsePersistedAdaptiveOutput: (...args: any[]) => mockedParsePersistedAdaptiveOutput(...args),
  parsePersistedLegacyAdaptiveOutput: (...args: any[]) => mockedParsePersistedLegacyAdaptiveOutput(...args),
}));

const mockedParseGovernanceRecord = jest.fn();
jest.mock("@/lib/adaptiveSchema/governanceRecordParser", () => ({
  parseGovernanceRecord: (...args: any[]) => mockedParseGovernanceRecord(...args),
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
}));

const mockedGetProjection = jest.fn();
jest.mock("@/lib/firestore/teamRuns", () => ({
  getAdaptiveTeamRunProjection: (...args: any[]) => mockedGetProjection(...args),
}));

const mockLoggerWarn = jest.fn();
jest.mock("@/lib/logger", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/route";

const UID = "user-1";
const TEAM_ID = "team-1";
const RUN_ID = "run-1";

const VALID_OUTPUT = { schemaId: "decision_support", classification: {}, result: {} };

function validProjection(overrides: Record<string, unknown> = {}) {
  return {
    projectionVersion: 1,
    adaptive: true,
    teamId: TEAM_ID,
    runId: RUN_ID,
    ...overrides,
  };
}

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${RUN_ID}`, {
    headers: { "x-vercel-id": "req-abc-123" },
  });
}

async function callRoute() {
  const res = await GET(buildRequest(), { params: Promise.resolve({ runId: RUN_ID }) });
  const json = await res.json();
  return { res, json };
}

beforeEach(() => {
  mockedResolveRequestIdentity.mockReset();
  mockedLogIdentityResolutionFailure.mockReset();
  mockedRunGet.mockReset();
  mockedRunDocumentToPublicResults.mockReset();
  mockedPublicizePanelResults.mockReset();
  mockedParsePersistedAdaptiveOutput.mockReset();
  mockedParsePersistedLegacyAdaptiveOutput.mockReset();
  mockedParseGovernanceRecord.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedGetProjection.mockReset();
  mockLoggerWarn.mockClear();

  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedRunGet.mockResolvedValue({
    exists: true,
    data: () => ({ userId: UID, question: "q", adaptiveOutput: {}, governanceRecord: {} }),
  });
  mockedRunDocumentToPublicResults.mockReturnValue([{ modelId: "chatgpt" }]);
  mockedParsePersistedAdaptiveOutput.mockReturnValue({ ok: true, output: VALID_OUTPUT });
  mockedParsePersistedLegacyAdaptiveOutput.mockReturnValue({ ok: false, reason: "absent" });
  mockedParseGovernanceRecord.mockReturnValue({
    ok: true,
    record: { humanReview: { status: "unreviewed", conditions: undefined, decidedVia: undefined } },
  });
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: { id: TEAM_ID } });
  mockedGetProjection.mockResolvedValue({ status: "found", projection: validProjection() });
});

describe("GET /api/user/runs/[runId] — reviewRouting resolution", () => {
  it("confirmed no review configured (no team) -> not_configured", async () => {
    mockedLoadUserAndTeam.mockResolvedValueOnce({ user: {}, team: null });
    const { json } = await callRoute();
    expect(json.adaptive.reviewRouting).toBe("not_configured");
  });

  it("confirmed no review configured (projection genuinely not_found) -> not_configured", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "not_found" });
    const { json } = await callRoute();
    expect(json.adaptive.reviewRouting).toBe("not_configured");
  });

  it("confirmed queued review (valid projection found) -> in_queue", async () => {
    const { json } = await callRoute();
    expect(json.adaptive.reviewRouting).toBe("in_queue");
  });

  it("Firestore unavailable -> safe non-settled state, never not_configured", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "firestore_unavailable" });
    const { json } = await callRoute();
    expect(json.adaptive.reviewRouting).toBe("unknown");
    expect(json.adaptive.reviewRouting).not.toBe("not_configured");
  });

  it("generic read failure -> safe non-settled state, never not_configured", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "read_failed" });
    const { json } = await callRoute();
    expect(json.adaptive.reviewRouting).toBe("unknown");
    expect(json.adaptive.reviewRouting).not.toBe("not_configured");
  });

  it("unresolved thrown error during lookup -> safe non-settled state, never not_configured", async () => {
    mockedLoadUserAndTeam.mockRejectedValueOnce(new Error("boom"));
    const { json } = await callRoute();
    expect(json.adaptive.reviewRouting).toBe("unknown");
    expect(json.adaptive.reviewRouting).not.toBe("not_configured");
  });

  it.each([
    ["wrong projectionVersion", validProjection({ projectionVersion: 2 })],
    ["adaptive discriminator false", validProjection({ adaptive: false })],
    ["stored teamId mismatch", validProjection({ teamId: "some-other-team" })],
    ["stored runId mismatch", validProjection({ runId: "different-run" })],
  ])("malformed/forged projection (%s) -> safe non-settled state, never blindly trusted as in_queue", async (_label, projection) => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection });
    const { json } = await callRoute();
    expect(json.adaptive.reviewRouting).toBe("unknown");
    expect(json.adaptive.reviewRouting).not.toBe("not_configured");
  });

  it("missing humanReview (no governance record) -> reviewRouting stays unknown, no crash, adaptive payload preserved", async () => {
    mockedParseGovernanceRecord.mockReturnValueOnce({ ok: false, reason: "absent" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.adaptive.humanReview).toBeNull();
    expect(json.adaptive.reviewRouting).toBe("unknown");
    // The projection lookup is only ever attempted when humanReview exists
    // and is unreviewed/pending — never called here.
    expect(mockedGetProjection).not.toHaveBeenCalled();
    // The adaptive output itself must still be present.
    expect(json.adaptive.output).toEqual(VALID_OUTPUT);
  });

  it("history reload still preserves the adaptive payload when reviewRouting resolution errors", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "firestore_unavailable" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.adaptive.status).toBe("valid");
    expect(json.adaptive.output).toEqual(VALID_OUTPUT);
  });

  it("does not create or mutate a teamRuns projection during a history read (read-only)", async () => {
    await callRoute();
    expect(mockedGetProjection).toHaveBeenCalledTimes(1);
    expect(mockedGetProjection).toHaveBeenCalledWith(TEAM_ID, RUN_ID);
  });

  it("does not touch canonical governance state (governanceRecord is only ever read, never parsed a second time or written)", async () => {
    await callRoute();
    expect(mockedParseGovernanceRecord).toHaveBeenCalledTimes(1);
  });

  it("logs metadata only (runId, teamId, error category, requestId) on a Firestore failure — never prompt content or reviewer comments", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "read_failed" });
    await callRoute();
    expect(mockLoggerWarn).toHaveBeenCalled();
    const [, meta] = mockLoggerWarn.mock.calls[mockLoggerWarn.mock.calls.length - 1];
    expect(meta).toMatchObject({ runId: RUN_ID, teamId: TEAM_ID, errorCategory: "read_failed", requestId: "req-abc-123" });
    const serialized = JSON.stringify(mockLoggerWarn.mock.calls);
    expect(serialized).not.toContain("\"q\"");
  });

  it("logs metadata only on a malformed/forged projection", async () => {
    mockedGetProjection.mockResolvedValueOnce({ status: "found", projection: validProjection({ adaptive: false }) });
    await callRoute();
    const [, meta] = mockLoggerWarn.mock.calls[mockLoggerWarn.mock.calls.length - 1];
    expect(meta).toMatchObject({ runId: RUN_ID, teamId: TEAM_ID, errorCategory: "malformed_projection" });
  });

  it("never exposes reviewer identity or comment text in the response", async () => {
    const { json } = await callRoute();
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("reviewerId");
    expect(serialized).not.toContain("reviewerName");
    expect(serialized).not.toContain("comment");
  });
});
