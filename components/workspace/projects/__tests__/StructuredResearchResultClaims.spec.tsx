/**
 * Presentation follow-up to #276 (owner-approved 2026-11-02): claim and camp layout in StructuredResearchResult.
 *
 *   A. a claim in the generic schema's exact shape leads with its text; stance, model-reported confidence and evidence
 *      type are secondary metadata; the claim id stays visible in small print.
 *   B. camps group each label with its position, in the model's wording.
 *   D. stored enum values get readable one-to-one labels; the stored value stays on the element; confidence is
 *      described as the model's own label, never as verified.
 *   Anything not in the exact shape keeps the generic layout, with every stored value still visible.
 * Assertions are on rendered text and structure (react-test-renderer).
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import StructuredResearchResult from "@/components/workspace/projects/StructuredResearchResult";
import { CONFIDENCE_LABELS, EVIDENCE_TYPE_LABELS, STANCE_LABELS, claimLabel } from "@/lib/research/claimDisplayLabels";

function render(value: unknown): TestRenderer.ReactTestRenderer {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(createElement(StructuredResearchResult, { value }));
  });
  return r;
}
function text(n: TestRenderer.ReactTestInstance | TestRenderer.ReactTestRenderer): string {
  const root = "root" in n ? n.root : n;
  const out: string[] = [];
  const walk = (x: TestRenderer.ReactTestInstance | string) => (typeof x === "string" ? out.push(x) : x.children.forEach(walk));
  walk(root);
  return out.join("");
}
const byId = (r: TestRenderer.ReactTestRenderer | TestRenderer.ReactTestInstance, id: string) =>
  ("root" in r ? r.root : r).findAll((n) => typeof n.type === "string" && n.props["data-testid"] === id);

const CLAIM = {
  id: "c1",
  claim: "AI agents replace most early hires.",
  stance: "asserts",
  confidence: "majority_view",
  evidenceType: "empirical",
  camps: [
    { label: "Optimists", position: "Possible within a decade." },
    { label: "Skeptics", position: "Coordination costs dominate." },
  ],
};

/** [term, visible label, stored value, title] for each metadata item of one claim. */
function metaOf(claim: TestRenderer.ReactTestInstance) {
  return byId(claim, "claim-meta").map((m) => {
    const dd = m.findByType("dd");
    return [text(m.findByType("dt")), text(dd), dd.props["data-value"], dd.props.title];
  });
}

describe("A + D: a schema-exact claim", () => {
  it("leads with the claim text, then readable metadata that keeps each stored value", () => {
    const r = render({ summary: "S", keyClaims: [CLAIM] });
    const claims = byId(r, "structured-claim");
    expect(claims).toHaveLength(1);
    const li = claims[0];
    // The claim text is the first element of the card.
    expect(li.children[0]).toBe(byId(li, "structured-claim-text")[0]);
    expect(text(byId(li, "structured-claim-text")[0])).toBe(CLAIM.claim);
    expect(metaOf(li)).toEqual([
      ["Stance:", "Asserts", "asserts", "Stored value: asserts"],
      [
        "Model-reported confidence:",
        "Majority view",
        "majority_view",
        "The answering model's own label for this claim, not a confidence verified by the panel. Stored value: majority_view",
      ],
      ["Evidence type:", "Empirical", "empirical", "Stored value: empirical"],
    ]);
    // The id is kept, in small print, after the content.
    expect(text(byId(li, "structured-claim-id")[0])).toBe("Claim ID: c1");
    expect(li.children[li.children.length - 1]).toBe(byId(li, "structured-claim-id")[0]);
    // No raw enum value or generic field heading in the visible text of the card.
    const visible = text(li);
    for (const raw of ["majority_view", "evidenceType", "Camps", "Label", "Id"]) expect(visible).not.toContain(raw);
  });

  it("the field heading above the list is unchanged", () => {
    const r = render({ keyClaims: [CLAIM] });
    expect(text(r).startsWith("Key claims")).toBe(true);
  });

  it("only the metadata a claim carries is shown", () => {
    const r = render({ keyClaims: [{ claim: "Only confidence.", confidence: "speculative" }] });
    const li = byId(r, "structured-claim")[0];
    expect(metaOf(li).map((m) => m.slice(0, 3))).toEqual([["Model-reported confidence:", "Speculative", "speculative"]]);
    expect(byId(li, "structured-claim-id")).toHaveLength(0);
    expect(byId(li, "structured-camps")).toHaveLength(0);
  });

  it.each([
    ...Object.entries(STANCE_LABELS).map(([v, l]) => ["stance", v, l]),
    ...Object.entries(CONFIDENCE_LABELS).map(([v, l]) => ["confidence", v, l]),
    ...Object.entries(EVIDENCE_TYPE_LABELS).map(([v, l]) => ["evidenceType", v, l]),
  ])("%s %s is shown as %s", (field, value, label) => {
    const r = render({ keyClaims: [{ claim: "x", [field]: value }] });
    const [[, shown, stored]] = metaOf(byId(r, "structured-claim")[0]);
    expect([shown, stored]).toEqual([label, value]);
  });

  it("every schema value has exactly one label, and the tables cover exactly the schema", () => {
    expect(Object.keys(STANCE_LABELS)).toEqual(["asserts", "disputes", "uncertain"]);
    expect(Object.keys(CONFIDENCE_LABELS)).toEqual(["settled", "majority_view", "contested", "speculative"]);
    expect(Object.keys(EVIDENCE_TYPE_LABELS)).toEqual(["empirical", "theoretical", "anecdotal", "authoritative"]);
    for (const t of [STANCE_LABELS, CONFIDENCE_LABELS, EVIDENCE_TYPE_LABELS]) expect(new Set(Object.values(t)).size).toBe(Object.keys(t).length);
  });

  it("inherited object keys are not labels", () => {
    for (const v of ["toString", "constructor", "__proto__", "hasOwnProperty"]) expect(claimLabel(CONFIDENCE_LABELS, v)).toBeNull();
  });
});

