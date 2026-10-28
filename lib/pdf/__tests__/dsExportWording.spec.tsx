/**
 * Order 6 / S-E.2 (H1-A): Decision Support wording in the PDF composer, on the composed element tree (the same
 * structural extraction every PDF composer test here uses; real bytes are compared in dsExportRendered.spec.ts).
 *
 *  - version-1 records (built now, marker 1): K-6 field names, E-1/E-2 values per the literal oracle, no Part 8 caption
 *    (O-2), D-9 exactly once and directly after the status card when the result lists options, the :488 conclusion
 *    presented only in its own state (O-3), and nothing else in the document changed;
 *  - historical records (baseline, no marker) and every invalid marker: the historical composition, unchanged;
 *  - the S-E.1 scanner families find nothing in version-1 application text (model text sentinel-wrapped);
 *  - no provenance view key or text anywhere.
 */
jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import historicalRecords from "@/lib/adaptiveSchema/__tests__/dsExport/__fixtures__/historicalRecords.json";
import { asStored, exportCases, exportRecord } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { D9, LABEL_AGREEMENT, LABEL_SOURCES, OLD_CAPTION, ORACLE, PROVENANCE_MARKERS, SHOWN_488, STORED_488, stateOf } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportOracle";
import { S, SENTINEL_SPAN } from "@/components/adaptive/__tests__/seSurfaces/seSurfaceHarness";
import { EXEMPTIONS, scanSurface, validateExemptions } from "@/components/adaptive/__tests__/seSurfaces/dsWordingScanner";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { governanceStatusDisplay } from "@/lib/adaptiveSchema/exportContentDerivation";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { extractPdfTextNodes } from "./testUtils";

const HISTORICAL = historicalRecords as unknown as Record<string, AdaptiveResearchExportV1>;
const nodes = (r: AdaptiveResearchExportV1) => extractPdfTextNodes(AdaptiveResearchDocument({ record: r }));
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const dsCases = exportCases().filter((c) => c.schemaId === "decision_support");
const marked = (name: string) => asStored(exportRecord(dsCases.find((c) => c.name === name)!, "pdf"));

/** [index of "Report status summary", index of the first node after the status region]. */
function statusRegion(n: string[]): [number, number] {
  const start = n.indexOf("Report status summary");
  const end = n.findIndex((t, i) => i > start && (t === "Conclusion" || t === "Primary synthesis"));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return [start, end];
}

describe("fixture coverage", () => {
  it("every DS state in the oracle is built, with every review state on two of them", () => {
    expect(new Set(dsCases.map((c) => stateOf(c.name)))).toEqual(new Set(Object.keys(ORACLE)));
    expect(dsCases.filter((c) => stateOf(c.name) === "unresolved_option_488").length).toBe(8);
  });
});

describe("version-1 Decision Support PDF", () => {
  it.each(dsCases.map((c) => [c.name]))("%s: corrected fields, no caption, D-9 placement, conclusion", (name) => {
    const record = marked(name);
    const o = ORACLE[stateOf(name)];
    const n = nodes(record);
    const [start, end] = statusRegion(n);
    const region = n.slice(start, end);
    // K-6 field names with E-1 / E-2 values (the first "Sources" is the status field; a later one is the receipt section).
    expect(region[region.indexOf(LABEL_AGREEMENT) + 1]).toBe(o.agreement);
    expect(region[region.indexOf(LABEL_SOURCES) + 1]).toBe(o.sources);
    for (const old of ["Consensus", "Source grounding", OLD_CAPTION]) expect(n.map(norm)).not.toContain(norm(old));
    expect(norm(n.join(" "))).not.toContain(norm(OLD_CAPTION));
    // D-9: exactly once when options exist, as the last node of the status region (directly after the card).
    const d9 = n.map(norm).filter((t) => t === norm(D9)).length;
    expect(d9).toBe(o.d9 ? 1 : 0);
    if (o.d9) expect(norm(n[end - 1])).toBe(norm(D9));
    // The shared review badge is unchanged.
    expect(n).toContain(governanceStatusDisplay(record).label);
    // O-3: the :488 conclusion.
    const receipt = record.reportSnapshot.milestone2?.decisionReceipt;
    if (receipt) {
      const shown = n[end + 1];
      if (o.conclusion488 === "presented") expect(shown).toBe(`Conditional go — ${SHOWN_488}`);
      else if (o.conclusion488 === "stored") expect(shown).toBe(`Conditional go — ${STORED_488}`);
      else expect(shown).toBe(receipt.conclusion);
      if (o.conclusion488 !== "presented") expect(n.join(" ")).not.toContain(SHOWN_488);
    } else {
      expect(n[end]).toBe("Primary synthesis");
    }
  });

  it.each(dsCases.map((c) => [c.name]))("%s: nothing outside the status region and the conclusion differs from the historical PDF", (name) => {
    const v1 = nodes(marked(name));
    const old = nodes(HISTORICAL[`${name}.pdf`]);
    const [s1, e1] = statusRegion(v1);
    const [s0, e0] = statusRegion(old);
    expect(v1.slice(0, s1)).toEqual(old.slice(0, s0));
    const after1 = v1.slice(e1);
    const after0 = old.slice(e0);
    expect(after1.length).toBe(after0.length);
    const conclusionAt = after0[0] === "Conclusion" ? 1 : -1;
    after1.forEach((t, i) => {
      if (i !== conclusionAt) expect(t).toBe(after0[i]);
    });
  });

  it("the historical status region is exactly what version 1 replaces: Consensus, Source grounding, caption", () => {
    const old = nodes(HISTORICAL["ds.uncontested_choose_option.unreviewed_in_queue.pdf"]);
    const [s, e] = statusRegion(old);
    const region = old.slice(s, e).map(norm);
    expect(region).toContain("Consensus");
    expect(region).toContain("Source grounding");
    expect(region).toContain(norm(OLD_CAPTION));
    expect(region).not.toContain(norm(D9));
  });
});

