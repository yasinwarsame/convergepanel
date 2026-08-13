/**
 * Export Generator Provenance — POST /api/user/runs/[runId]/export wiring
 * tests. Mirrors the mocking style of the sibling `route.spec.ts` file
 * (mocks `resolveExportGeneratedBy` directly, same as that file mocks
 * `resolveAdaptiveExportVerdict`), so this file can assert the ROUTE
 * genuinely threads the resolved identity into the frozen record it
 * persists, independent of `resolveExportGeneratedBy`'s own unit tests
 * (exportGeneratedBy.spec.ts).
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));

jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

jest.mock("@/lib/env", () => ({
  ADAPTIVE_RESEARCH_EXPORT_ENABLED: true,
  ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED: true,
  ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED: true,
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

const mockedResolveExportGeneratedBy = jest.fn();
jest.mock("@/lib/adaptiveSchema/exportGeneratedBy", () => ({
  resolveExportGeneratedBy: (...args: any[]) => mockedResolveExportGeneratedBy(...args),
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
  renderAdaptiveResearchExport: (...args: any[]) => mockedRenderAdaptiveResearchPdf(...args),
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
  mockedResolveRequestIdentity.mockReset().mockResolvedValue({ status: "authenticated", uid: UID });
  mockedRunGet.mockReset();
  mockedParsePersistedAdaptiveOutput.mockReset().mockReturnValue({ ok: false, reason: "absent" });
  mockedParsePersistedLegacyAdaptiveOutput.mockReset().mockReturnValue({ ok: false, reason: "absent" });
  mockedParseGovernanceRecord.mockReset().mockReturnValue({ ok: false });
  mockedBuildExportSnapshot.mockReset().mockReturnValue(BASE_SNAPSHOT_RESULT);
  mockedResolveAdaptiveExportVerdict.mockReset().mockResolvedValue({ allowed: true, requiresVisibleStatusNotice: false });
  mockedResolveExportGeneratedBy.mockReset().mockResolvedValue({ displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" });
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

describe("POST /api/user/runs/[runId]/export — generator provenance freezing", () => {
  it("resolves generatedBy from the authenticated uid and freezes it into the persisted record", async () => {
    await callRoute();
    expect(mockedResolveExportGeneratedBy).toHaveBeenCalledWith(UID);
    expect(mockedCreateAdaptiveExportRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        record: expect.objectContaining({
          generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" },
        }),
      })
    );
  });

  it("never accepts a client-supplied generatedBy — request body fields are ignored, identity always comes from the authenticated uid", async () => {
    await callRoute(RUN_ID, { format: "pdf", generatedBy: { displayName: "Forged Name", maskedEmail: "fo***@evil.com" } });
    expect(mockedResolveExportGeneratedBy).toHaveBeenCalledWith(UID);
    const persistedRecord = mockedCreateAdaptiveExportRecord.mock.calls[0][0].record;
    expect(persistedRecord.generatedBy).toEqual({ displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" });
    expect(JSON.stringify(persistedRecord.generatedBy)).not.toContain("Forged");
    expect(JSON.stringify(persistedRecord.generatedBy)).not.toContain("evil.com");
  });

  it("also passes generatedBy through to the renderer via the full frozen record (fullRecord spreads recordBase)", async () => {
    await callRoute();
    expect(mockedRenderAdaptiveResearchPdf).toHaveBeenCalledWith(
      expect.objectContaining({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } })
    );
  });

  it("missing display name and email (neutral fallback from the resolver): still freezes whatever the resolver returned, never invents its own fallback", async () => {
    mockedResolveExportGeneratedBy.mockResolvedValue({ displayName: "ConvergePanel user", maskedEmail: null });
    await callRoute();
    const persistedRecord = mockedCreateAdaptiveExportRecord.mock.calls[0][0].record;
    expect(persistedRecord.generatedBy).toEqual({ displayName: "ConvergePanel user", maskedEmail: null });
  });

  it("does not resolve generatedBy at all when authorization denies the export (verdict check happens first)", async () => {
    mockedResolveAdaptiveExportVerdict.mockResolvedValue({ allowed: false, reason: "plan_not_entitled" });
    await callRoute();
    expect(mockedResolveExportGeneratedBy).not.toHaveBeenCalled();
    expect(mockedCreateAdaptiveExportRecord).not.toHaveBeenCalled();
  });
});
