/**
 * Order 6 / S-E.2 (H1-A): Decision Support wording in the REAL generated DOCX, read through the structured reader
 * (docxText.ts: mammoth over the package; no regular expressions over XML), one entry per paragraph.
 *
 *  - version-1 records get the corrected status block, D-9 directly after it, the :488 conclusion only in its own
 *    state, and nothing else changed; historical and invalid markers keep the historical text;
 *  - R1 MINOR-1: the S-E.1 scanner families run over every paragraph of every version-1 DOCX (model text
 *    sentinel-wrapped), and a deterministic regression injects an unsupported claim ("All models agreed …", split
 *    across differently formatted runs) into a real version-1 DOCX: the scanner must catch it, and the unmodified
 *    document must pass.
 * Normalized-part equality against unchanged main is in dsExportRendered.spec.ts.
 */
jest.mock("firebase-admin/firestore", () => ({ FieldValue: class FieldValue {}, Timestamp: class Timestamp {} }));

import JSZip from "jszip";
import { asStored, exportCases, exportRecord } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { historicalOf } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportHistory";
import { D9, LABEL_AGREEMENT, LABEL_SOURCES, OLD_CAPTION, ORACLE, PROVENANCE_MARKERS, SHOWN_488, STORED_488, stateOf } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportOracle";
import { DocxTextError, docxParagraphs } from "@/lib/adaptiveSchema/__tests__/dsExport/docxText";
import { S, SENTINEL_SPAN } from "@/components/adaptive/__tests__/seSurfaces/seSurfaceHarness";
import { EXEMPTIONS, FIELD_LABELS, scanSurface, validateExemptions } from "@/components/adaptive/__tests__/seSurfaces/dsWordingScanner";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { governanceStatusDisplay } from "@/lib/adaptiveSchema/exportContentDerivation";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";

const bytesOf = async (r: AdaptiveResearchExportV1) => (await renderAdaptiveResearchDocxV1(r)).bytes;
const lines = async (r: AdaptiveResearchExportV1) => docxParagraphs(await bytesOf(r));
const dsCases = exportCases().filter((c) => c.schemaId === "decision_support");
const marked = (name: string) => asStored(exportRecord(dsCases.find((c) => c.name === name)!, "docx"));

function statusRegion(l: string[]): [number, number] {
  const start = l.indexOf("Report status summary");
  const end = l.findIndex((t, i) => i > start && (t === "Conclusion" || t === "Primary synthesis"));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return [start, end];
}

/** Export-only pinned exemptions (the product name in the header and closing note; F2 matches "converg…"). */
const EXPORT_EXEMPTIONS = [...EXEMPTIONS, "ConvergePanel — Adaptive Research Export", "Generated with ConvergePanel. This document reflects"];
const BRAND = /^ConvergePanel(?=\s{2,}|$)/;
/**
 * DOCX field labels are written upper-case ("MODEL AGREEMENT"). Bounded label recognition (R1 MINOR-1, R11): a
 * paragraph that is a pinned field label in any letter case is that label; a paragraph that STARTS with one followed by
 * ":" is that label plus the text after the colon, and that text is scanned like any other node. Nothing else is
 * treated as a label: a label word elsewhere in a paragraph exempts nothing.
 */
const escapeRe = (l: string) => l.replace(/[.*+?^$|()[\]{}\\]/g, "\\$&");
const LABEL_LEAD = new RegExp("^(" + FIELD_LABELS.map(escapeRe).join("|") + ")(?:\\s*:\\s*([\\s\\S]*))?$", "i");
function docxScanNodes(paragraphs: string[]): string[][] {
  return paragraphs.map((t) => {
    const m = LABEL_LEAD.exec(t);
    if (!m) return [t.replace(BRAND, "")];
    const label = FIELD_LABELS.find((l) => l.toLowerCase() === m[1].toLowerCase())!;
    return m[2] === undefined ? [label] : [label, m[2]];
  });
}
function scanDocx(name: string, paragraphs: string[], record: AdaptiveResearchExportV1) {
  const receipt = record.reportSnapshot.milestone2?.decisionReceipt;
  const result = record.reportSnapshot.milestone2?.result as { recommendation: { rationale: string } };
  // The header paragraph is the brand followed by the status badge; only the brand word is dropped.
  const nodes = docxScanNodes(paragraphs);
  const textNodes = nodes.flat();
  const fields = paragraphs.flatMap((t, i) => nodes[i].map(() => (receipt && t === receipt.conclusion ? "receipt.conclusion" : null)));
  return scanSurface({ id: name, textNodes, attributes: [], fields }, { exemptions: EXPORT_EXEMPTIONS, storedRationales: [result.recommendation.rationale] });
}

