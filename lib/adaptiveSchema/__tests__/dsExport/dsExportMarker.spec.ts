/**
 * Order 6 / S-E.2 (H1-A): the presentation-version marker, its strict selection, the export conclusion presenter, and
 * the JSON boundary. Historical records come from the baseline captured at unchanged main 0249a4e5
 * (__fixtures__/historicalRecords.json, committed before any production change).
 */
jest.mock("firebase-admin/firestore", () => ({ FieldValue: class FieldValue {}, Timestamp: class Timestamp {} }));

import historicalRecords from "./__fixtures__/historicalRecords.json";
import { asStored, exportCases, exportRecord, FORMATS, dsStates, dsOutput } from "./dsExportFixtures";
import { buildExportSnapshot } from "@/lib/adaptiveSchema/exportSnapshot";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { buildAdaptiveResearchJsonExport, renderAdaptiveResearchJsonV1 } from "@/lib/adaptiveSchema/jsonExport";
import {
  DS_LABEL_WORDING_VERSION,
  DS_UNRESOLVED_OPTION_EXPLANATION,
  DS_UNRESOLVED_OPTION_STORED_RATIONALE,
  dsExportShowsGroupingDisclosure,
  dsPresentedExportConclusion,
  isDsLabelWordingMarked,
} from "@/lib/adaptiveSchema/dsLabelWording";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import type { DecisionSupportResult } from "@/lib/adaptiveSchema/types";

const HISTORICAL = historicalRecords as unknown as Record<string, AdaptiveResearchExportV1>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const withPresentation = (r: AdaptiveResearchExportV1, presentation: unknown): AdaptiveResearchExportV1 =>
  ({ ...clone(r), reportSnapshot: { ...clone(r.reportSnapshot), presentation } }) as AdaptiveResearchExportV1;

describe("baseline fixture integrity", () => {
  it("the historical records are the unmarked, stored form for every case and format", () => {
    const keys = exportCases().flatMap((c) => FORMATS.map((f) => `${c.name}.${f}`));
    expect(Object.keys(HISTORICAL).sort()).toEqual(keys.sort());
    for (const r of Object.values(HISTORICAL)) {
      expect(Object.prototype.hasOwnProperty.call(r.reportSnapshot, "presentation")).toBe(false);
      expect(r.artifactStatus).toBe("ready");
    }
    expect(keys.filter((k) => k.startsWith("ds.")).length).toBeGreaterThanOrEqual(90);
  });

  it("asStored mirrors the real sanitizeForFirestore on every built record", () => {
    for (const c of exportCases()) {
      const r = exportRecord(c, "pdf");
      expect(asStored(r)).toEqual(sanitizeForFirestore(r));
    }
  });
});

