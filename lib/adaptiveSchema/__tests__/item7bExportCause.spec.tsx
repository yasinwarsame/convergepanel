/**
 * Item 7B — a recorded "output_budget_exhausted" cause reaches every export format through the one shared line builder,
 * and the JSON export schema validates it. Synthetic fixtures only (dsExportFixtures); a pre-7B record is covered by
 * item7aExportDisclosure.spec.tsx and the historical export suites.
 */
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", StyleSheet: { create: (s: unknown) => s }, renderToBuffer: jest.fn() }));

import { asStored, exportCases, exportRecord } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { extractPdfTextNodes } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";
import { adaptiveResearchJsonExportV1Schema } from "@/lib/adaptiveSchema/jsonExportSchema";
import { STRUCTURED_OUTPUT_BUDGET_CAUSE_TEXT } from "@/lib/adaptiveSchema/structuredOutputDisclosure";

const DEGRADED = exportCases().find((x) => x.name === "ds.uncontested_go_with_failed_slots.unreviewed_in_queue")!;

/** The fixture's first failed slot becomes a completed call that the provider reported as stopped at its budget. */
function withBudgetCause(format: "pdf" | "docx" | "json") {
  const rec: any = asStored(exportRecord(DEGRADED, format));
  const metas: any[] = [];
  const walk = (v: any) => {
    if (v && typeof v === "object") {
      if (v.structuredOutput && Array.isArray(v.structuredOutput.slots)) metas.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(rec);
  expect(metas.length).toBeGreaterThan(0);
  for (const meta of metas) {
    const i = meta.structuredOutput.slots.findIndex((s: any) => s.call === "failed");
    expect(i).toBeGreaterThanOrEqual(0);
    meta.structuredOutput.slots[i] = { modelId: meta.structuredOutput.slots[i].modelId, call: "completed", result: "unavailable", cause: "output_budget_exhausted" };
    meta.successfulModels += 1;
  }
  return rec;
}
const BUDGET_LINE = `unavailable: the provider call completed but returned no usable structured output; ${STRUCTURED_OUTPUT_BUDGET_CAUSE_TEXT}.`;

it("PDF shows the cause on that model's line", () => {
  const text = extractPdfTextNodes(AdaptiveResearchDocument({ record: withBudgetCause("pdf") })).join("\n");
  expect(text).toContain("3 of 5 provider calls completed.");
  expect(text.split(BUDGET_LINE).length - 1).toBe(1);
});

it("DOCX shows the cause on that model's line", async () => {
  const text = await extractDocxText((await renderAdaptiveResearchExport(withBudgetCause("docx"))).bytes);
  expect(text.split(BUDGET_LINE).length - 1).toBe(1);
});

it("JSON carries the cause and the export schema validates it", async () => {
  const j = JSON.parse(Buffer.from((await renderAdaptiveResearchExport(withBudgetCause("json"))).bytes).toString("utf8"));
  const d = (adaptiveResearchJsonExportV1Schema.parse(j).result as any).derivedStructuredOutputDisclosure;
  expect(d.affected.map((m: any) => m.cause ?? null)).toEqual(["output_budget_exhausted", "provider_failure", "provider_failure"].sort((a, b) => (a === "output_budget_exhausted" ? -1 : b === "output_budget_exhausted" ? 1 : 0)));
  expect(d.lines.filter((l: string) => l.endsWith(BUDGET_LINE)).length).toBe(1);
  // An unknown cause value fails the export schema.
  const bad = JSON.parse(JSON.stringify(j));
  bad.result.derivedStructuredOutputDisclosure.affected[0].cause = "timeout";
  expect(adaptiveResearchJsonExportV1Schema.safeParse(bad).success).toBe(false);
});
