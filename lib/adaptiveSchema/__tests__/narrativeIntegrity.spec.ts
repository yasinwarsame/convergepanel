/**
 * Narrative integrity (D9; R3-1 — Option B)
 *
 * The panel's agreement is stated only by deterministic text; a model
 * sentence that characterises it is removed, whatever its phrasing, scope,
 * negation or accuracy. Explanatory prose — the subject matter, named-model
 * subgroup positions — stays.
 */

import { isAgreementBearing, withoutAgreementClaims } from "@/lib/adaptiveSchema/narrativeIntegrity";

/** The R3-1 bypass classes (R3-REPORT.md), verbatim from the preserved reproductions. */
const R3_1_BYPASSES: Array<[string, string]> = [
  ["number-word counts", "Every single model agrees that supply shocks explain persistent core inflation."],
  ["subgroup-word exemption", "The models not only agree that supply shocks explain persistent core inflation, they cite the same data."],
  ["double negation", "The models could not agree more that supply shocks explain persistent core inflation."],
  ["single_source as plural", "Several models agree that housing costs lag policy rates by two years."],
  ["one row per sentence", "Inflation expectations anchor wage growth and the panel agrees supply shocks explain persistent core inflation."],
  ["unattributed paraphrase", "The panel agrees that disruptions to supply chains are the main driver of sticky core prices."],
  ["mixed agree line", "All models agree inflation expectations anchor wage growth and supply shocks explain persistent core inflation."],
];

/** Earlier rounds' overstatement corpus (N3, R2-1) plus negated forms — all agreement-bearing now, in every field. */
const AGREEMENT_CORPUS = [
  "All five models agree X.",
  "Five of five models agree that X.",
  "Four of the five models agree central bank credibility drives bond yields.",
  "Three out of five models converge on X.",
  "Two models agree that X.",
  "Some models agree with X.",
  "Most models agree tariffs raise consumer prices measurably.",
  "A majority of models hold that X.",
  "Not surprisingly, the models agree that X.",
  "Without exception the models agree that X.",
  "Not only do the models agree that X, they cite the same data.",
  "The panel speaks with one voice on X.",
  "The prevailing view is that X.",
  "There is no disagreement that X.",
  "There is broad consensus that prices will fall.",
  "The models endorse the view that central bank credibility drives bond yields.",
  "The panel was unanimous about X.",
  "It is settled that minimum wage increases reduce employment.",
  "Minimum wage increases reduce employment is well established.",
  "X is uncontested among the models.",
  "The models do not agree on X.",
  "The models don't agree on X.",
  "There is no consensus on X.",
  "The models failed to reach a consensus on X.",
  "There is a lack of agreement on X.",
  "The question is not settled.",
  // R3-2 predicates
  "X is proven.",
  "X is uncontroversial.",
  "X is widely accepted.",
  "There is little doubt that X.",
  "X is beyond question.",
  "The models see eye to eye on X.",
  "The majority view is that X.",
  // quantified panel references with no agreement word at all
  "Every single model cites the 2023 study.",
  "Most of the models cite the 2023 study.",
  "They all cite the same study.",
  "All of them cite the same study.",
  "Four of five models argue X.",
  "3 models cite the 2023 study.",
  "3/5 models cite the 2023 study.",
];

/** Division words and collective panel references: removed from the panel-free fields, allowed in a disagreement explanation. */
const DIVISION_OR_COLLECTIVE = [
  "The models disagree about X.",
  "Opinion is split on X.",
  "X remains contested.",
  "The models diverge on how to read the data.",
  "The models weigh different evidence.",
  "These models cite older data.",
  "The panel examined the 2023 study.",
];

/** Explanatory prose that must survive in every field. */
const EXPLANATORY = [
  "Wage growth tracks inflation expectations.",
  "ChatGPT emphasises lag effects; Grok stresses supply shocks.",
  "ChatGPT and Grok weigh the survey data more heavily, while Claude relies on trial results.",
  "The evidence base for supply-shock explanations is thinner.",
  "Confidence is moderate because the data end in 2024.",
  "Climate models project further warming this century.",
  "Economic models of the Phillips curve have weakened since 2010.",
  "The United States raised tariffs in 2025.",
  "Insurance coverage for the drug varies by state.",
  "The majority of patients recovered within a week.",
  "The legal dispute over the statute continues in two courts.",
  "They weigh different evidence.",
];