describe("marker assignment (buildExportSnapshot)", () => {
  it("new Decision Support snapshots carry exactly { dsLabelWordingVersion: 1 }, a number", () => {
    const ds = exportCases().filter((c) => c.schemaId === "decision_support");
    expect(ds.length).toBeGreaterThanOrEqual(30);
    for (const c of ds) {
      const { reportSnapshot } = buildExportSnapshot(c.input);
      expect(reportSnapshot.presentation).toStrictEqual({ dsLabelWordingVersion: 1 });
      expect(typeof reportSnapshot.presentation?.dsLabelWordingVersion).toBe("number");
      expect(DS_LABEL_WORDING_VERSION).toBe(1);
    }
  });

  it("non-DS snapshots have no presentation key at all, before and after Firestore sanitization (never null)", () => {
    const nonDs = exportCases().filter((c) => c.schemaId !== "decision_support");
    expect(nonDs.map((c) => c.schemaId).sort()).toEqual(["comparison_matrix", "comparison_matrix", "financial_valuation"]);
    for (const c of nonDs) {
      const { reportSnapshot } = buildExportSnapshot(c.input);
      expect(Object.prototype.hasOwnProperty.call(reportSnapshot, "presentation")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(sanitizeForFirestore(reportSnapshot) as object, "presentation")).toBe(false);
    }
  });

  it("other Milestone-2 schema ids that can build from this result get no marker (the builder branches on decision_support only)", () => {
    const s = dsStates()[0];
    const built: string[] = [];
    for (const schemaId of ["ranked_enumeration", "comparison_matrix", "definition_explanation", "causal_explanation", "checklist_taxonomy", "deep_research", "evidence_review", "bias_blindspot_audit"]) {
      const output = { ...dsOutput(s), schemaId } as never;
      let snapshot: Record<string, unknown> | undefined;
      try {
        snapshot = buildExportSnapshot({ question: "q", selectedModels: [], runDocument: undefined, milestone2: { output } }).reportSnapshot as never;
      } catch {
        snapshot = undefined; // a schema whose consensus input cannot read a DS-shaped result; covered by the controls above
      }
      if (snapshot) {
        built.push(schemaId);
        expect(Object.prototype.hasOwnProperty.call(snapshot, "presentation")).toBe(false);
      }
    }
    // The other five need a result of their own shape to build at all; the non-DS controls and the mutation run cover them.
    expect(built.length).toBeGreaterThanOrEqual(3);
  });

  it("the snapshot is otherwise unchanged: head output, stored, equals the historical stored snapshot plus only the marker", () => {
    for (const c of exportCases()) {
      for (const f of FORMATS) {
        const head = asStored(exportRecord(c, f));
        const historical = HISTORICAL[`${c.name}.${f}`];
        const { presentation, ...rest } = head.reportSnapshot;
        expect(rest).toEqual(historical.reportSnapshot);
        if (c.schemaId === "decision_support") expect(presentation).toStrictEqual({ dsLabelWordingVersion: 1 });
        else expect(presentation).toBeUndefined();
      }
    }
  });

  it("the marker is never inside milestone2.result or decisionReceipt", () => {
    for (const c of exportCases().filter((x) => x.schemaId === "decision_support")) {
      const { reportSnapshot } = buildExportSnapshot(c.input);
      expect(JSON.stringify(reportSnapshot.milestone2)).not.toContain("dsLabelWordingVersion");
      expect(JSON.stringify(reportSnapshot.milestone2)).not.toContain("presentation");
    }
  });
});

describe("strict selection (isDsLabelWordingMarked)", () => {
  const dsHistorical = HISTORICAL["ds.uncontested_choose_option.unreviewed_in_queue.pdf"];
  const nonDsHistorical = HISTORICAL["nonds.comparison_matrix.unreviewed_in_queue.pdf"];
  const legacyHistorical = HISTORICAL["nonds.financial_valuation.approved.pdf"];

  it("selects version 1 only for a Decision Support record whose stored marker is exactly the number 1", () => {
    expect(isDsLabelWordingMarked(withPresentation(dsHistorical, { dsLabelWordingVersion: 1 }))).toBe(true);
    expect(isDsLabelWordingMarked(asStored(exportRecord(exportCases()[0], "pdf")))).toBe(true);
  });

  it.each([
    ["marker missing (historical record)", undefined, "absent"],
    ["presentation null (sanitized undefined)", null, "value"],
    ["presentation {}", {}, "value"],
    ["marker null", { dsLabelWordingVersion: null }, "value"],
    ['marker "1"', { dsLabelWordingVersion: "1" }, "value"],
    ["marker 2", { dsLabelWordingVersion: 2 }, "value"],
    ["marker 0", { dsLabelWordingVersion: 0 }, "value"],
    ["marker true", { dsLabelWordingVersion: true }, "value"],
    ["marker [1]", { dsLabelWordingVersion: [1] }, "value"],
    ["marker { value: 1 }", { dsLabelWordingVersion: { value: 1 } }, "value"],
    ["presentation is an array", [1], "value"],
    ["presentation is the number 1", 1, "value"],
    ['presentation is the string "1"', "1", "value"],
    ["marker under another key", { dsLabelWordingversion: 1 }, "value"],
  ])("legacy for %s", (_label, presentation, mode) => {
    const r = mode === "absent" ? dsHistorical : withPresentation(dsHistorical, presentation);
    expect(isDsLabelWordingMarked(r)).toBe(false);
  });

  it("a version-1 marker on a non-DS Milestone-2 record, a legacy record, or a mismatched family is ignored", () => {
    expect(isDsLabelWordingMarked(withPresentation(nonDsHistorical, { dsLabelWordingVersion: 1 }))).toBe(false);
    expect(isDsLabelWordingMarked(withPresentation(legacyHistorical, { dsLabelWordingVersion: 1 }))).toBe(false);
    const wrongFamily = { ...withPresentation(dsHistorical, { dsLabelWordingVersion: 1 }), schemaFamily: "legacy" } as AdaptiveResearchExportV1;
    expect(isDsLabelWordingMarked(wrongFamily)).toBe(false);
    const noM2 = withPresentation(dsHistorical, { dsLabelWordingVersion: 1 });
    delete (noM2.reportSnapshot as { milestone2?: unknown }).milestone2;
    expect(isDsLabelWordingMarked(noM2)).toBe(false);
    expect(isDsLabelWordingMarked(null)).toBe(false);
    expect(isDsLabelWordingMarked({ schemaFamily: "milestone2", reportSnapshot: null })).toBe(false);
  });

  it("every historical record in the baseline selects legacy", () => {
    for (const r of Object.values(HISTORICAL)) expect(isDsLabelWordingMarked(r)).toBe(false);
  });
});

