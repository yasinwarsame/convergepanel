/**
 * Order 6 / S-E.1 — the owner-approved Decision Support wording (D-10 (b); K-1 with revisions; K-3, K-5, K-6).
 *
 * Independent oracle: every expected string below is a literal copied from the owner ruling of 2026-10-28 or from the
 * sealed spec (B §3.1 L677, B §3.5.4 L909), never imported from the module under test.
 */

import {
  DS_OPTION_GROUPING_DISCLOSURE,
  DS_STRENGTH_LABEL,
  dsHasListedSources,
  dsModelAgreement,
  dsReceiptSourcesLabel,
  dsRecommendationCounts,
  dsSourcesBadge,
  dsSourcesSummary,
  dsUncontestedStatement,
  isDecisionSupportSchema,
} from "../dsLabelWording";
import * as wording from "../dsLabelWording";
import { OPTION_CLUSTERING_UNVERIFIED_TEXT } from "../dsProvenanceViewMin";
import type { DecisionSupportResult } from "../types";

function ds(over: { k?: unknown; n?: unknown; m?: unknown; contested?: unknown; sources?: unknown } = {}): DecisionSupportResult {
  return {
    totalModels: "m" in over ? over.m : 3,
    sources: "sources" in over ? over.sources : ["Vendor report"],
    recommendation: {
      action: "go",
      rationale: "",
      caveats: [],
      isContested: "contested" in over ? over.contested : false,
      supportCount: "n" in over ? over.n : 3,
      totalModelsWithRecommendation: "k" in over ? over.k : 3,
    },
  } as unknown as DecisionSupportResult;
}

describe("owner-approved strings (literal oracle)", () => {
  it("pins every exported wording constant to the ruling's text", () => {
    expect({
      field: wording.DS_MODEL_AGREEMENT_FIELD,
      sourcesField: wording.DS_SOURCES_FIELD,
      noDisagreement: wording.DS_NO_DISAGREEMENT_IDENTIFIED,
      split: wording.DS_AGREEMENT_SPLIT,
      notScored: wording.DS_AGREEMENT_NOT_SCORED,
      noRecommendation: wording.DS_NO_RECOMMENDATION,
      provided: wording.DS_SOURCES_PROVIDED,
      listed: wording.DS_SOURCES_LISTED,
      none: wording.DS_NO_SOURCES_LISTED,
      basis: wording.DS_GROUPING_BASIS,
      notFlagged: wording.DS_NOT_FLAGGED_FOR_REVIEW,
      certainty: wording.DS_NOT_A_CERTAINTY_MEASURE,
      caption: wording.DS_STRENGTH_CAPTION,
      tally: wording.DS_STRENGTH_TALLY_HEADING,
    }).toEqual({
      field: "Model agreement",
      sourcesField: "Sources",
      noDisagreement: "No disagreement identified by current grouping",
      split: "Split",
      notScored: "Not scored",
      noRecommendation: "No model gave a recommendation.",
      provided: "Sources provided by models; not independently verified",
      listed: "Sources listed; not independently verified",
      none: "No sources listed",
      basis: "Based on the currently grouped recommendations. Opposing options may have been grouped together.",
      notFlagged: "System did not flag this for human review.",
      certainty: "These counts are not a certainty measure.",
      caption: "Evidence-strength ratings are assigned by the models and were not independently checked.",
      tally: "Model-assigned evidence strength, not independently checked",
    });
  });

  it("D-9: the disclosure is the sealed spec text, character for character, and equals the builder's constant", () => {
    const SEALED_B_L677 =
      "Options were grouped by text similarity. Different options with similar wording (for example 3.5% vs 35%, or Approve vs Disapprove) can be merged; agreement on an option is not established.";
    expect(DS_OPTION_GROUPING_DISCLOSURE).toBe(SEALED_B_L677);
    expect(DS_OPTION_GROUPING_DISCLOSURE).toBe(OPTION_CLUSTERING_UNVERIFIED_TEXT);
  });

  it("E-8: Strong/Moderate/Weak always carry the qualifier; contested and unknown keep their own words", () => {
    expect(DS_STRENGTH_LABEL).toEqual({
      strong: "Strong (model-assigned)",
      moderate: "Moderate (model-assigned)",
      weak: "Weak (model-assigned)",
      contested: "Contested",
      unknown: "Unrated",
    });
  });
});

describe("isDecisionSupportSchema", () => {
  it.each([
    ["decision_support", true],
    ["deep_research", false],
    ["Decision_Support", false],
    [undefined, false],
    [null, false],
    ["", false],
  ])("%p → %p", (schemaId, expected) => {
    expect(isDecisionSupportSchema(schemaId)).toBe(expected);
  });
});

describe("E-1 dsModelAgreement: state, never a threshold", () => {
  it.each([
    ["no result", undefined, "Not scored"],
    ["K = 0", ds({ k: 0, n: 0 }), "Not scored"],
    ["K not an integer", ds({ k: 1.5 }), "Not scored"],
    ["K negative", ds({ k: -1 }), "Not scored"],
    ["contested", ds({ contested: true, n: 2 }), "Split"],
    ["uncontested, K = 3, N = 3", ds(), "No disagreement identified by current grouping"],
    ["uncontested, K = 1 of M = 5", ds({ k: 1, n: 1, m: 5 }), "No disagreement identified by current grouping"],
    ["isContested missing", ds({ contested: undefined }), "Not scored"],
    ["isContested non-boolean", ds({ contested: "false" }), "Not scored"],
  ])("%s → %p", (_name, input, expected) => {
    expect(dsModelAgreement(input as DecisionSupportResult | undefined).text).toBe(expected);
  });

  it("uses no ratio: an uncontested result with N < K (impossible today) is still described by state, not by N/K", () => {
    expect(dsModelAgreement(ds({ k: 4, n: 1 })).text).toBe("No disagreement identified by current grouping");
  });
});

