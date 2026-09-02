/**
 * `StructuredResearchResult` / `humanizeKey` — the follow-up to PR #130's
 * JSON-pretty-print hotfix. `StructuredResearchResult` is pure/prop-driven
 * (no hooks/effects), so `renderToStaticMarkup` exercises its real render
 * logic directly, same pattern as `TeamResearchResultView.spec.tsx`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StructuredResearchResult, { humanizeKey } from "@/components/workspace/projects/StructuredResearchResult";

function render(value: unknown): string {
  return renderToStaticMarkup(createElement(StructuredResearchResult, { value }));
}

describe("humanizeKey", () => {
  it("splits camelCase into sentence case", () => {
    expect(humanizeKey("directAnswer")).toBe("Direct answer");
  });

  it("splits snake_case into sentence case", () => {
    expect(humanizeKey("contributing_factors")).toBe("Contributing factors");
  });

  it("splits kebab-case into sentence case", () => {
    expect(humanizeKey("alternative-explanations")).toBe("Alternative explanations");
  });

  it("splits PascalCase into sentence case", () => {
    expect(humanizeKey("PascalCaseThing")).toBe("Pascal case thing");
  });

  it("humanizes a novel, never-before-seen camelCase field purely mechanically", () => {
    // Deliberately not used anywhere else in this test file / fixtures — proves no hardcoded dictionary is needed.
    expect(humanizeKey("counterfactualScenarioWeighting")).toBe("Counterfactual scenario weighting");
  });
});

describe("StructuredResearchResult — rendering contract", () => {
  it("renders a structured object without visible raw JSON syntax (no braces/quotes/camelCase keys)", () => {
    const html = render({ directAnswer: "The answer is yes.", keyRisks: ["Risk one", "Risk two"] });
    expect(html).not.toContain("{");
    expect(html).not.toContain("}");
    expect(html).not.toContain("&quot;directAnswer&quot;:");
    expect(html).not.toContain("directAnswer");
    expect(html).toContain("Direct answer");
    expect(html).toContain("Key risks");
  });

  it("renders directAnswer first, with visual emphasis, before other fields", () => {
    const html = render({ contributingFactors: ["Factor A"], directAnswer: "This is the headline answer." });
    const directIdx = html.indexOf("This is the headline answer.");
    const factorsIdx = html.indexOf("Contributing factors");
    expect(directIdx).toBeGreaterThanOrEqual(0);
    expect(factorsIdx).toBeGreaterThan(directIdx);
    // The directAnswer value paragraph gets modest emphasis (larger/bold) vs. an ordinary field's plain text-sm paragraph.
    expect(html).toContain("text-base font-semibold");
  });

  it("renders all fields in original order when no directAnswer-equivalent field is present", () => {
    const html = render({ first: "one", second: "two" });
    expect(html.indexOf("one")).toBeLessThan(html.indexOf("two"));
  });

  it("renders an array of strings as a bullet list", () => {
    const html = render({ items: ["Alpha", "Beta", "Gamma"] });
    expect(html).toContain("<ul");
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).toContain("Gamma");
  });

  it("humanizes a generic unmapped camelCase field (keyRisks) with no dictionary entry for it", () => {
    const html = render({ keyRisks: ["Some risk"] });
    expect(html).toContain("Key risks");
    expect(html).not.toContain("keyRisks");
  });

  it("humanizes a snake_case field", () => {
    const html = render({ contributing_factors: ["A factor"] });
    expect(html).toContain("Contributing factors");
    expect(html).not.toContain("contributing_factors");
  });

  it("humanizes a kebab-case field", () => {
    const html = render({ "alternative-explanations": ["An explanation"] });
    expect(html).toContain("Alternative explanations");
    expect(html).not.toContain("alternative-explanations");
  });

  it("renders a nested object as a labeled, recursively-rendered sub-section", () => {
    const html = render({ breakdown: { primaryCause: "Demand shock", secondaryCause: "Supply shock" } });
    expect(html).toContain("Breakdown");
    expect(html).toContain("Primary cause");
    expect(html).toContain("Demand shock");
    expect(html).toContain("Secondary cause");
    expect(html).toContain("Supply shock");
    expect(html).not.toContain("{");
  });

  it("renders an array of objects as repeated readable blocks, not serialized JSON", () => {
    const html = render({
      scenarios: [
        { label: "Moderate", probability: 0.4 },
        { label: "Severe", probability: 0.1 },
      ],
    });
    expect(html).not.toContain("&quot;label&quot;");
    expect(html).toContain("Label");
    expect(html).toContain("Moderate");
    expect(html).toContain("Severe");
    expect(html).toContain("Probability");
    expect(html).toContain("0.4");
  });

  it("omits an empty array entirely (no visible empty section)", () => {
    const html = render({ visibleField: "shown", emptyList: [] });
    expect(html).toContain("shown");
    expect(html).not.toContain("Empty list");
  });

  it("omits an empty object entirely (no visible empty section)", () => {
    const html = render({ visibleField: "shown", emptyThing: {} });
    expect(html).toContain("shown");
    expect(html).not.toContain("Empty thing");
  });

  it("omits null values (no visible 'null' text or empty section)", () => {
    const html = render({ visibleField: "shown", nullField: null });
    expect(html).toContain("shown");
    expect(html).not.toContain("Null field");
    expect(html).not.toMatch(/>\s*null\s*</);
  });

  it("omits undefined values", () => {
    const html = render({ visibleField: "shown", undefinedField: undefined });
    expect(html).toContain("shown");
    expect(html).not.toContain("Undefined field");
  });

  it("renders a mixed-primitive array (numbers/booleans) safely without crashing", () => {
    const html = render({ mixedList: [1, true, "text", false, 2.5] });
    expect(html).toContain("<ul");
    expect(html).toContain("text");
    expect(html).toContain("1");
    expect(html).toContain("true");
  });

  it("a top-level array of strings renders semantically (bullets, no enclosing object)", () => {
    const html = render(["One", "Two", "Three"]);
    expect(html).toContain("<ul");
    expect((html.match(/<li/g) || []).length).toBe(3);
    expect(html).not.toContain("{");
  });

  it("a top-level array of objects renders semantically (repeated blocks)", () => {
    const html = render([
      { name: "Alpha", score: 1 },
      { name: "Beta", score: 2 },
    ]);
    expect(html).toContain("Name");
    expect(html).toContain("Alpha");
    expect(html).toContain("Beta");
    expect(html).not.toContain("&quot;name&quot;");
  });

  it("a top-level empty object renders nothing", () => {
    const html = render({});
    expect(html).toBe("");
  });

  it("a top-level empty array renders nothing", () => {
    const html = render([]);
    expect(html).toBe("");
  });

  it("a script/HTML-looking string value renders as escaped, inert text — not executable, not raw HTML", () => {
    const html = render({ note: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("an entirely unknown/future field shape renders generically and readably", () => {
    const html = render({
      mainFinding: "The signal is statistically significant.",
      supportingEvidence: ["Study A confirms the effect.", "Study B replicates it."],
      counterArguments: ["Sample size concerns raised by critics."],
    });
    expect(html).toContain("Main finding");
    expect(html).toContain("The signal is statistically significant.");
    expect(html).toContain("Supporting evidence");
    expect(html).toContain("Study A confirms the effect.");
    expect(html).toContain("Counter arguments");
    expect(html).toContain("Sample size concerns raised by critics.");
    expect(html).not.toContain("{");
    expect(html).not.toContain("mainFinding");
  });

  it("no raw camelCase JSON key syntax is visible anywhere in the rendered output for a normal structured result", () => {
    const html = render({ directAnswer: "Yes.", keyRisks: ["Risk"], supportingEvidence: ["Evidence"] });
    expect(html).not.toMatch(/"directAnswer"\s*:/);
    expect(html).not.toContain("directAnswer");
    expect(html).not.toContain("keyRisks");
    expect(html).not.toContain("supportingEvidence");
  });

  it("realistic production-shape fixture (inflation causes, synthetic) renders all sections humanized with no raw JSON", () => {
    const fixture = {
      directAnswer: "US inflation stems primarily from a combination of demand and supply-side pressures.",
      directCauses: ["Excess aggregate demand", "Supply-side disruptions", "Expansionary monetary policy"],
      contributingFactors: ["Global commodity shocks", "Labor market tightness"],
      triggers: ["Pandemic-era disruptions"],
      amplifiers: ["Wage-price feedback loops"],
      alternativeExplanations: ["A purely supply-driven explanation"],
      causalLinks: ["Higher input costs can be passed through to consumers via higher prices."],
    };
    const html = render(fixture);

    for (const label of ["Direct answer", "Direct causes", "Contributing factors", "Triggers", "Amplifiers", "Alternative explanations", "Causal links"]) {
      expect(html).toContain(label);
    }
    for (const rawKey of ["directAnswer", "directCauses", "contributingFactors", "alternativeExplanations", "causalLinks"]) {
      expect(html).not.toContain(`"${rawKey}":`);
      expect(html).not.toContain(`&quot;${rawKey}&quot;`);
    }
    expect(html).not.toContain("{");
    expect(html).not.toContain("}");
  });
});