describe("B: camps", () => {
  it("inside a claim, each label is grouped with its position under 'Competing positions'", () => {
    const li = byId(render({ keyClaims: [CLAIM] }), "structured-claim")[0];
    expect(text(li)).toContain("Competing positions");
    const camps = byId(li, "structured-camp");
    expect(camps.map((c) => c.findAllByType("span").map(text))).toEqual([
      ["Optimists", "Possible within a decade."],
      ["Skeptics", "Coordination costs dominate."],
    ]);
    expect(camps[0].findAllByType("span")[0].props.className).toContain("font-semibold");
  });

  it("a standalone camp list gets the same grouping", () => {
    const r = render({ camps: CLAIM.camps });
    expect(byId(r, "structured-camp").map((c) => c.findAllByType("span").map(text))).toEqual(CLAIM.camps.map((c) => [c.label, c.position]));
    expect(text(r)).not.toContain("Label");
  });
});

describe("anything outside the exact shape keeps the generic layout, every value visible", () => {
  it.each([
    ["an extra field", { ...CLAIM, notes: "extra note" }, ["extra note", "Notes"]],
    ["an unknown confidence", { ...CLAIM, confidence: "Very High" }, ["Very High"]],
    ["a capitalised stance", { ...CLAIM, stance: "Asserts" }, ["Asserts"]],
    ["an inherited key as a value", { ...CLAIM, confidence: "toString" }, ["toString"]],
    ["an empty claim text", { ...CLAIM, claim: "  " }, ["majority_view"]],
    ["a non-string claim", { ...CLAIM, claim: 42 }, ["42"]],
    ["a numeric id", { ...CLAIM, id: 7 }, ["7"]],
    ["no metadata at all", { id: "c9", claim: "Bare claim." }, ["Bare claim.", "c9"]],
    ["a camp with an extra field", { ...CLAIM, camps: [{ label: "L", position: "P", models: ["x"] }] }, ["Models"]],
    ["camps that are not a list", { ...CLAIM, camps: "a camp" }, ["a camp"]],
  ])("%s", (_k, claim, expected) => {
    const r = render({ keyClaims: [claim] });
    expect(byId(r, "structured-claim")).toHaveLength(0);
    for (const e of expected) expect(text(r)).toContain(e);
  });

  it("a list mixing a schema-exact claim and another object uses the generic layout for both", () => {
    const r = render({ keyClaims: [CLAIM, { claim: "Other", confidence: "high" }] });
    expect(byId(r, "structured-claim")).toHaveLength(0);
    for (const v of [CLAIM.claim, "majority_view", "Other", "high"]) expect(text(r)).toContain(v);
  });

  it("camp-like objects with only a position are not grouped as camps", () => {
    const r = render({ camps: [{ position: "P only" }] });
    expect(byId(r, "structured-camp")).toHaveLength(0);
    expect(text(r)).toContain("P only");
  });
});

it("model-provided markup in a claim or camp is text, never an element", () => {
  const r = render({ keyClaims: [{ ...CLAIM, claim: "<script>alert(1)</script>", camps: [{ label: "<b>x</b>", position: "<img src=x onerror=alert(2)>" }] }] });
  expect(text(r)).toContain("<script>alert(1)</script>");
  expect(text(r)).toContain("<img src=x onerror=alert(2)>");
  expect(r.root.findAll((n) => n.type === "script" || n.type === "img" || n.type === "b")).toHaveLength(0);
});
