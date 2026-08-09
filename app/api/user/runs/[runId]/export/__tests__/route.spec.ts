/**
 * Adaptive Research Export, Phase 1 — POST /api/user/runs/[runId]/export
 * wiring tests. Authorization POLICY (plan/role/governance-state axes) is
 * already exhaustively unit-tested in
 * lib/adaptiveSchema/__tests__/exportAuthorization.spec.ts against the pure
 * canExportAdaptiveResearch() function; this file mocks
 * resolveAdaptiveExportVerdict() directly and instead verifies the ROUTE's
 * own sequencing — auth, flag gate, run loading/ownership, format
 * validation, snapshot building, and the create → generate → mark-ready/
 * mark-failed → supersede → audit pipeline (Part 12/19), including that a
 * failed PDF generation never returns a partial/successful download and
 * always records "failed", never "ready".
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

const mockedBuildExportSnapshot = jest.fn();
jest.mock("@/lib/adaptiveSchema/exportSnapshot", () => ({
  buildExportSnapshot: (...args: any[]) => mockedBuildExportSnapshot(...args),
}));

const mockedResolveAdaptiveExportVerdict = jest.fn();
jest.mock("@/lib/adaptiveSchema/exportAuthorization", () => ({
  resolveAdaptiveExportVerdict: (...args: any[]) => mockedResolveAdaptiveExportVerdict(...args),
}));

const mockedCreateAdaptiveExportRecord = jest.fn();
const mockedMarkAdaptiveExportReady = jest.fn();
const mockedMarkAdaptiveExportFailed = jest.fn();
const mockedSupersedeOlderAdaptiveExports = jest.fn();
jest.mock("@/lib/firestore/adaptiveExports", () => ({
  createAdaptiveExportRecord: (...args: any[]) => mockedCreateAdaptiveExportRecord(...args),
  markAdaptiveExportReady: (...args: any[]) => mockedMarkAdaptiveExportReady(...args),
  markAdaptiveExportFailed: (...args: any[]) => mockedMarkAdaptiveExportFailed(...args),
  supersedeOlderAdaptiveExports: (...args: any[]) => mockedSupersedeOlderAdaptiveExports(...args),
}));

const mockedRenderAdaptiveResearchPdf = jest.fn();
jest.mock("@/lib/pdf/renderAdaptiveResearchPdf", () => ({
  renderAdaptiveResearchPdf: (...args: any[]) => mockedRenderAdaptiveResearchPdf(...args),
}));

const mockedWriteAdaptiveExportAdminAuditEvent = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({
  writeAdaptiveExportAdminAuditEvent: (...args: any[]) => mockedWriteAdaptiveExportAdminAuditEvent(...args),
}));

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/user/runs/[runId]/export/route";

const UID = "user-1";
const RUN_ID = "run-1";

const BASE_SNAPSHOT_RESULT = {
  reportSnapshot: { question: "q", models: [], reportTypeLabel: "Comparison Report", consensusLevel: "moderate", sourceGroundingLevel: "strong", reportGeneratedAt: "2026-01-01T00:00:00.000Z", milestone2: { schemaId: "comparison_matrix", result: {}, meta: {} } },
  governanceStatusAtExport: { family: "milestone2" as const, kind: "approved" as const, isOwnerOverride: false },
  classification: "internal" as const,
};

function buildRequest(body: unknown = { format: "pdf" }, runId: string = RUN_ID): NextRequest {
  return new NextRequest(`http://localhost/api/user/runs/${runId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callRoute(runId: string = RUN_ID, body: unknown = { format: "pdf" }) {
  const res = await POST(buildRequest(body, runId), { params: Promise.resolve({ runId }) });
  return res;
}

beforeEach(() => {
  mockFlagEnabled = true;
  mockedResolveRequestIdentity.mockReset().mockResolvedValue({ status: "authenticated", uid: UID });
  mockedRunGet.mockReset();
  mockedParsePersistedAdaptiveOutput.mockReset().mockReturnValue({ ok: false, reason: "absent" });
  mockedParsePersistedLegacyAdaptiveOutput.mockReset().mockReturnValue({ ok: false, reason: "absent" });
  mockedParseGovernanceRecord.mockReset().mockReturnValue({ ok: false });
  mockedBuildExportSnapshot.mockReset().mockReturnValue(BASE_SNAPSHOT_RESULT);
  mockedResolveAdaptiveExportVerdict.mockReset().mockResolvedValue({ allowed: true, requiresVisibleStatusNotice: false });
  mockedCreateAdaptiveExportRecord.mockReset().mockResolvedValue({ ok: true, reportVersion: 3 });
  mockedMarkAdaptiveExportReady.mockReset().mockResolvedValue({ ok: true });
  mockedMarkAdaptiveExportFailed.mockReset().mockResolvedValue({ ok: true });
  mockedSupersedeOlderAdaptiveExports.mockReset().mockResolvedValue({ ok: true });
  mockedRenderAdaptiveResearchPdf.mockReset().mockResolvedValue({ bytes: Buffer.from("%PDF-fake"), sha256: "abc123" });
  mockedWriteAdaptiveExportAdminAuditEvent.mockReset().mockResolvedValue(undefined);

  mockedRunGet.mockResolvedValue({
    exists: true,
    data: () => ({ userId: UID, question: "q", selectedModels: [], adaptiveOutput: { schemaId: "comparison_matrix" }, governanceRecord: {} }),
  });
  mockedParsePersistedAdaptiveOutput.mockReturnValue({ ok: true, output: { schemaId: "comparison_matrix", classification: {}, result: {} } });
});

describe("POST /api/user/runs/[runId]/export — auth and gating", () => {
  it("401s when unauthenticated", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(mockedCreateAdaptiveExportRecord).not.toHaveBeenCalled();
  });

  it("404s when ADAPTIVE_RESEARCH_EXPORT_ENABLED is false — flag disabled entirely, independent of authorization", async () => {
    mockFlagEnabled = false;
    const res = await callRoute();
    expect(res.status).toBe(404);
    expect(mockedResolveAdaptiveExportVerdict).not.toHaveBeenCalled();
  });

  it("404s on a malformed/empty run ID", async () => {
    const res = await callRoute("");
    expect(res.status).toBe(404);
  });

  it("400s when format is not exactly \"pdf\" — DOCX/JSON/CSV rejected outright, Phase 1 supports PDF only", async () => {
    const res = await callRoute(RUN_ID, { format: "docx" });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.errorCode).toBe("unsupported_format");
    expect(mockedCreateAdaptiveExportRecord).not.toHaveBeenCalled();
  });

  it("400s on an invalid JSON body", async () => {
    const req = new NextRequest(`http://localhost/api/user/runs/${RUN_ID}/export`, { method: "POST", body: "{not json" });
    const res = await POST(req, { params: Promise.resolve({ runId: RUN_ID }) });
    expect(res.status).toBe(400);
  });

  it("404s when the run does not exist", async () => {
    mockedRunGet.mockResolvedValue({ exists: false });
    const res = await callRoute();
    expect(res.status).toBe(404);
  });

  it("403s when the requesting user does not own the run — IDOR guard", async () => {
    mockedRunGet.mockResolvedValue({ exists: true, data: () => ({ userId: "someone-else", question: "q" }) });
    const res = await callRoute();
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("forbidden");
    expect(mockedResolveAdaptiveExportVerdict).not.toHaveBeenCalled();
  });

  it("422s when the run has neither a Milestone-2 nor a legacy adaptive report", async () => {
    mockedParsePersistedAdaptiveOutput.mockReturnValue({ ok: false, reason: "absent" });
    mockedParsePersistedLegacyAdaptiveOutput.mockReturnValue({ ok: false, reason: "absent" });
    const res = await callRoute();
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.errorCode).toBe("no_report");
  });

  it("403s with the verdict's own reason when the central authorization function denies export — server re-checks, never trusts client-implied eligibility", async () => {
    mockedResolveAdaptiveExportVerdict.mockResolvedValue({ allowed: false, reason: "plan_not_entitled" });
    const res = await callRoute();
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.errorCode).toBe("plan_not_entitled");
    expect(mockedCreateAdaptiveExportRecord).not.toHaveBeenCalled();
  });

  it("500s when the export record cannot even be created, before any PDF generation is attempted", async () => {
    mockedCreateAdaptiveExportRecord.mockResolvedValue({ ok: false, reason: "write_failed" });
    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(mockedRenderAdaptiveResearchPdf).not.toHaveBeenCalled();
  });

  it("ignores forged governance/classification/report content in the request body — the route only ever reads `format` from the client; everything else is server-derived from the stored run", async () => {
    const res = await callRoute(RUN_ID, {
      format: "pdf",
      governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
      classification: "public",
      reportSnapshot: { question: "forged question", milestone2: { decisionReceipt: { conclusion: "forged conclusion" } } },
    });
    expect(res.status).toBe(200);
    // buildExportSnapshot is only ever called with { question, selectedModels, milestone2/legacy } derived
    // from the Firestore run document — never with anything from the request body.
    const snapshotCallArg = mockedBuildExportSnapshot.mock.calls[0][0];
    expect(snapshotCallArg).not.toHaveProperty("governanceStatusAtExport");
    expect(snapshotCallArg).not.toHaveProperty("classification");
    expect(JSON.stringify(snapshotCallArg)).not.toContain("forged");
  });
});

describe("POST /api/user/runs/[runId]/export — success path (Part 12/19 sequencing)", () => {
  it("returns the generated PDF bytes with the correct headers", async () => {
    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment/);
    expect(res.headers.get("Content-Disposition")).toContain(RUN_ID);
    expect(res.headers.get("Content-Disposition")).toContain("v3");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString()).toBe("%PDF-fake");
  });

  it("marks the export ready and supersedes older exports only AFTER PDF generation genuinely succeeds — never before", async () => {
    await callRoute();
    expect(mockedRenderAdaptiveResearchPdf).toHaveBeenCalledTimes(1);
    expect(mockedMarkAdaptiveExportReady).toHaveBeenCalledWith(RUN_ID, expect.stringMatching(/^exp-/), "abc123");
    expect(mockedSupersedeOlderAdaptiveExports).toHaveBeenCalledWith(RUN_ID, expect.stringMatching(/^exp-/));
    expect(mockedMarkAdaptiveExportFailed).not.toHaveBeenCalled();
  });

  it("records a success audit event with matching exportId/runId/reportVersion — artifact and audit trail stay consistent", async () => {
    await callRoute();
    expect(mockedWriteAdaptiveExportAdminAuditEvent).toHaveBeenCalledTimes(1);
    const auditCall = mockedWriteAdaptiveExportAdminAuditEvent.mock.calls[0][0];
    expect(auditCall.action).toBe("adaptive_export_generated");
    expect(auditCall.runId).toBe(RUN_ID);
    expect(auditCall.reportVersion).toBe(3);
    expect(auditCall.actorUid).toBe(UID);

    const readyCallExportId = mockedMarkAdaptiveExportReady.mock.calls[0][1];
    expect(auditCall.exportId).toBe(readyCallExportId);
  });

  it("legacy-family runs also succeed, with exportedSections/audit reflecting the legacy branch", async () => {
    mockedParsePersistedAdaptiveOutput.mockReturnValue({ ok: false, reason: "absent" });
    mockedParsePersistedLegacyAdaptiveOutput.mockReturnValue({ ok: true, output: { schemaId: "financial_valuation", classification: {}, results: [], alignedClaims: [] } });
    mockedRunGet.mockResolvedValue({
      exists: true,
      data: () => ({ userId: UID, question: "q", selectedModels: [], legacyAdaptiveOutput: { schemaId: "financial_valuation" }, governanceStatus: "approved" }),
    });
    mockedBuildExportSnapshot.mockReturnValue({
      ...BASE_SNAPSHOT_RESULT,
      governanceStatusAtExport: { family: "legacy" as const, status: "approved" as const },
      reportSnapshot: { ...BASE_SNAPSHOT_RESULT.reportSnapshot, milestone2: undefined, legacy: { schemaId: "financial_valuation", alignedClaims: [] } },
    });

    const res = await callRoute();
    expect(res.status).toBe(200);
    const auditCall = mockedWriteAdaptiveExportAdminAuditEvent.mock.calls[0][0];
    expect(auditCall.schemaFamily).toBe("legacy");
    expect(auditCall.governanceStatusAtExport).toBe("legacy:approved");
  });
});

describe("POST /api/user/runs/[runId]/export — failure path (Part 19: never a partial/successful download)", () => {
  it("returns a clean 500 error, never PDF bytes, when generation throws", async () => {
    mockedRenderAdaptiveResearchPdf.mockRejectedValue(new Error("layout engine exploded"));
    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).not.toBe("application/pdf");
    const json = await res.json();
    expect(json.errorCode).toBe("pdf_generation_failed");
  });

  it("marks the record failed, never ready, and never supersedes anything on failure", async () => {
    mockedRenderAdaptiveResearchPdf.mockRejectedValue(new Error("layout engine exploded"));
    await callRoute();
    expect(mockedMarkAdaptiveExportFailed).toHaveBeenCalledWith(RUN_ID, expect.stringMatching(/^exp-/), "layout engine exploded");
    expect(mockedMarkAdaptiveExportReady).not.toHaveBeenCalled();
    expect(mockedSupersedeOlderAdaptiveExports).not.toHaveBeenCalled();
  });

  it("records a distinct failure audit event, distinguishable from a successful export", async () => {
    mockedRenderAdaptiveResearchPdf.mockRejectedValue(new Error("layout engine exploded"));
    await callRoute();
    expect(mockedWriteAdaptiveExportAdminAuditEvent).toHaveBeenCalledTimes(1);
    const auditCall = mockedWriteAdaptiveExportAdminAuditEvent.mock.calls[0][0];
    expect(auditCall.action).toBe("adaptive_export_generation_failed");
    expect(auditCall.failureReason).toBe("layout engine exploded");
  });
});