describe("version-1 Decision Support DOCX", () => {
  it.each(dsCases.map((c) => [c.name]))("%s: corrected status block, D-9, conclusion, nothing else changed", async (name) => {
    const record = marked(name);
    const o = ORACLE[stateOf(name)];
    const l = await lines(record);
    const [start, end] = statusRegion(l);
    const region = l.slice(start, end);
    expect(region[region.indexOf(LABEL_AGREEMENT.toUpperCase()) + 1]).toBe(o.agreement);
    expect(region[region.indexOf(LABEL_SOURCES.toUpperCase()) + 1]).toBe(o.sources);
    for (const old of ["CONSENSUS", "SOURCE GROUNDING", OLD_CAPTION]) expect(l).not.toContain(old);
    expect(l.filter((t) => t === D9).length).toBe(o.d9 ? 1 : 0);
    if (o.d9) expect(l[end - 1]).toBe(D9);
    expect(l.join("\n")).toContain(governanceStatusDisplay(record).label);
    const receipt = record.reportSnapshot.milestone2?.decisionReceipt;
    if (receipt) {
      const shown = l[end + 1];
      if (o.conclusion488 === "presented") expect(shown).toBe(`Conditional go — ${SHOWN_488}`);
      else if (o.conclusion488 === "stored") expect(shown).toBe(`Conditional go — ${STORED_488}`);
      else expect(shown).toBe(receipt.conclusion);
    }
    const old = await lines(historicalOf(`${name}.docx`));
    const [s0, e0] = statusRegion(old);
    expect(l.slice(0, start)).toEqual(old.slice(0, s0));
    const after = l.slice(end);
    const after0 = old.slice(e0);
    expect(after.length).toBe(after0.length);
    after.forEach((t, i) => {
      if (!(i === 1 && after0[0] === "Conclusion")) expect(t).toBe(after0[i]);
    });
    for (const m of PROVENANCE_MARKERS) expect(l.join("\n")).not.toContain(m);
  });

  it("the historical status block carries the wording version 1 replaces", async () => {
    const old = await lines(historicalOf("ds.uncontested_choose_option.unreviewed_in_queue.docx"));
    const [s, e] = statusRegion(old);
    expect(old.slice(s, e)).toEqual(expect.arrayContaining(["CONSENSUS", "SOURCE GROUNDING", OLD_CAPTION]));
  });
});

