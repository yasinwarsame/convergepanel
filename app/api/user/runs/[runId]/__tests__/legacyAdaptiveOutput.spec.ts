/**
 * Phase 2 pilot history-reload fix — GET /api/user/runs/[runId]'s new
 * `legacyAdaptive` field.
 *
 * Covers: `legacyAdaptive` is parsed and returned independently of
 * `adaptive` — a procedural run has `adaptive.status: "absent"` (correct,
 * unchanged, that envelope never applies to it) while simultaneously
 * having `legacyAdaptive.status: "valid"` (the new envelope this fix
 * adds); malformed/unsupported-version/absent legacyAdaptiveOutput data
 * fails safely, never throwing; a Milestone-2 schema run (adaptive.status
 * "valid") has legacyAdaptiveOutput genuinely absent on its own document,
 * so legacyAdaptive.status is "absent" there too — the two envelopes never
 * collide.
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
const RUN_ID = "run-1";

const VALID_LEGACY_OUTPUT = { schemaId: "procedural", classification: {}, results: [], alignedClaims: [], gate: {}, synthesisReport: {} };

function buildRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${RUN_ID}`);
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
  mockedRunDocumentToPublicResults.mockReturnValue([{ modelId: "chatgpt" }]);
  // Default: no Milestone-2 envelope (the common, correct case for a
  // procedural run) — individual tests below override legacyAdaptiveOutput.
  mockedParsePersistedAdaptiveOutput.mockReturnValue({ ok: false, reason: "absent" });
  mockedParsePersistedLegacyAdaptiveOutput.mockReturnValue({ ok: false, reason: "absent" });
});

describe("GET /api/user/runs/[runId] — legacyAdaptive (Phase 2 pilot history-reload fix)", () => {
  it("a procedural run: adaptive.status is 'absent' (correct, unchanged) while legacyAdaptive.status is 'valid' — the two envelopes are independent, never conflated", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, question: "q", legacyAdaptiveOutput: { schemaId: "procedural" } }),
    });
    mockedParsePersistedLegacyAdaptiveOutput.mockReturnValue({ ok: true, output: VALID_LEGACY_OUTPUT });

    const { json } = await callRoute();

    expect(json.adaptive.status).toBe("absent");
    expect(json.legacyAdaptive.status).toBe("valid");
    expect(json.legacyAdaptive.output).toEqual(VALID_LEGACY_OUTPUT);
  });

  it("a Milestone-2 schema run: adaptive.status is 'valid' while legacyAdaptiveOutput is genuinely absent on the document, so legacyAdaptive.status is 'absent' — the envelopes never collide", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, question: "q", adaptiveOutput: { schemaId: "comparison_matrix" }, governanceRecord: {} }),
    });
    mockedParsePersistedAdaptiveOutput.mockReturnValue({ ok: true, output: { schemaId: "comparison_matrix", classification: {}, result: {} } });
    mockedParseGovernanceRecord.mockReturnValue({ ok: false });

    const { json } = await callRoute();

    expect(json.adaptive.status).toBe("valid");
    expect(json.legacyAdaptive.status).toBe("absent");
    expect(json.legacyAdaptive.output).toBeNull();
  });

  it("a genuinely legacy (pre-adaptive) run: both envelopes are absent", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, question: "q" }),
    });

    const { json } = await callRoute();

    expect(json.adaptive.status).toBe("absent");
    expect(json.legacyAdaptive.status).toBe("absent");
  });

  it("malformed legacyAdaptiveOutput fails safely — never throws, status is 'malformed', output is null", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, question: "q", legacyAdaptiveOutput: { corrupted: true } }),
    });
    mockedParsePersistedLegacyAdaptiveOutput.mockReturnValue({ ok: false, reason: "malformed" });

    const { json } = await callRoute();

    expect(json.legacyAdaptive.status).toBe("malformed");
    expect(json.legacyAdaptive.output).toBeNull();
  });

  it("legacyAdaptiveOutput from a newer version fails safely as 'unsupported_version'", async () => {
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, question: "q", legacyAdaptiveOutput: { version: 2 } }),
    });
    mockedParsePersistedLegacyAdaptiveOutput.mockReturnValue({ ok: false, reason: "unsupported_version" });

    const { json } = await callRoute();

    expect(json.legacyAdaptive.status).toBe("unsupported_version");
    expect(json.legacyAdaptive.output).toBeNull();
  });
});
