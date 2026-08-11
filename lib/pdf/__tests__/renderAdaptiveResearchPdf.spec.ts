/**
 * Adaptive Research Export — version-AND-format-aware regeneration
 * dispatch (`renderAdaptiveResearchExport`). The frozen
 * `AdaptiveResearchExportV1` contract's own `version` field (distinct
 * from `reportVersion` and `schemaVersion` — see researchExport.ts) must
 * route to the matching renderer, and an unrecognized version must fail
 * loudly rather than silently being rendered as if it were V1. Within a
 * supported version, `format` (Phase 3: "pdf" | "docx"; Phase 4 adds
 * "json") selects the renderer the same way — an unrecognized format must
 * never silently fall back to any real format. This is the mechanism that
 * keeps regenerating a very old historical export safe if a future
 * contract version or format value ever changes semantics.
 *
 * Only `@react-pdf/renderer` is mocked here (ESM-only, needs mocking
 * under ts-jest — see this file's own established pattern); `docx` and
 * `json` are NOT mocked — both work cleanly under Jest without the
 * ESM-parse issue, so their dispatch tests below exercise the real
 * renderers.
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

  it("format: \"docx\" dispatches to the real DOCX renderer, not PDF — produces a valid ZIP/OOXML package", async () => {
    const record = baseRecord({ format: "docx" });
    const result = await renderAdaptiveResearchExport(record);
    expect(result.bytes.subarray(0, 2).toString()).toBe("PK");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("format: \"json\" dispatches to the real JSON serializer, not PDF/DOCX — produces valid, parseable JSON", async () => {
    const record = baseRecord({ format: "json" });
    const result = await renderAdaptiveResearchExport(record);
    expect(result.bytes.subarray(0, 1).toString()).toBe("{");
    expect(() => JSON.parse(result.bytes.toString("utf-8"))).not.toThrow();
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("an unrecognized format on an otherwise-valid V1 record fails loudly — never silently falls back to PDF/DOCX/JSON (a malformed/forged stored record, bypassing TypeScript, is the realistic threat model here)", async () => {
    const record = baseRecord({ format: "csv" as unknown as "pdf" });
    await expect(renderAdaptiveResearchExport(record)).rejects.toThrow(/[Uu]nsupported.*format/);
  });
});