describe("narrative integrity — every R3-1 bypass is agreement-bearing, by construction", () => {
  it.each(R3_1_BYPASSES)("%s", (_cls, sentence) => {
    expect(isAgreementBearing(sentence, "panel_free")).toBe(true);
    expect(isAgreementBearing(sentence, "disagreement")).toBe(true);
    expect(withoutAgreementClaims(sentence, "panel_free")).toBe("");
  });
});

describe("narrative integrity — no exemptions: scope, negation and accuracy are not read", () => {
  it.each(AGREEMENT_CORPUS)("removed in every field: %s", (sentence) => {
    expect(isAgreementBearing(sentence, "panel_free")).toBe(true);
    expect(isAgreementBearing(sentence, "disagreement")).toBe(true);
  });
});

describe("narrative integrity — division and collective references", () => {
  it.each(DIVISION_OR_COLLECTIVE)("panel-free fields remove, a disagreement explanation keeps: %s", (sentence) => {
    expect(isAgreementBearing(sentence, "panel_free")).toBe(true);
    expect(isAgreementBearing(sentence, "disagreement")).toBe(false);
  });
});

describe("narrative integrity — explanatory prose stays usable", () => {
  it.each(EXPLANATORY)("kept in every field: %s", (sentence) => {
    expect(isAgreementBearing(sentence, "panel_free")).toBe(false);
    expect(isAgreementBearing(sentence, "disagreement")).toBe(false);
  });
});

describe("withoutAgreementClaims", () => {
  it("removes only the agreement-bearing sentences, keeping the rest in order", () => {
    expect(
      withoutAgreementClaims("Wage growth tracks expectations. The models agree it will persist. Data end in 2024.", "panel_free")
    ).toBe("Wage growth tracks expectations. Data end in 2024.");
  });

  it("is empty when nothing survives", () => {
    expect(withoutAgreementClaims("The models agree. Most models converge.", "panel_free")).toBe("");
    expect(withoutAgreementClaims("", "panel_free")).toBe("");
  });

  it.each([
    ["multiple paragraphs, a sentence removed mid-paragraph", "A one. The models agree. A two.\n\nB para.", "A one. A two.\n\nB para."],
    ["a whole paragraph removed — no empty paragraph left", "A para.\n\nThe panel agrees.\n\nC para.", "A para.\n\nC para."],
    ["the first paragraph removed", "The models agree.\n\nOnly para.", "Only para."],
    ["the last paragraph removed", "Only para.\n\nThe models agree.", "Only para."],
    ["bullet list items", "- Item one.\n- The models agree.\n- Item three.", "- Item one.\n- Item three."],
    ["numbered list items", "1. Step one.\n2) Most models converge here.\n3. Step three.", "1. Step one.\n3. Step three."],
    ["a heading kept above its paragraph", "## Evidence\nLine one. The panel agrees.\n\nNext.", "## Evidence\nLine one.\n\nNext."],
    ["an agreement-bearing heading removed with its line", "## The panel agrees\nLine one.", "Line one."],
    ["CRLF kept", "Line one.\r\nThe panel agrees.\r\n\r\nNext para.", "Line one.\r\n\r\nNext para."],
    ["CRLF kept between two kept lines", "Line one.\r\nThe panel agrees.\r\nLine three.", "Line one.\r\nLine three."],
    ["blank-line runs kept as they were", "First.\n\n\nSecond.", "First.\n\n\nSecond."],
    ["single line breaks kept", "Line one.\nLine two.", "Line one.\nLine two."],
  ])("keeps layout (R4-2): %s", (_name, input, expected) => {
    expect(withoutAgreementClaims(input, "panel_free")).toBe(expected);
  });

  it("removes a whole sentence, never just the offending clause", () => {
    expect(withoutAgreementClaims("Wages rise, and the panel agrees prices follow.", "disagreement")).toBe("");
  });
});
