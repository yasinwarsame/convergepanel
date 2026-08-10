/**
 * Adaptive Research Export, Phase 2 — version-aware regeneration dispatch
 * (`renderAdaptiveResearchExport`). The frozen `AdaptiveResearchExportV1`
 * contract's own `version` field (distinct from `reportVersion` and
 * `schemaVersion` — see researchExport.ts) must route to the matching
 * renderer, and an unrecognized version must fail loudly rather than
 * silently being rendered as if it were V1. This is the mechanism that
 * keeps regenerating a very old historical export safe if a future
 * contract version ever changes PDF semantics.
 */

jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(async () => Buffer.from("%PDF-fake-bytes")),
}));

import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";

function baseRecord(overrides: Partial<AdaptiveResearchExportV1> = {}): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-dispatch-test",
    runId: "run-dispatch-test",
    schemaId: "comparison_matrix",
    schemaFamily: "milestone2",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "uid-1",
    format: "pdf",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
    reportSnapshot: {
      question: "q",
      models: [],
      reportTypeLabel: "Comparison Report",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-01-01T00:00:00.000Z",
      milestone2: { schemaId: "comparison_matrix", result: {}, meta: {} as any, decisionReceipt: undefined },
    },
    exportMetadata: {
      exportId: "exp-dispatch-test",
      runId: "run-dispatch-test",
      schemaVersion: 1,
      exportedSections: ["reportSnapshot.milestone2"],
      createdAt: "2026-01-01T00:00:00.000Z",
      requestingUser: "uid-1",
      finalReportVersion: 1,
    },
    ...overrides,
  };
}

describe("renderAdaptiveResearchExport — version-aware dispatch", () => {
  it("version 1 renders successfully and returns bytes + sha256", async () => {
    const result = await renderAdaptiveResearchExport(baseRecord());
    expect(result.bytes.toString()).toBe("%PDF-fake-bytes");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("an unrecognized contract version fails loudly rather than silently rendering as V1", async () => {
    const record = baseRecord({ version: 2 as unknown as 1 });
    await expect(renderAdaptiveResearchExport(record)).rejects.toThrow(/[Uu]nsupported.*version/);
  });

  it("is a pure function of the record — the same frozen record regenerates byte-identical output across repeated calls", async () => {
    const record = baseRecord();
    const first = await renderAdaptiveResearchExport(record);
    const second = await renderAdaptiveResearchExport(record);
    expect(first.sha256).toBe(second.sha256);
  });
});