describe("K-5 sources: a non-blank reference list is the only basis for 'listed'", () => {
  it.each([
    ["one reference", ["Vendor report"], true],
    ["blank string only", [""], false],
    ["whitespace only", ["   ", "\t"], false],
    ["empty list", [], false],
    ["non-string entries only", [1, null, {}], false],
    ["mixed blank and real", ["", "https://example.com/a"], true],
    ["list absent", undefined, null],
    ["not a list", "Vendor report", null],
  ])("%s → %p", (_name, sources, expected) => {
    expect(dsHasListedSources(sources)).toBe(expected);
  });

  it("E-2 summary and E-3 badge follow the list; an absent list omits the claim", () => {
    expect(dsSourcesSummary(ds())).toBe("Sources provided by models; not independently verified");
    expect(dsSourcesSummary(ds({ sources: [""] }))).toBe("No sources listed");
    expect(dsSourcesSummary(ds({ sources: undefined }))).toBeNull();
    expect(dsSourcesSummary(undefined)).toBeNull();
    expect(dsSourcesBadge(["Vendor report"])).toBe("Sources listed; not independently verified");
    expect(dsSourcesBadge([" "])).toBe("No sources listed");
    expect(dsSourcesBadge(undefined)).toBeNull();
  });

  it("legacy result with no list: only a stored sourceBacked === false establishes 'No sources listed'; anything else omits", () => {
    const legacy = (sourceBacked: unknown) => ({ ...ds({ sources: undefined }), sourceBacked }) as DecisionSupportResult;
    expect(dsSourcesSummary(legacy(false))).toBe("No sources listed");
    expect(dsSourcesSummary(legacy(true))).toBeNull();
    expect(dsSourcesSummary(legacy(undefined))).toBeNull();
    expect(dsSourcesBadge(undefined, false)).toBe("No sources listed");
    expect(dsSourcesBadge(undefined, true)).toBeNull();
    expect(dsSourcesBadge(undefined, "false")).toBeNull();
    // A recorded list always wins over the flag.
    expect(dsSourcesBadge(["Vendor report"], false)).toBe("Sources listed; not independently verified");
    expect(dsSourcesSummary({ ...ds({ sources: [""] }), sourceBacked: true } as DecisionSupportResult)).toBe("No sources listed");
  });

  it("receipt flag: true cannot establish listed sources (omit); false establishes none; anything else omits", () => {
    expect(dsReceiptSourcesLabel(true)).toBeNull();
    expect(dsReceiptSourcesLabel(false)).toBe("No sources listed");
    expect(dsReceiptSourcesLabel(undefined)).toBeNull();
    expect(dsReceiptSourcesLabel("false")).toBeNull();
  });
});

describe("E-7 dsRecommendationCounts: the approved D-2 template", () => {
  // B §3.5.4 L909: "{M} {model|models} dispatched; {K} gave a recommendation; largest group recommending the same action: {N}."
  const D2 = /^(\d+) (model|models) dispatched; (\d+) gave a recommendation; largest group recommending the same action: (\d+)\. These counts are not a certainty measure\.$/;

  it.each([
    [ds({ m: 5, k: 1, n: 1 }), "5 models dispatched; 1 gave a recommendation; largest group recommending the same action: 1. These counts are not a certainty measure."],
    [ds({ m: 2, k: 0, n: 0 }), "2 models dispatched; 0 gave a recommendation; largest group recommending the same action: 0. These counts are not a certainty measure."],
    [ds({ m: 1, k: 1, n: 1 }), "1 model dispatched; 1 gave a recommendation; largest group recommending the same action: 1. These counts are not a certainty measure."],
    [ds({ m: 4, k: 4, n: 2, contested: true }), "4 models dispatched; 4 gave a recommendation; largest group recommending the same action: 2. These counts are not a certainty measure."],
  ])("%#", (input, expected) => {
    const text = dsRecommendationCounts(input);
    expect(text).toBe(expected);
    expect(text).toMatch(D2);
    expect(text).not.toMatch(/\bof\b|converg/i);
  });

  it.each([["m", { m: undefined }], ["k", { k: null }], ["n", { n: -1 }], ["n non-integer", { n: 0.5 }], ["m string", { m: "3" }]])(
    "omits the statement when %s is not a non-negative integer",
    (_name, over) => {
      expect(dsRecommendationCounts(ds(over as Parameters<typeof ds>[0]))).toBeNull();
    }
  );

  it("omits for an absent result", () => {
    expect(dsRecommendationCounts(undefined)).toBeNull();
  });
});

describe("E-4 dsUncontestedStatement", () => {
  it.each([
    ["uncontested K ≥ 1", ds(), "No disagreement identified by current grouping."],
    ["uncontested K = 0", ds({ k: 0, n: 0 }), "No model gave a recommendation."],
    ["contested", ds({ contested: true }), null],
    ["isContested missing", ds({ contested: undefined }), null],
    ["K invalid", ds({ k: "3" }), null],
  ])("%s → %p", (_name, input, expected) => {
    expect(dsUncontestedStatement(input)).toBe(expected);
  });
});