describe("export conclusion (owner O-3) and D-9 eligibility", () => {
  const stored = `Conditional go — ${DS_UNRESOLVED_OPTION_STORED_RATIONALE}`;
  const presented = `Conditional go — ${DS_UNRESOLVED_OPTION_EXPLANATION}`;
  const result = (name: string) => dsOutput(dsStates().find((s) => s.name === name)!).result as DecisionSupportResult;

  it("substitutes the :488 conclusion when the frozen result is in the unresolved state", () => {
    const r = result("unresolved_option_488");
    expect(r.recommendation.rationale).toBe(DS_UNRESOLVED_OPTION_STORED_RATIONALE);
    expect(dsPresentedExportConclusion(r, stored)).toBe(presented);
  });

  it("keeps a model-written copy of the sentence (uncontested collision) as stored: the export sees the state", () => {
    const r = result("conditional_go_collision_488");
    expect(r.recommendation.isContested).toBe(false);
    expect(r.recommendation.rationale).toBe(DS_UNRESOLVED_OPTION_STORED_RATIONALE);
    expect(dsPresentedExportConclusion(r, stored)).toBe(stored);
  });

  it("leaves every other conclusion, a near miss, and a missing result unchanged", () => {
    const r = result("unresolved_option_488");
    for (const other of [`Go — ${DS_UNRESOLVED_OPTION_STORED_RATIONALE}`, `${stored} `, `Conditional go — ${DS_UNRESOLVED_OPTION_STORED_RATIONALE.slice(0, -1)}`, "Choose option: A — x"]) {
      expect(dsPresentedExportConclusion(r, other)).toBe(other);
    }
    expect(dsPresentedExportConclusion(undefined, stored)).toBe(stored);
    expect(dsPresentedExportConclusion({} as DecisionSupportResult, stored)).toBe(stored);
    for (const name of ["split_option_498", "partial_option_resolution_498", "uncontested_choose_option"]) {
      expect(dsPresentedExportConclusion(result(name), stored)).toBe(stored);
    }
  });

  it("D-9 is eligible exactly when the frozen result lists at least one option", () => {
    const expectations: Record<string, boolean> = { no_recommendation_no_options: false, all_models_failed: false, uncontested_choose_option: true, merged_opposite_options: true, no_sources: true };
    for (const [name, want] of Object.entries(expectations)) expect(dsExportShowsGroupingDisclosure(result(name))).toBe(want);
    expect(dsExportShowsGroupingDisclosure(undefined)).toBe(false);
    expect(dsExportShowsGroupingDisclosure({ options: "x" } as unknown as DecisionSupportResult)).toBe(false);
  });
});

describe("JSON export boundary", () => {
  it("a marked DS record serializes byte-identically to the same record without the marker, and never emits it", () => {
    for (const c of exportCases().filter((x) => x.schemaId === "decision_support")) {
      const marked = asStored(exportRecord(c, "json"));
      expect(isDsLabelWordingMarked(marked)).toBe(true);
      const unmarked = clone(marked);
      delete (unmarked.reportSnapshot as { presentation?: unknown }).presentation;
      const a = renderAdaptiveResearchJsonV1(marked);
      expect(a.bytes.equals(renderAdaptiveResearchJsonV1(unmarked).bytes)).toBe(true);
      expect(a.bytes.toString("utf8")).not.toContain("dsLabelWordingVersion");
      expect(Object.keys(buildAdaptiveResearchJsonExport(marked)).sort()).toEqual(["classification", "export", "formatVersion", "governance", "panel", "provenance", "report", "result"]);
    }
  });
});
