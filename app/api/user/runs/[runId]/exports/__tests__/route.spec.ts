/**
 * Adaptive Research Export, Phase 2 —
 * GET /api/user/runs/[runId]/exports (historical export listing) tests.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

let mockFlagEnabled = true;
jest.mock("@/lib/env", () => ({
  get ADAPTIVE_RESEARCH_EXPORT_ENABLED() {
    return mockFlagEnabled;
  },
}));

const mockedRunGet = jest.fn();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: () => ({
        doc: () => ({ get: async () => mockedRunGet() }),
      }),
    };
  },
}));

const mockedListAdaptiveExportRecords = jest.fn();
jest.mock("@/lib/firestore/adaptiveExports", () => ({
  listAdaptiveExportRecords: (...args: any[]) => mockedListAdaptiveExportRecords(...args),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/exports/route";

const UID = "user-1";
const RUN_ID = "run-1";

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    exportId: "exp-1",
    runId: RUN_ID,
    schemaId: "comparison_matrix",
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: UID,
    format: "pdf",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    reportSnapshot: {
      question: "the actual question text",
      models: [],
      reportTypeLabel: "Comparison Report",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      milestone2: { schemaId: "comparison_matrix", result: { sensitive: "internal aggregate" }, meta: {}, decisionReceipt: { conclusion: "a private conclusion" } },
    },
    exportMetadata: { exportId: "exp-1", runId: RUN_ID, schemaVersion: 1, exportedSections: [], createdAt: "2026-01-01T00:00:00.000Z", requestingUser: UID, finalReportVersion: 1 },
    ...overrides,
  };
}

function buildRequest(runId: string = RUN_ID): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${runId}/exports`);
}

async function callRoute(runId: string = RUN_ID) {
  return GET(buildRequest(runId), { params: Promise.resolve({ runId }) });
}

beforeEach(() => {
  mockFlagEnabled = true;
  mockedResolveRequestIdentity.mockReset().mockResolvedValue({ status: "authenticated", uid: UID });
  mockedRunGet.mockReset().mockResolvedValue({ exists: true, data: () => ({ userId: UID }) });
  mockedListAdaptiveExportRecords.mockReset().mockResolvedValue({ ok: true, records: [buildRecord()] });
});

describe("GET /api/user/runs/[runId]/exports", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it("404s when the feature flag is disabled", async () => {
    mockFlagEnabled = false;
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockedListAdaptiveExportRecords).not.toHaveBeenCalled();
  });

  it("404s when the run does not exist", async () => {
    mockedRunGet.mockResolvedValue({ exists: false });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("403s when the requesting user does not own the run", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: "someone-else" }) });
    const res = await callRoute();
    expect(res.status).toBe(403);
    expect(mockedListAdaptiveExportRecords).not.toHaveBeenCalled();
  });

  it("returns an empty list, not an error, when the run has no exports", async () => {
    mockedListAdaptiveExportRecords.mockResolvedValue({ ok: true, records: [] });
    const res = await callRoute();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.exports).toEqual([]);
  });

  it("returns multiple exports in the order the Firestore layer already sorted them", async () => {
    mockedListAdaptiveExportRecords.mockResolvedValue({
      ok: true,
      records: [buildRecord({ exportId: "exp-3", reportVersion: 3, artifactStatus: "ready" }), buildRecord({ exportId: "exp-2", reportVersion: 2, artifactStatus: "superseded" }), buildRecord({ exportId: "exp-1", reportVersion: 1, artifactStatus: "superseded" })],
    });
    const res = await callRoute();
    const json = await res.json();
    expect(json.exports.map((e: any) => e.exportId)).toEqual(["exp-3", "exp-2", "exp-1"]);
  });

  it("includes superseded exports in the list — Part 8: never hidden solely for being superseded", async () => {
    mockedListAdaptiveExportRecords.mockResolvedValue({ ok: true, records: [buildRecord({ artifactStatus: "superseded" })] });
    const res = await callRoute();
    const json = await res.json();
    expect(json.exports[0].artifactStatus).toBe("superseded");
  });

  it("never leaks the full frozen reportSnapshot in the list response — metadata only", async () => {
    const res = await callRoute();
    const json = await res.json();
    const raw = JSON.stringify(json);
    expect(json.exports[0].reportSnapshot).toBeUndefined();
    expect(raw).not.toContain("a private conclusion");
    expect(raw).not.toContain("internal aggregate");
    expect(raw).not.toContain("the actual question text");
  });

  it("500s cleanly when the Firestore list read fails", async () => {
    mockedListAdaptiveExportRecords.mockResolvedValue({ ok: false, reason: "read_failed" });
    const res = await callRoute();
    expect(res.status).toBe(500);
  });
});
