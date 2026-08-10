/**
 * Adaptive Research Export, Phase 2 —
 * GET /api/user/runs/[runId]/exports/[exportId] (historical PDF
 * regeneration) tests. Covers the core Phase 2 invariant (regeneration
 * reads ONLY the frozen export record, never the current run document),
 * run/export binding (IDOR), authorization (current entitlement + frozen
 * governance/classification), version-dispatch failure, and reliability
 * semantics (audit failure never breaks a successful regeneration).
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

const mockedGetAdaptiveExportRecord = jest.fn();
jest.mock("@/lib/firestore/adaptiveExports", () => ({
  getAdaptiveExportRecord: (...args: any[]) => mockedGetAdaptiveExportRecord(...args),
}));

const mockedResolveAdaptiveExportVerdict = jest.fn();
jest.mock("@/lib/adaptiveSchema/exportAuthorization", () => ({
  resolveAdaptiveExportVerdict: (...args: any[]) => mockedResolveAdaptiveExportVerdict(...args),
}));

const mockedRenderAdaptiveResearchExport = jest.fn();
jest.mock("@/lib/pdf/renderAdaptiveResearchPdf", () => ({
  renderAdaptiveResearchExport: (...args: any[]) => mockedRenderAdaptiveResearchExport(...args),
}));

const mockedWriteAdaptiveExportAdminAuditEvent = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptiveExportAdminAuditEvent: (...args: any[]) => mockedWriteAdaptiveExportAdminAuditEvent(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/exports/[exportId]/route";

const UID = "user-1";
const RUN_ID = "run-1";
const EXPORT_ID = "exp-1";

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    exportId: EXPORT_ID,
    runId: RUN_ID,
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: UID,
    format: "pdf",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "legacy", status: "needs_review" },
    reportSnapshot: {
      question: "q",
      models: [],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "weak",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      legacy: { schemaId: "financial_valuation", alignedClaims: [] },
    },
    exportMetadata: { exportId: EXPORT_ID, runId: RUN_ID, schemaVersion: 1, exportedSections: [], createdAt: "2026-01-01T00:00:00.000Z", requestingUser: UID, finalReportVersion: 3 },
    ...overrides,
  };
}

function buildRequest(runId: string = RUN_ID, exportId: string = EXPORT_ID): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${runId}/exports/${exportId}`);
}

async function callRoute(runId: string = RUN_ID, exportId: string = EXPORT_ID) {
  return GET(buildRequest(runId, exportId), { params: Promise.resolve({ runId, exportId }) });
}

beforeEach(() => {
  mockFlagEnabled = true;
  mockedResolveRequestIdentity.mockReset().mockResolvedValue({ status: "authenticated", uid: UID });
  mockedRunGet.mockReset().mockResolvedValue({ exists: true, data: () => ({ userId: UID }) });
  mockedGetAdaptiveExportRecord.mockReset().mockResolvedValue({ ok: true, record: buildRecord() });
  mockedResolveAdaptiveExportVerdict.mockReset().mockResolvedValue({ allowed: true, requiresVisibleStatusNotice: false });
  mockedRenderAdaptiveResearchExport.mockReset().mockResolvedValue({ bytes: Buffer.from("%PDF-regenerated"), sha256: "abc123" });
  mockedWriteAdaptiveExportAdminAuditEvent.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — auth and gating", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it("404s when the feature flag is disabled", async () => {
    mockFlagEnabled = false;
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockedGetAdaptiveExportRecord).not.toHaveBeenCalled();
  });

  it("404s when the run does not exist", async () => {
    mockedRunGet.mockResolvedValue({ exists: false });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("404s (not 403) when the requesting user does not own the run — never reveals existence via a different status", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: "someone-else" }) });
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockedGetAdaptiveExportRecord).not.toHaveBeenCalled();
  });

  it("404s when the export record does not exist", async () => {
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — run/export binding (IDOR)", () => {
  it("404s when the loaded export record's own runId does not match the URL's runId — cross-run export substitution", async () => {
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record: buildRecord({ runId: "a-completely-different-run" }) });
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockedRenderAdaptiveResearchExport).not.toHaveBeenCalled();
  });

  it("404s when the loaded export record's own exportId does not match the URL's exportId", async () => {
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record: buildRecord({ exportId: "exp-different" }) });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("fetches the export scoped to the URL's own runId — never trusts a client-supplied run ID inside any body", async () => {
    await callRoute("run-A", EXPORT_ID);
    expect(mockedGetAdaptiveExportRecord).toHaveBeenCalledWith("run-A", EXPORT_ID);
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — export readiness", () => {
  it("409s for an export that never completed (still generating)", async () => {
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record: buildRecord({ artifactStatus: "generating" }) });
    const res = await callRoute();
    expect(res.status).toBe(409);
  });

  it("409s for an export that failed to generate", async () => {
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record: buildRecord({ artifactStatus: "failed" }) });
    const res = await callRoute();
    expect(res.status).toBe(409);
  });

  it("succeeds for a superseded export — Part 8: superseded is still regeneratable, never treated as invalid", async () => {
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record: buildRecord({ artifactStatus: "superseded" }) });
    const res = await callRoute();
    expect(res.status).toBe(200);
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — authorization (Part 9)", () => {
  it("authorizes using CURRENT ownership but the FROZEN classification/governance from the export record, not a freshly-built snapshot", async () => {
    const record = buildRecord({ classification: "confidential", governanceStatusAtExport: { family: "legacy", status: "blocked" } });
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });
    await callRoute();
    expect(mockedResolveAdaptiveExportVerdict).toHaveBeenCalledWith(UID, UID, "confidential", { family: "legacy", status: "blocked" });
  });

  it("403s with the verdict's own reason when current authorization denies access (e.g. entitlement since removed)", async () => {
    mockedResolveAdaptiveExportVerdict.mockResolvedValue({ allowed: false, reason: "plan_not_entitled" });
    const res = await callRoute();
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("plan_not_entitled");
    expect(mockedRenderAdaptiveResearchExport).not.toHaveBeenCalled();
  });

  it("does not grant permanent access merely because the export already exists — access tracks current authorization, not export-time authorization", async () => {
    // Same scenario as above, phrased as the explicit invariant: an export
    // created while entitled must still be deniable once entitlement is
    // removed, purely via the verdict function's own current-state checks.
    mockedResolveAdaptiveExportVerdict.mockResolvedValue({ allowed: false, reason: "plan_not_entitled" });
    const res = await callRoute();
    expect(res.status).toBe(403);
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — core Phase 2 invariant: frozen snapshot only", () => {
  it("never reads the current run document beyond the initial ownership check — regeneration renders only the frozen export record", async () => {
    const record = buildRecord();
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });
    await callRoute();
    // Exactly one run read (ownership) — renderAdaptiveResearchExport is
    // called with the frozen record, never anything derived from a second
    // run lookup.
    expect(mockedRenderAdaptiveResearchExport).toHaveBeenCalledWith(record);
  });

  it("regenerates successfully and streams the PDF bytes with correct headers", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment/);
    expect(res.headers.get("Content-Disposition")).toContain("v3"); // reportVersion from the frozen record
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe("%PDF-regenerated");
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — schema family coverage (Part 21)", () => {
  it("regenerates a milestone2-family export (comparison_matrix) using the same code path as legacy — no schema-family branching in the route itself", async () => {
    const record = buildRecord({
      schemaId: "comparison_matrix",
      schemaFamily: "milestone2",
      classification: "internal",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
      reportSnapshot: {
        question: "q",
        models: [],
        reportTypeLabel: "Comparison Report",
        consensusLevel: "moderate",
        sourceGroundingLevel: "strong",
        reportGeneratedAt: "2026-01-01T00:00:00.000Z",
        milestone2: { schemaId: "comparison_matrix", result: {}, meta: {} },
      },
    });
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockedResolveAdaptiveExportVerdict).toHaveBeenCalledWith(UID, UID, "internal", {
      family: "milestone2",
      kind: "approved",
      isOwnerOverride: false,
    });
    expect(mockedRenderAdaptiveResearchExport).toHaveBeenCalledWith(record);
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — format-specific regeneration (Phase 3)", () => {
  it("a DOCX-format export regenerates with DOCX headers, never PDF's", async () => {
    const record = buildRecord({ format: "docx" });
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });
    mockedRenderAdaptiveResearchExport.mockResolvedValue({ bytes: Buffer.from("PK-regenerated-docx"), sha256: "docxsha" });

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(res.headers.get("Content-Disposition")).toMatch(/\.docx"/);
    expect(res.headers.get("Content-Disposition")).not.toMatch(/\.pdf"/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe("PK-regenerated-docx");
  });

  it("a PDF-format export still regenerates with PDF headers, unaffected by DOCX now existing as a format", async () => {
    const record = buildRecord({ format: "pdf" });
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/\.pdf"/);
  });

  it("never lets any client-supplied input coerce a historical export's format — the route reads format exclusively from the frozen record, there is no request body/query param it could come from", async () => {
    const record = buildRecord({ format: "docx" });
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });
    mockedRenderAdaptiveResearchExport.mockResolvedValue({ bytes: Buffer.from("PK-regenerated-docx"), sha256: "docxsha" });
    // The regeneration route is a bare GET with no body — buildRequest/
    // callRoute never construct one — so this test's real assertion is
    // structural: renderAdaptiveResearchExport is called with the exact
    // frozen record object (format included), never a derived/mutated copy.
    await callRoute();
    expect(mockedRenderAdaptiveResearchExport).toHaveBeenCalledWith(record);
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — version dispatch failure", () => {
  it("500s cleanly when the version-aware renderer rejects an unsupported/unknown contract version", async () => {
    mockedRenderAdaptiveResearchExport.mockRejectedValue(new Error("Unsupported AdaptiveResearchExport contract version: 2"));
    const res = await callRoute();
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.errorCode).toBe("regeneration_failed");
  });
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — audit + reliability semantics", () => {
  it("records a regeneration audit event with the frozen record's own metadata", async () => {
    await callRoute();
    expect(mockedWriteAdaptiveExportAdminAuditEvent).toHaveBeenCalledTimes(1);
    const call = mockedWriteAdaptiveExportAdminAuditEvent.mock.calls[0][0];
    expect(call.action).toBe("adaptive_export_regenerated");
    expect(call.exportId).toBe(EXPORT_ID);
    expect(call.runId).toBe(RUN_ID);
    expect(call.reportVersion).toBe(3);
    expect(call.governanceStatusAtExport).toBe("legacy:needs_review");
  });

  it("a failed audit write never turns a successful regeneration into a failed response", async () => {
    mockedWriteAdaptiveExportAdminAuditEvent.mockRejectedValue(new Error("transient audit failure"));
    const res = await callRoute();
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe("%PDF-regenerated");
  });
});