describe("R1 MINOR-1: the wording scanner on real version-1 DOCX text", () => {
  const wrapped = exportCases(S).filter((c) => c.schemaId === "decision_support");

  it("the export exemptions are narrow (S-E.1 rules)", () => {
    expect(validateExemptions(EXPORT_EXEMPTIONS)).toEqual([]);
  });

  it.each(wrapped.map((c) => [c.name]))("%s: no F1–F8 hit in any paragraph", async (name) => {
    const record = asStored(exportRecord(wrapped.find((c) => c.name === name)!, "docx"));
    const paragraphs = await lines(record);
    expect(scanDocx(name, paragraphs, record)).toEqual([]);
    // Not blind: the corrected labels and, where the receipt carries model text, the model text itself are read.
    expect(paragraphs).toContain(LABEL_AGREEMENT.toUpperCase());
    const modelTextInReceipt = JSON.stringify(record.reportSnapshot.milestone2?.decisionReceipt ?? {}).includes("⟦");
    expect((paragraphs.join(" ").match(SENTINEL_SPAN)?.length ?? 0) > 0).toBe(modelTextInReceipt);
  });

  it("the scanner is not blind to the historical DOCX wording", async () => {
    const record = historicalOf("ds.uncontested_choose_option.unreviewed_in_queue.docx");
    const hits = scanDocx("historical", await lines(record), record);
    expect(hits.map((h) => h.family)).toEqual(expect.arrayContaining(["F1-consensus-tier"]));
  });

  /** Inserts a paragraph whose text is split across two runs with different formatting, after the D-9 paragraph. */
  async function withInjectedClaim(bytes: Buffer, first: string, second: string): Promise<Buffer> {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    const anchor = "agreement on an option is not established.</w:t></w:r></w:p>";
    expect(xml.split(anchor).length - 1).toBe(1);
    const injected = `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${first}</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${second}</w:t></w:r></w:p>`;
    zip.file("word/document.xml", xml.replace(anchor, anchor + injected));
    return zip.generateAsync({ type: "nodebuffer" });
  }

  it("M5 regression: an unsupported claim injected into a real version-1 DOCX is caught; the unmodified DOCX passes", async () => {
    const name = "ds.uncontested_choose_option.unreviewed_in_queue";
    const record = asStored(exportRecord(wrapped.find((c) => c.name === name)!, "docx"));
    const bytes = await bytesOf(record);
    expect(scanDocx(name, await docxParagraphs(bytes), record)).toEqual([]);
    const mutated = await docxParagraphs(await withInjectedClaim(bytes, "All models ", "agreed on this option."));
    expect(mutated).toContain("All models agreed on this option.");
    expect(scanDocx(name, mutated, record).map((h) => h.family)).toContain("F2-convergence");
  });

  /**
   * Appends runs to the real version-1 "MODEL AGREEMENT" label paragraph (its own run and formatting untouched), so the
   * paragraph reads "MODEL AGREEMENT: <claim>" with the label and the claim in separately formatted runs.
   */
  async function withClaimAfterLabel(bytes: Buffer, runs: string[]): Promise<Buffer> {
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    const label = `>${LABEL_AGREEMENT.toUpperCase()}</w:t></w:r>`;
    expect(xml.split(label).length - 1).toBe(1);
    const fmt = ["<w:i/>", "", "<w:u w:val=\"single\"/>"];
    const added = [": ", ...runs].map((t, i) => `<w:r><w:rPr>${fmt[i % fmt.length]}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`).join("");
    zip.file("word/document.xml", xml.replace(label, label + added));
    return zip.generateAsync({ type: "nodebuffer" });
  }

  it("R11 falsification: an unsupported claim after the upper-case label, across formatted runs, is caught; the label alone is not", async () => {
    const name = "ds.uncontested_choose_option.unreviewed_in_queue";
    const record = asStored(exportRecord(wrapped.find((c) => c.name === name)!, "docx"));
    const bytes = await bytesOf(record);
    // Baseline: the unmodified version-1 document passes and its label paragraph is the bare upper-case label.
    const clean = await docxParagraphs(bytes);
    expect(clean).toContain("MODEL AGREEMENT");
    expect(scanDocx(name, clean, record)).toEqual([]);
    // Mutated: application-authored claim after the label, split over three differently formatted runs.
    const mutated = await docxParagraphs(await withClaimAfterLabel(bytes, ["all ", "models ", "agreed"]));
    expect(mutated).toContain("MODEL AGREEMENT: all models agreed");
    expect(mutated).not.toContain("MODEL AGREEMENT");
    const hits = scanDocx(name, mutated, record);
    expect(hits.filter((h) => h.family === "F2-convergence").map((h) => h.text)).toContain("all models agreed");
    // The hit is the claim, not the label word: the same paragraph with an approved value is clean.
    const approved = await docxParagraphs(await withClaimAfterLabel(bytes, ["Not ", "scored"]));
    expect(approved).toContain("MODEL AGREEMENT: Not scored");
    expect(scanDocx(name, approved, record)).toEqual([]);
    // Model-authored text (sentinel-wrapped) after the label stays distinct from application wording.
    const quoted = await docxParagraphs(await withClaimAfterLabel(bytes, [S("all models agreed")]));
    expect(quoted).toContain(`MODEL AGREEMENT: ${S("all models agreed")}`);
    expect(scanDocx(name, quoted, record)).toEqual([]);
  });

  it("label recognition is bounded: exact label in any case, or label then colon; a label word elsewhere exempts nothing", () => {
    expect(docxScanNodes(["MODEL AGREEMENT", "Model agreement", "model AGREEMENT"])).toEqual([["Model agreement"], ["Model agreement"], ["Model agreement"]]);
    expect(docxScanNodes(["MODEL AGREEMENT: all models agreed", "Model agreement:all models agreed"])).toEqual([
      ["Model agreement", "all models agreed"],
      ["Model agreement", "all models agreed"],
    ]);
    for (const t of ["ALL MODELS AGREED. MODEL AGREEMENT", "MODEL AGREEMENT all models agreed", "THE MODEL AGREEMENT: unanimous", "MODEL: all models agreed", "SOURCES: verified"]) {
      expect(docxScanNodes([t])).toEqual([[t]]);
    }
    const record = asStored(exportRecord(wrapped.find((c) => c.name === "ds.uncontested_choose_option.unreviewed_in_queue")!, "docx"));
    for (const t of ["MODEL AGREEMENT: all models agreed", "Model agreement: unanimous", "ALL MODELS AGREED. MODEL AGREEMENT", "MODEL AGREEMENT all models agreed"]) {
      expect(scanDocx("bounded", [t], record).map((h) => h.family)).toContain("F2-convergence");
    }
  });
});

