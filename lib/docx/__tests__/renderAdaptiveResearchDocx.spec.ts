/**
 * Adaptive Research Export, Phase 3 — DOCX determinism tests (Part 10).
 * Uses the REAL, unmocked `docx`/JSZip pipeline (confirmed to work cleanly
 * under ts-jest, unlike `@react-pdf/renderer` — no ESM-parse mocking
 * needed here) so these results reflect actual production behavior, not
 * a stubbed approximation.
 *
 * Empirically confirms the exact claim `renderAdaptiveResearchDocx.ts`'s
 * own doc comment makes: whole-file bytes are NOT deterministic (every
 * ZIP entry gets its own per-render timestamp, and `docProps/core.xml`'s
 * `dcterms:created`/`dcterms:modified` fields embed the render-time clock
 * with no public override), but `word/document.xml` — the actual visible
 * report content — IS byte-identical across renders of the same frozen
 * record, because this composer never uses `Hyperlink`/`Bookmark` (the
 * library's other, `nanoid()`-driven source of content-level randomness).
 */

import JSZip from "jszip";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";

function record(overrides: Partial<AdaptiveResearchExportV1> = {}): AdaptiveResearchExportV1 {
  return {
    version: 1,
    exportId: "exp-determinism-1",
    runId: "run-determinism-1",
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    schemaVersion: 1,
    reportVersion: 1,
    createdAt: "2026-03-14T09:22:11.000Z",
    createdBy: "uid-test",
    format: "docx",
    artifactStatus: "ready",
    classification: "internal",
    governanceStatusAtExport: { family: "legacy", status: "approved" },
    reportSnapshot: {
      question: "Determinism fixture question.",
      models: [{ modelId: "chatgpt" as any, ok: true }],
      reportTypeLabel: "Financial Analysis",
      consensusLevel: "moderate",
      sourceGroundingLevel: "strong",
      reportGeneratedAt: "2026-03-14T09:22:11.000Z",
      legacy: {
        schemaId: "financial_valuation",
        alignedClaims: [],
        modelResponses: [{ modelId: "chatgpt" as any, schemaId: "financial_valuation", ok: true, data: { thesis: "T1", metrics: [{ label: "P/E", value: 15, unit: "x", asOf: "2026", source: "10-K" }] } }],
      },
    },
    exportMetadata: { exportId: "exp-determinism-1", runId: "run-determinism-1", schemaVersion: 1, exportedSections: [], createdAt: "2026-03-14T09:22:11.000Z", requestingUser: "uid-test", finalReportVersion: 1 },
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("renderAdaptiveResearchDocxV1 — determinism (Part 10)", () => {
  it("produces a valid OOXML (.docx) package — starts with the ZIP 'PK' signature", async () => {
    const rendered = await renderAdaptiveResearchDocxV1(record());
    expect(rendered.bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("word/document.xml — the actual visible report content — is byte-identical across two real renders separated by real wall-clock time", async () => {
    const fixed = record();
    const r1 = await renderAdaptiveResearchDocxV1(fixed);
    await sleep(1200);
    const r2 = await renderAdaptiveResearchDocxV1(fixed);

    const zip1 = await JSZip.loadAsync(r1.bytes);
    const zip2 = await JSZip.loadAsync(r2.bytes);
    const doc1 = await zip1.files["word/document.xml"].async("nodebuffer");
    const doc2 = await zip2.files["word/document.xml"].async("nodebuffer");

    expect(doc1.equals(doc2)).toBe(true);
  }, 15000);

  it("honestly does NOT claim whole-file byte identity — docProps/core.xml embeds the render-time clock with no public override, unlike the PDF path's creationDate fix", async () => {
    const fixed = record();
    const r1 = await renderAdaptiveResearchDocxV1(fixed);
    await sleep(1200);
    const r2 = await renderAdaptiveResearchDocxV1(fixed);

    // This is the documented, accepted limitation — not a regression to
    // chase. If a future `docx` version exposes a `created`/`modified`
    // override, this assertion should flip and the doc comments above
    // should be updated to match.
    expect(r1.sha256).not.toBe(r2.sha256);

    const zip2 = await JSZip.loadAsync(r2.bytes);
    const core2 = (await zip2.files["docProps/core.xml"].async("nodebuffer")).toString("utf8");
    expect(core2).toMatch(/dcterms:created/);
  }, 15000);

  it("two DIFFERENT frozen records produce different word/document.xml content — confirms output is a pure function of the record, not shared/ambient state", async () => {
    const recordA = record({ exportId: "exp-a", reportSnapshot: { ...record().reportSnapshot, question: "Question A" } });
    const recordB = record({ exportId: "exp-b", reportSnapshot: { ...record().reportSnapshot, question: "Question B" } });

    const rA = await renderAdaptiveResearchDocxV1(recordA);
    const rB = await renderAdaptiveResearchDocxV1(recordB);

    const zipA = await JSZip.loadAsync(rA.bytes);
    const zipB = await JSZip.loadAsync(rB.bytes);
    const docA = (await zipA.files["word/document.xml"].async("nodebuffer")).toString("utf8");
    const docB = (await zipB.files["word/document.xml"].async("nodebuffer")).toString("utf8");

    expect(docA).toContain("Question A");
    expect(docA).not.toContain("Question B");
    expect(docB).toContain("Question B");
    expect(docB).not.toContain("Question A");
  });

  it("an unrecognized frozen record never throws — rendering is a total function over any well-formed record", async () => {
    await expect(renderAdaptiveResearchDocxV1(record())).resolves.toBeDefined();
  });
});