describe("historical and invalid markers render the historical PDF", () => {
  const variants: [string, unknown][] = [
    ["absent", undefined],
    ["presentation null", null],
    ["presentation {}", {}],
    ["marker null", { dsLabelWordingVersion: null }],
    ['marker "1"', { dsLabelWordingVersion: "1" }],
    ["marker 2", { dsLabelWordingVersion: 2 }],
    ["marker true", { dsLabelWordingVersion: true }],
    ["presentation array", [1]],
  ];
  const keys = ["ds.uncontested_choose_option.unreviewed_in_queue", "ds.unresolved_option_488.unreviewed_in_queue", "ds.no_recommendation_no_options.unreviewed_in_queue"];
  it.each(keys.flatMap((k) => variants.map(([label, p]) => [k, label, p] as [string, string, unknown])))("%s with %s", (key, label, presentation) => {
    const historical = HISTORICAL[`${key}.pdf`];
    const record = label === "absent" ? historical : ({ ...historical, reportSnapshot: { ...historical.reportSnapshot, presentation } } as AdaptiveResearchExportV1);
    const n = nodes(record);
    expect(n).toEqual(nodes(historical));
    expect(n).toContain("Consensus");
    expect(n.map(norm)).not.toContain(norm(D9));
  });

  it("a version-1 marker on a non-DS record changes nothing", () => {
    for (const key of ["nonds.comparison_matrix.unreviewed_in_queue.pdf", "nonds.financial_valuation.approved.pdf"]) {
      const historical = HISTORICAL[key];
      const forged = { ...historical, reportSnapshot: { ...historical.reportSnapshot, presentation: { dsLabelWordingVersion: 1 } } } as AdaptiveResearchExportV1;
      expect(nodes(forged)).toEqual(nodes(historical));
    }
  });

  it("newly built non-DS records compose exactly as their historical baseline", () => {
    for (const c of exportCases().filter((x) => x.schemaId !== "decision_support")) {
      expect(nodes(asStored(exportRecord(c, "pdf")))).toEqual(nodes(HISTORICAL[`${c.name}.pdf`]));
    }
  });
});

/**
 * Export-only pinned exemptions: the product name in the running footer and the closing note (F2 matches "converg…").
 * The bare brand header node ("ConvergePanel", one word, too short to pin as an exemption) is dropped by exact equality.
 */
const EXPORT_EXEMPTIONS = [...EXEMPTIONS, "ConvergePanel — Adaptive Research Export", "Generated with ConvergePanel. This document reflects"];
const BRAND = "ConvergePanel";
const scanNodes = (n: string[]) => n.map((t) => (t === BRAND ? "" : t));

describe("wording scanner and provenance boundary on version-1 PDFs", () => {
  it("the export exemptions are narrow (S-E.1 rules)", () => {
    expect(validateExemptions(EXPORT_EXEMPTIONS)).toEqual([]);
  });

  const wrapped = exportCases(S).filter((c) => c.schemaId === "decision_support");

  it.each(wrapped.map((c) => [c.name]))("%s: no F1–F8 hit in application text", (name) => {
    const record = asStored(exportRecord(wrapped.find((c) => c.name === name)!, "pdf"));
    const n = nodes(record);
    const receipt = record.reportSnapshot.milestone2?.decisionReceipt;
    const result = record.reportSnapshot.milestone2?.result as { recommendation: { rationale: string } };
    // The receipt conclusion is the stored :498 debt field (S-E.1 contract D): marked so the exact stored value is exempt.
    const fields = n.map((t) => (receipt && t === receipt.conclusion ? "receipt.conclusion" : null));
    const hits = scanSurface({ id: name, textNodes: scanNodes(n), attributes: [], fields }, { exemptions: EXPORT_EXEMPTIONS, storedRationales: [result.recommendation.rationale] });
    expect(hits).toEqual([]);
    // Not blind: the corrected wording and real model text are present.
    expect(n).toContain(LABEL_AGREEMENT);
    // Model text reaches the document only through the receipt; where the receipt carries any, it must be extracted.
    const modelTextInReceipt = JSON.stringify(receipt ?? {}).includes("⟦");
    expect((n.join(" ").match(SENTINEL_SPAN)?.length ?? 0) > 0).toBe(modelTextInReceipt);
  });

  it("the scanner is not blind to the historical wording on the same documents", () => {
    const record = HISTORICAL["ds.uncontested_choose_option.unreviewed_in_queue.pdf"];
    const hits = scanSurface({ id: "historical", textNodes: scanNodes(nodes(record)), attributes: [] }, { exemptions: EXPORT_EXEMPTIONS });
    expect(hits.map((h) => h.family)).toEqual(expect.arrayContaining(["F1-consensus-tier"]));
  });

  it("no provenance view key or text in any version-1 or historical PDF record or composition", () => {
    const all = [...dsCases.map((c) => marked(c.name)), ...Object.values(HISTORICAL).filter((r) => r.format === "pdf")];
    for (const r of all) {
      const text = nodes(r).join(" ") + JSON.stringify(r);
      for (const m of PROVENANCE_MARKERS) expect(text).not.toContain(m);
    }
  });
});