describe("structured reader input handling", () => {
  it("rejects empty, non-zip, document-less, DOCTYPE-bearing and ENTITY-bearing packages", async () => {
    await expect(docxParagraphs(Buffer.alloc(0))).rejects.toBeInstanceOf(DocxTextError);
    await expect(docxParagraphs(Buffer.from("not a zip"))).rejects.toBeInstanceOf(DocxTextError);
    const empty = new JSZip();
    empty.file("other.xml", "<a/>");
    await expect(docxParagraphs(await empty.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/document.xml missing/);
    const real = await bytesOf(marked("ds.uncontested_choose_option.unreviewed_in_queue"));
    for (const decl of ['<!DOCTYPE w [<!ENTITY x "y">]>', '<!ENTITY x SYSTEM "file:///etc/passwd">']) {
      const zip = await JSZip.loadAsync(real);
      const xml = await zip.file("word/document.xml")!.async("string");
      zip.file("word/document.xml", xml.replace("?>", `?>${decl}`));
      await expect(docxParagraphs(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/DOCTYPE or ENTITY/);
    }
  });

  it("extraction is deterministic", async () => {
    const bytes = await bytesOf(marked("ds.unresolved_option_488.unreviewed_in_queue"));
    expect(await docxParagraphs(bytes)).toEqual(await docxParagraphs(bytes));
  });
});

describe("historical and invalid markers render the historical DOCX text", () => {
  const variants: [string, unknown][] = [
    ["absent", undefined],
    ["presentation null", null],
    ['marker "1"', { dsLabelWordingVersion: "1" }],
    ["marker 2", { dsLabelWordingVersion: 2 }],
    ["marker true", { dsLabelWordingVersion: true }],
    ["presentation array", [1]],
  ];
  it.each(variants)("%s", async (label, presentation) => {
    for (const key of ["ds.uncontested_choose_option.unreviewed_in_queue.docx", "ds.unresolved_option_488.unreviewed_in_queue.docx"]) {
      const historical = historicalOf(key);
      const record = label === "absent" ? historical : ({ ...historical, reportSnapshot: { ...historical.reportSnapshot, presentation } } as AdaptiveResearchExportV1);
      const l = await lines(record);
      expect(l).toEqual(await lines(historical));
      expect(l).toContain("CONSENSUS");
      expect(l).not.toContain(D9);
    }
  });

  it("a version-1 marker on a non-DS record changes nothing; new non-DS records match their baseline text", async () => {
    for (const key of ["nonds.comparison_matrix.unreviewed_in_queue.docx", "nonds.financial_valuation.approved.docx"]) {
      const historical = historicalOf(key);
      const forged = { ...historical, reportSnapshot: { ...historical.reportSnapshot, presentation: { dsLabelWordingVersion: 1 } } } as AdaptiveResearchExportV1;
      expect(await lines(forged)).toEqual(await lines(historical));
    }
    for (const c of exportCases().filter((x) => x.schemaId !== "decision_support")) {
      expect(await lines(asStored(exportRecord(c, "docx")))).toEqual(await lines(historicalOf(`${c.name}.docx`)));
    }
  });
});
