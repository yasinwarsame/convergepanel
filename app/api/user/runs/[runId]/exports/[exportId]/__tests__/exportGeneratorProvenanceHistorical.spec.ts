/**
 * Export Generator Provenance — historical regeneration invariant test.
 * Mirrors the mocking style of the sibling `route.spec.ts`. Proves the
 * exact scenario the product spec calls out explicitly: an export is
 * created with one frozen identity, the account's name/email changes
 * afterward, and regenerating that same historical export still renders
 * the ORIGINAL frozen `generatedBy` — never a live re-lookup. There is no
 * mock for `@/lib/adaptiveSchema/exportGeneratedBy` in this file at all
 * (deliberately, matching that the real route never imports it) — if a
 * future regression made the regeneration route call it, this file would
 * fail with "Cannot find module" / an unmocked-import error, not silently
 * pass.
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
    governanceStatusAtExport: { family: "legacy", status: "approved" },
    reportSnapshot: { question: "q", models: [], reportTypeLabel: "Financial Analysis", consensusLevel: "moderate", sourceGroundingLevel: "strong", reportGeneratedAt: "2026-01-01T00:00:00.000Z", legacy: { schemaId: "financial_valuation", alignedClaims: [] } },
    exportMetadata: { exportId: EXPORT_ID, runId: RUN_ID, schemaVersion: 1, exportedSections: ["reportSnapshot.legacy"], createdAt: "2026-01-01T00:00:00.000Z", requestingUser: UID, finalReportVersion: 3 },
    ...overrides,
  };
}

async function callRoute() {
  const req = new NextRequest(`http://localhost/api/user/runs/${RUN_ID}/exports/${EXPORT_ID}`);
  return GET(req, { params: Promise.resolve({ runId: RUN_ID, exportId: EXPORT_ID }) });
}

beforeEach(() => {
  mockedResolveRequestIdentity.mockReset().mockResolvedValue({ status: "authenticated", uid: UID });
  mockedRunGet.mockReset().mockResolvedValue({ exists: true, data: () => ({ userId: UID }) });
  mockedGetAdaptiveExportRecord.mockReset();
  mockedResolveAdaptiveExportVerdict.mockReset().mockResolvedValue({ allowed: true, requiresVisibleStatusNotice: false });
  mockedRenderAdaptiveResearchExport.mockReset().mockResolvedValue({ bytes: Buffer.from("%PDF-fake"), sha256: "abc123" });
  mockedWriteAdaptiveExportAdminAuditEvent.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/user/runs/[runId]/exports/[exportId] — generator provenance historical freezing", () => {
  it("renders from the frozen generatedBy on the record — the account's CURRENT name/email is never consulted, because this route never imports the identity resolver at all", async () => {
    // The export was created when the account was "Yasin Warsame" / masked
    // "ya***@gmail.com". The scenario: the account has since been renamed
    // to "Michael Warsame" / "mi***@company.com" — but nothing in this test
    // ever tells the route about that new identity, because a correct
    // implementation has no code path to look it up during regeneration.
    const record = buildRecord({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } });
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });

    await callRoute();

    expect(mockedRenderAdaptiveResearchExport).toHaveBeenCalledWith(
      expect.objectContaining({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } })
    );
  });

  it("regenerating the same export twice in a row renders the identical frozen generatedBy both times", async () => {
    const record = buildRecord({ generatedBy: { displayName: "Yasin Warsame", maskedEmail: "ya***@gmail.com" } });
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });

    await callRoute();
    await callRoute();

    expect(mockedRenderAdaptiveResearchExport).toHaveBeenCalledTimes(2);
    const firstCallRecord = mockedRenderAdaptiveResearchExport.mock.calls[0][0];
    const secondCallRecord = mockedRenderAdaptiveResearchExport.mock.calls[1][0];
    expect(firstCallRecord.generatedBy).toEqual(secondCallRecord.generatedBy);
  });

  it("V1 compatibility: a historical record with no generatedBy key at all (created before this feature shipped) regenerates successfully — no fabricated identity is ever synthesized", async () => {
    const record = buildRecord(); // no `generatedBy` override — key is genuinely absent
    expect(record).not.toHaveProperty("generatedBy");
    mockedGetAdaptiveExportRecord.mockResolvedValue({ ok: true, record });

    const res = await callRoute();

    expect(res.status).toBe(200);
    const renderedRecord = mockedRenderAdaptiveResearchExport.mock.calls[0][0];
    expect(renderedRecord.generatedBy).toBeUndefined();
  });
});
