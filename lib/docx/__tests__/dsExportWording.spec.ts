/**
 * Order 6 / S-E.2 (H1-A): Decision Support wording in the REAL generated DOCX (document.xml text, one line per paragraph).
 * Same contract as the PDF spec: version-1 records get the corrected status block, D-9 directly after it, the :488
 * conclusion only in its own state, and nothing else changed; historical and invalid markers keep the historical text.
 * Normalized-XML equality against the baseline is in dsExportRendered.spec.ts.
 */
jest.mock("firebase-admin/firestore", () => ({ FieldValue: class FieldValue {}, Timestamp: class Timestamp {} }));

import historicalRecords from "@/lib/adaptiveSchema/__tests__/dsExport/__fixtures__/historicalRecords.json";
import { asStored, exportCases, exportRecord } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
import { D9, LABEL_AGREEMENT, LABEL_SOURCES, OLD_CAPTION, ORACLE, PROVENANCE_MARKERS, SHOWN_488, STORED_488, stateOf } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportOracle";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";
import { governanceStatusDisplay } from "@/lib/adaptiveSchema/exportContentDerivation";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { extractDocxText } from "./testUtils";

const HISTORICAL = historicalRecords as unknown as Record<string, AdaptiveResearchExportV1>;
const lines = async (r: AdaptiveResearchExportV1) => (await extractDocxText((await renderAdaptiveResearchDocxV1(r)).bytes)).split("\n");
const dsCases = exportCases().filter((c) => c.schemaId === "decision_support");
const marked = (name: string) => asStored(exportRecord(dsCases.find((c) => c.name === name)!, "docx"));

function statusRegion(l: string[]): [number, number] {
  const start = l.indexOf("Report status summary");
  const end = l.findIndex((t, i) => i > start && (t === "Conclusion" || t === "Primary synthesis"));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return [start, end];
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
    // Everything outside the status block and the conclusion line equals the historical document.
    const old = await lines(HISTORICAL[`${name}.docx`]);
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
    const old = await lines(HISTORICAL["ds.uncontested_choose_option.unreviewed_in_queue.docx"]);
    const [s, e] = statusRegion(old);
    expect(old.slice(s, e)).toEqual(expect.arrayContaining(["CONSENSUS", "SOURCE GROUNDING", OLD_CAPTION]));
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
      const historical = HISTORICAL[key];
      const record = label === "absent" ? historical : ({ ...historical, reportSnapshot: { ...historical.reportSnapshot, presentation } } as AdaptiveResearchExportV1);
      const l = await lines(record);
      expect(l).toEqual(await lines(historical));
      expect(l).toContain("CONSENSUS");
      expect(l).not.toContain(D9);
    }
  });

  it("a version-1 marker on a non-DS record changes nothing; new non-DS records match their baseline text", async () => {
    for (const key of ["nonds.comparison_matrix.unreviewed_in_queue.docx", "nonds.financial_valuation.approved.docx"]) {
      const historical = HISTORICAL[key];
      const forged = { ...historical, reportSnapshot: { ...historical.reportSnapshot, presentation: { dsLabelWordingVersion: 1 } } } as AdaptiveResearchExportV1;
      expect(await lines(forged)).toEqual(await lines(historical));
    }
    for (const c of exportCases().filter((x) => x.schemaId !== "decision_support")) {
      expect(await lines(asStored(exportRecord(c, "docx")))).toEqual(await lines(HISTORICAL[`${c.name}.docx`]));
    }
  });
});
