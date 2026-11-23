/**
 * Item 7A — the PDF, DOCX and JSON exports render the same shared structured-output disclosure as the live report.
 * Synthetic fixtures only (dsExportFixtures).
 */
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", StyleSheet: { create: (s: unknown) => s }, renderToBuffer: jest.fn() }));

import { asStored, exportCases, exportRecord } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { extractPdfTextNodes } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";
import { adaptiveResearchJsonExportV1Schema } from "@/lib/adaptiveSchema/jsonExportSchema";
import { STRUCTURED_OUTPUT_SECTION_HEADING } from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import { withoutItem7aRecord } from "@/lib/adaptiveSchema/__tests__/item7aHistoricalCompat";

const byName = (name: string) => {
  const c = exportCases().find((x) => x.name === name);
  if (!c) throw new Error(`fixture missing: ${name}`);
  return c;
};
// 5 selected, 2 usable: the three missing slots errored at the provider (dsExportFixtures dsOutput).
const DEGRADED = byName("ds.uncontested_go_with_failed_slots.unreviewed_in_queue");
const COMPLETE = byName("ds.uncontested_choose_option.unreviewed_in_queue");
const HEADLINE = "5 models selected · 2 usable structured results";
const CALLS = "2 of 5 provider calls completed.";
const UNAVAILABLE = "unavailable — the provider call did not complete.";

describe("PDF (element tree of the composer)", () => {
  it("a degraded run shows the section, headline, call count and each unavailable model", () => {
    const text = extractPdfTextNodes(AdaptiveResearchDocument({ record: asStored(exportRecord(DEGRADED, "pdf")) })).join("\n");
    expect(text).toContain(STRUCTURED_OUTPUT_SECTION_HEADING);
    expect(text).toContain(HEADLINE);
    expect(text).toContain(CALLS);
    expect(text.split(UNAVAILABLE).length - 1).toBe(3);
  });
  it("a complete run has no section", () => {
    const text = extractPdfTextNodes(AdaptiveResearchDocument({ record: asStored(exportRecord(COMPLETE, "pdf")) })).join("\n");
    expect(text).not.toContain(STRUCTURED_OUTPUT_SECTION_HEADING);
  });
});

describe("DOCX (rendered bytes)", () => {
  it("a degraded run shows the same lines", async () => {
    const text = await extractDocxText((await renderAdaptiveResearchExport(asStored(exportRecord(DEGRADED, "docx")))).bytes);
    expect(text).toContain(STRUCTURED_OUTPUT_SECTION_HEADING);
    expect(text).toContain(HEADLINE);
    expect(text).toContain(CALLS);
    expect(text.split(UNAVAILABLE).length - 1).toBe(3);
  });
  it("a complete run has no section", async () => {
    const text = await extractDocxText((await renderAdaptiveResearchExport(asStored(exportRecord(COMPLETE, "docx")))).bytes);
    expect(text).not.toContain(STRUCTURED_OUTPUT_SECTION_HEADING);
  });
});

describe("JSON (rendered bytes, validated by the export schema)", () => {
  const body = async (name: typeof DEGRADED) => JSON.parse(Buffer.from((await renderAdaptiveResearchExport(asStored(exportRecord(name, "json")))).bytes).toString("utf8"));
  it("a degraded run carries the derived disclosure with counts, affected models and the same lines", async () => {
    const j = await body(DEGRADED);
    const d = adaptiveResearchJsonExportV1Schema.parse(j).result as { derivedStructuredOutputDisclosure?: { selected: number; completedCalls: number; usable: number; affected: { state: string; providerCall: string }[]; lines: string[] } };
    expect(d.derivedStructuredOutputDisclosure).toBeDefined();
    const x = d.derivedStructuredOutputDisclosure!;
    expect([x.selected, x.completedCalls, x.usable]).toEqual([5, 2, 2]);
    expect(x.affected.map((m) => [m.state, m.providerCall])).toEqual([["unavailable", "failed"], ["unavailable", "failed"], ["unavailable", "failed"]]);
    expect(x.lines.slice(0, 2)).toEqual([HEADLINE, CALLS]);
    expect(x.lines.slice(2).every((l) => l.endsWith(UNAVAILABLE))).toBe(true);
  });
  it("a complete run has no derived disclosure", async () => {
    const j = await body(COMPLETE);
    expect(j.result).not.toHaveProperty("derivedStructuredOutputDisclosure");
  });
});

describe("a stored export of a run without the per-slot record (every pre-7A export) is unchanged", () => {
  const legacy = (format: "pdf" | "docx" | "json") => {
    const rec = withoutItem7aRecord(asStored(exportRecord(DEGRADED, format)));
    expect(JSON.stringify(rec)).not.toContain("structuredOutput");
    return rec;
  };
  it("PDF: no section, even though the counts show a shortfall", () => {
    expect(extractPdfTextNodes(AdaptiveResearchDocument({ record: legacy("pdf") })).join("\n")).not.toContain(STRUCTURED_OUTPUT_SECTION_HEADING);
  });
  it("DOCX: no section", async () => {
    expect(await extractDocxText((await renderAdaptiveResearchExport(legacy("docx"))).bytes)).not.toContain(STRUCTURED_OUTPUT_SECTION_HEADING);
  });
  it("JSON: no derived disclosure", async () => {
    const j = JSON.parse(Buffer.from((await renderAdaptiveResearchExport(legacy("json"))).bytes).toString("utf8"));
    expect(j.result).not.toHaveProperty("derivedStructuredOutputDisclosure");
  });
});
