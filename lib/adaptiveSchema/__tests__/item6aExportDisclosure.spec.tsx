/**
 * Item 6A correction round (R1 F1/F2/F5/F6) — rendered-output assertions for every surface that shows a STORED
 * (frozen) Decision Receipt: regenerated PDF / DOCX / JSON exports through the same dispatcher the re-download routes
 * call (renderAdaptiveResearchExport), and the personal / Team review Receipt cards. The stored record is never
 * modified; the PDF/DOCX notice appears only when a stored basis line carries the retired "(user-provided)" suffix; the
 * JSON keeps every historical value verbatim and adds a clearly derived disclosure only for affected records.
 */
// Same @react-pdf/renderer stub the other export specs use: the PDF is asserted on the frozen composer's element tree
// (real byte rendering is covered by renderedLayout.spec.ts and dsExportRendered.spec.ts, unchanged for these records).
jest.mock("@react-pdf/renderer", () => ({ Document: "DOCUMENT", Page: "PAGE", View: "VIEW", Text: "TEXT", StyleSheet: { create: (s: unknown) => s }, renderToBuffer: jest.fn() }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { asStored, exportCases, exportRecord } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
import { extractPdfTextNodes } from "@/lib/pdf/__tests__/testUtils";
import { extractDocxText } from "@/lib/docx/__tests__/testUtils";
import { adaptiveResearchJsonExportV1Schema } from "@/lib/adaptiveSchema/jsonExportSchema";
import { DERIVED_DISCLOSURE_NOTE, LEGACY_FROZEN_RECEIPT_NOTICE, LEGACY_INFERRED_CRITERIA_LIMITATION, receiptCriterionLine, UNESTABLISHED_CRITERIA_LIMITATION } from "@/lib/adaptiveSchema/criterionProvenance";
import { PersonalReviewReceiptSection } from "@/components/personalReview/PersonalReviewDetail";
import { TeamReviewReceiptSection } from "@/components/teamGovernance/AdaptiveReviewDetail";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";

type Rec = AdaptiveResearchExportV1;
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** A real Decision Support export case that has a Receipt and at least one criterion. */
function baseCase() {
  const c = exportCases().find((x) => {
    const r = exportRecord(x, "json") as any;
    const m2 = r.reportSnapshot.milestone2;
    return m2 && m2.schemaId === "decision_support" && m2.decisionReceipt && (m2.result.criteria ?? []).length > 0;
  });
  if (!c) throw new Error("fixture: no decision_support export case with a receipt and criteria");
  return c;
}
const CASE = baseCase();
const stored = (format: "pdf" | "docx" | "json"): Rec => asStored(exportRecord(CASE, format));

/** The same stored record as written before Item 6A: no marker, the first criterion self-reported "user", and the frozen Receipt line in the retired format. */
function preSixA(format: "pdf" | "docx" | "json"): { rec: Rec; label: string; line: string } {
  const rec: any = stored(format);
  const m2 = rec.reportSnapshot.milestone2;
  delete m2.result.criteriaProvenance;
  m2.result.criteria[0].source = "user";
  const label: string = m2.result.criteria[0].label;
  const i = m2.decisionReceipt.basis.findIndex((l: string) => l === receiptCriterionLine(label, "model"));
  expect(i).toBeGreaterThanOrEqual(0);
  const line = `Criterion: ${label} (user-provided)`;
  m2.decisionReceipt.basis[i] = line;
  return { rec, label, line };
}

describe("regenerated PDF (element tree of the frozen composer)", () => {
  it("a stored pre-6A Receipt shows the read-only notice and its recorded line verbatim", () => {
    const { rec, line } = preSixA("pdf");
    const before = JSON.stringify(rec);
    const text = extractPdfTextNodes(AdaptiveResearchDocument({ record: rec }));
    expect(text).toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
    expect(text.join("\n")).toContain(line);
    expect(JSON.stringify(rec)).toBe(before);
  });
  it("a current record renders without the notice and with exactly the same text as before the correction", () => {
    const text = extractPdfTextNodes(AdaptiveResearchDocument({ record: stored("pdf") }));
    expect(text).not.toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
    expect(text.join("\n")).not.toContain("(user-provided)");
  });
});

describe("regenerated DOCX (re-download dispatcher)", () => {
  it("notice only for the stored pre-6A Receipt; recorded line verbatim", async () => {
    const legacy = preSixA("docx");
    const legacyText = await extractDocxText((await renderAdaptiveResearchExport(legacy.rec)).bytes);
    expect(legacyText).toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
    expect(legacyText).toContain(legacy.line);
    const currentText = await extractDocxText((await renderAdaptiveResearchExport(stored("docx"))).bytes);
    expect(currentText).not.toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
  });
});

describe("regenerated JSON (re-download dispatcher)", () => {
  const body = async (rec: Rec) => JSON.parse(Buffer.from((await renderAdaptiveResearchExport(rec)).bytes).toString("utf8"));

  it("keeps every historical value verbatim and adds a clearly derived disclosure", async () => {
    const legacy = preSixA("json");
    const storedM2 = clone((legacy.rec as any).reportSnapshot.milestone2);
    const j = await body(legacy.rec);
    expect(j.result.result).toEqual(storedM2.result); // raw historical result, incl. source "user" and no marker
    expect(j.result.result.criteria[0].source).toBe("user");
    expect(j.result.decisionReceipt).toEqual(storedM2.decisionReceipt); // frozen Receipt verbatim
    const d = j.result.derivedCriteriaProvenanceDisclosure;
    expect(d).toMatchObject({ derivedAtExport: true, derivedRule: "request_text_v1", note: DERIVED_DISCLOSURE_NOTE, resultProvenanceMarker: null, storedReceiptHasLegacyUserProvidedLabels: true });
    expect(d.criteria[0]).toEqual({ id: storedM2.result.criteria[0].id, label: legacy.label, recordedSource: "user", derivedProvenance: "unverified_legacy" });
    expect(d.criteria.slice(1).every((c: any) => c.recordedSource === "model" && c.derivedProvenance === "model")).toBe(true);
    // The published schema accepts and keeps the field (additive, optional).
    expect(adaptiveResearchJsonExportV1Schema.parse(j).result).toHaveProperty("derivedCriteriaProvenanceDisclosure");
  });

  it("a current export carries no derived disclosure and is otherwise identical to the pre-correction shape", async () => {
    const j = await body(stored("json"));
    expect(j.result).not.toHaveProperty("derivedCriteriaProvenanceDisclosure");
    expect(Object.keys(j.result).sort()).toEqual(["decisionReceipt", "result", "schemaFamily", "schemaId"]);
    expect(adaptiveResearchJsonExportV1Schema.parse(j)).toBeTruthy();
  });

  it("a legacy RESULT exported after 6A (rebuilt Receipt, no retired suffix) still gets the derived disclosure; its PDF gets no frozen-Receipt notice", async () => {
    const rec: any = stored("json");
    delete rec.reportSnapshot.milestone2.result.criteriaProvenance;
    rec.reportSnapshot.milestone2.result.criteria[0].source = "user";
    const j = await body(rec);
    expect(j.result.derivedCriteriaProvenanceDisclosure).toMatchObject({ resultProvenanceMarker: null, storedReceiptHasLegacyUserProvidedLabels: false });
    expect(j.result.derivedCriteriaProvenanceDisclosure.criteria[0].derivedProvenance).toBe("unverified_legacy");
    const pdf = extractPdfTextNodes(AdaptiveResearchDocument({ record: { ...rec, format: "pdf" } }));
    expect(pdf).not.toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
  });
});

describe("N2 — export notice and JSON flag are gated on trusted structure, never on text alone", () => {
  /** A CURRENT (marked) record whose model-written text imitates the retired line format. */
  function markedWithImitation(format: "pdf" | "docx" | "json"): Rec {
    const rec: any = stored(format);
    const m2 = rec.reportSnapshot.milestone2;
    expect(m2.result.criteriaProvenance).toBe("request_text_v1");
    m2.decisionReceipt.basis = [...m2.decisionReceipt.basis, "Criterion: Imitation (user-provided)"];
    return rec;
  }
  it("PDF and DOCX: a marked result never shows the frozen notice", async () => {
    expect(extractPdfTextNodes(AdaptiveResearchDocument({ record: markedWithImitation("pdf") }))).not.toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
    expect(await extractDocxText((await renderAdaptiveResearchExport(markedWithImitation("docx"))).bytes)).not.toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
  });
  it("JSON: a marked result gets no derived disclosure", async () => {
    const j = JSON.parse(Buffer.from((await renderAdaptiveResearchExport(markedWithImitation("json"))).bytes).toString("utf8"));
    expect(j.result).not.toHaveProperty("derivedCriteriaProvenanceDisclosure");
  });
  it("a non-Decision-Support record is never treated as legacy DS provenance", async () => {
    const rec: any = preSixA("pdf").rec;
    rec.reportSnapshot.milestone2.schemaId = "definition_explanation";
    expect(extractPdfTextNodes(AdaptiveResearchDocument({ record: rec }))).not.toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
  });
});

describe("fail-closed fallback (owner decision 2026-11-23): exports of new results make no positive attribution", () => {
  const POSITIVE = /your criterion|stated in request|\(user-provided\)/i;
  /** A current (marked) stored record; optionally with a forged stored "user" source on every criterion. */
  function current(format: "pdf" | "docx" | "json", forge: boolean): Rec {
    const rec: any = stored(format);
    const m2 = rec.reportSnapshot.milestone2;
    expect(m2.result.criteriaProvenance).toBe("request_text_v1");
    if (forge) m2.result.criteria = m2.result.criteria.map((c: any) => ({ ...c, source: "user" }));
    return rec;
  }
  it.each([false, true])("PDF, DOCX and JSON carry no positive attribution and the neutral limitation (forged stored 'user': %s)", async (forge) => {
    const pdf = extractPdfTextNodes(AdaptiveResearchDocument({ record: current("pdf", forge) })).join("\n");
    const docx = await extractDocxText((await renderAdaptiveResearchExport(current("docx", forge))).bytes);
    const json = JSON.parse(Buffer.from((await renderAdaptiveResearchExport(current("json", forge))).bytes).toString("utf8"));
    for (const text of [pdf, docx]) {
      expect(text).not.toMatch(POSITIVE);
      expect(text).toContain(UNESTABLISHED_CRITERIA_LIMITATION);
      expect(text).not.toContain(LEGACY_INFERRED_CRITERIA_LIMITATION);
      expect(text).not.toContain(LEGACY_FROZEN_RECEIPT_NOTICE);
    }
    expect(JSON.stringify(json.result.decisionReceipt)).not.toMatch(POSITIVE);
    expect(json.result).not.toHaveProperty("derivedCriteriaProvenanceDisclosure");
  });
});

describe("review Receipt cards (personal and Team review pages) — rendered markup", () => {
  const receipt = (basis: string[]) => ({ conclusion: "Choose option: HubSpot — fits.", basis, assumptions: [], uncertainties: [], limitations: [], sourceBacked: false, humanReviewNeeded: false });
  const LEGACY = ["Criterion: Total cost (user-provided)", "Criterion: Vendor lock-in"];
  const CURRENT = ['Criterion (stated in request): "Total cost"', 'Criterion: "Vendor lock-in"', 'Criterion: "Budget (user-provided)"'];
  it.each([
    ["personal", PersonalReviewReceiptSection],
    ["team", TeamReviewReceiptSection],
  ] as const)("%s: notice with a frozen pre-6A Receipt, none with a current one; lines shown as recorded", (_name, Section) => {
    const legacy = renderToStaticMarkup(createElement(Section as any, { schemaId: "decision_support", receipt: receipt(LEGACY) }));
    expect(legacy).toContain('data-testid="receipt-legacy-provenance-notice"');
    expect(legacy).toContain("Criterion: Total cost (user-provided)");
    const current = renderToStaticMarkup(createElement(Section as any, { schemaId: "decision_support", receipt: receipt(CURRENT) }));
    expect(current).not.toContain("receipt-legacy-provenance-notice");
    expect(current).toContain("Criterion (stated in request): &quot;Total cost&quot;");
    // N2: the same frozen lines under another (trusted) schema never trigger the notice.
    const otherSchema = renderToStaticMarkup(createElement(Section as any, { schemaId: "definition_explanation", receipt: receipt(LEGACY) }));
    expect(otherSchema).not.toContain("receipt-legacy-provenance-notice");
  });
});
