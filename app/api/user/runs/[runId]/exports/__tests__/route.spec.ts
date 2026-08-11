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

  describe("Phase 5 final review, Step 3 — hashReproducible must accurately distinguish DOCX from PDF/JSON", () => {
    it("PDF: fileHash present with hashReproducible=true", async () => {
      mockedListAdaptiveExportRecords.mockResolvedValue({
        ok: true,
        records: [buildRecord({ format: "pdf", exportMetadata: { ...buildRecord().exportMetadata, fileHash: "sha-pdf" } })],
        hasMore: false,
      });
      const res = await callRoute();
      const json = await res.json();
      expect(json.exports[0]).toMatchObject({ fileHash: "sha-pdf", hashAlgorithm: "sha256", hashReproducible: true });
    });

    it("JSON: fileHash present with hashReproducible=true", async () => {
      mockedListAdaptiveExportRecords.mockResolvedValue({
        ok: true,
        records: [buildRecord({ format: "json", exportMetadata: { ...buildRecord().exportMetadata, fileHash: "sha-json" } })],
        hasMore: false,
      });
      const res = await callRoute();
      const json = await res.json();
      expect(json.exports[0]).toMatchObject({ fileHash: "sha-json", hashAlgorithm: "sha256", hashReproducible: true });
    });

    it("DOCX: fileHash present with hashReproducible=FALSE — must never look identical to PDF/JSON's reproducible hash", async () => {
      mockedListAdaptiveExportRecords.mockResolvedValue({
        ok: true,
        records: [buildRecord({ format: "docx", exportMetadata: { ...buildRecord().exportMetadata, fileHash: "sha-docx" } })],
        hasMore: false,
      });
      const res = await callRoute();
      const json = await res.json();
      expect(json.exports[0]).toMatchObject({ fileHash: "sha-docx", hashAlgorithm: "sha256", hashReproducible: false });
    });

    it("absent fileHash (generating/failed) — no fileHash/hashAlgorithm/hashReproducible fields at all, for any format", async () => {
      mockedListAdaptiveExportRecords.mockResolvedValue({
        ok: true,
        records: [buildRecord({ format: "docx", artifactStatus: "failed", exportMetadata: { ...buildRecord().exportMetadata, fileHash: undefined } })],
        hasMore: false,
      });
      const res = await callRoute();
      const json = await res.json();
      expect(json.exports[0].fileHash).toBeUndefined();
      expect(json.exports[0].hashAlgorithm).toBeUndefined();
      expect(json.exports[0].hashReproducible).toBeUndefined();
    });
  });

  describe("Phase 5 final review, Steps 6/14 — cursor/limit query params are parsed and forwarded correctly, malformed values degrade safely", () => {
    function callRouteWithQuery(qs: string) {
      const req = new NextRequest(`http://localhost/api/user/runs/${RUN_ID}/exports${qs}`);
      return GET(req, { params: Promise.resolve({ runId: RUN_ID }) });
    }

    it("no query params — calls the Firestore layer with limit/beforeReportVersion both undefined", async () => {
      await callRouteWithQuery("");
      expect(mockedListAdaptiveExportRecords).toHaveBeenCalledWith(RUN_ID, { limit: undefined, beforeReportVersion: undefined });
    });

    it("?cursor=5&limit=10 — forwarded as parsed numbers", async () => {
      await callRouteWithQuery("?cursor=5&limit=10");
      expect(mockedListAdaptiveExportRecords).toHaveBeenCalledWith(RUN_ID, { limit: 10, beforeReportVersion: 5 });
    });

    it("?cursor=not-a-number — degrades to undefined (first page), never throws, never 500s", async () => {
      const res = await callRouteWithQuery("?cursor=not-a-number");
      expect(res.status).toBe(200);
      expect(mockedListAdaptiveExportRecords).toHaveBeenCalledWith(RUN_ID, { limit: undefined, beforeReportVersion: undefined });
    });

    it("?limit=10.7 (fractional) — truncated before being forwarded, never passed through as a fraction", async () => {
      await callRouteWithQuery("?limit=10.7");
      expect(mockedListAdaptiveExportRecords).toHaveBeenCalledWith(RUN_ID, { limit: 10, beforeReportVersion: undefined });
    });

    it("?limit=Infinity — rejected as non-finite, forwarded as undefined", async () => {
      await callRouteWithQuery("?limit=Infinity");
      expect(mockedListAdaptiveExportRecords).toHaveBeenCalledWith(RUN_ID, { limit: undefined, beforeReportVersion: undefined });
    });

    it("hasMore/nextCursor from the Firestore layer are passed through in the response body", async () => {
      mockedListAdaptiveExportRecords.mockResolvedValue({ ok: true, records: [buildRecord({ reportVersion: 5 })], hasMore: true });
      const res = await callRoute();
      const json = await res.json();
      expect(json.hasMore).toBe(true);
      expect(json.nextCursor).toBe(5);
    });

    it("hasMore=false — nextCursor is null, never a stale/leftover cursor value", async () => {
      mockedListAdaptiveExportRecords.mockResolvedValue({ ok: true, records: [buildRecord({ reportVersion: 5 })], hasMore: false });
      const res = await callRoute();
      const json = await res.json();
      expect(json.hasMore).toBe(false);
      expect(json.nextCursor).toBeNull();
    });
  });
});
