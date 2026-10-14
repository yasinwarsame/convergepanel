/**
 * PDF export pagination (PR B) — composer structure. Content of unbounded
 * length must be allowed to break across pages: a non-breaking block taller
 * than the remaining page space overlaps the next block and loses text in the
 * real renderer (proven by scripts/verify-pdf-layout.mjs; see
 * renderedLayout.spec.ts). Here, on the element tree:
 *  - the ONLY non-breaking (`wrap={false}`) views are the structurally bounded
 *    cards (status summary, provenance, static notices);
 *  - every heading that introduces paginating content keeps a minimum of
 *    following content on its page (`minPresenceAhead`);
 *  - every fixture marker is composed exactly once (nothing dropped).
 */
jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { extractPdfElementText } from "./testUtils";

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

/** Expands function components (none use hooks) and visits every host element. */
function walk(node: unknown, visit: (el: El) => void, depth = 0): void {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit, depth));
  const el = node as El;
  if (typeof el !== "object" || !("type" in el)) return;
  if (depth > 80) throw new Error("element tree too deep");
  if (typeof el.type === "function") return walk((el.type as (p: unknown) => unknown)(el.props), visit, depth + 1);
  visit(el);
  walk(el.props?.children, visit, depth);
}

function render(fixtureName: string) {
  const fixture = pdfLayoutFixtures().find((f) => f.name === fixtureName)!;
  return { fixture, tree: AdaptiveResearchDocument({ record: fixture.record }) };
}

const BOUNDED_LABELS = ["Report status summary", "Provenance", "Primary synthesis", "Panel conclusion"];

describe.each(pdfLayoutFixtures().map((f) => [f.name]))("%s", (name) => {
  it("only bounded cards are non-breaking", () => {
    const { tree } = render(name);
    const nonBreaking: string[] = [];
    walk(tree, (el) => {
      if (el.type === "VIEW" && el.props.wrap === false) nonBreaking.push(extractPdfElementText(el).trim());
    });
    expect(nonBreaking.length).toBeGreaterThan(0);
    for (const text of nonBreaking) {
      expect(BOUNDED_LABELS.some((label) => text.startsWith(label))).toBe(true);
    }
  });

  it("a bounded 'Panel conclusion' card is only the static no-synthesis notice, never model text", () => {
    const { tree } = render(name);
    walk(tree, (el) => {
      if (el.type === "VIEW" && el.props.wrap === false) {
        const text = extractPdfElementText(el);
        if (text.trim().startsWith("Panel conclusion")) expect(text).toContain("does not produce a single synthesized panel conclusion");
        expect(text).not.toMatch(/#[A-Z]\d{3}#/);
      }
    });
  });

  it("every fixture marker is composed exactly once", () => {
    const { fixture, tree } = render(name);
    const text = extractPdfElementText(tree);
    for (const marker of fixture.markers) expect(text.split(marker).length - 1).toBe(1);
  });
});

it("section, model-card and field headings keep following content on their page", () => {
  const { tree } = render("legacy-contested-long-cards");
  const headings: Array<{ text: string; ahead: unknown }> = [];
  walk(tree, (el) => {
    if (el.type === "TEXT" && "minPresenceAhead" in el.props) headings.push({ text: extractPdfElementText(el).trim(), ahead: el.props.minPresenceAhead });
  });
  for (const h of headings) expect(h.ahead).toBeGreaterThanOrEqual(36);
  const texts = headings.map((h) => h.text);
  expect(texts).toContain("Model responses (5)");
  expect(texts).toContain("Disputed Claims");
  expect(texts).toEqual(expect.arrayContaining(["Report status summary", "Provenance"]));
  expect(texts.filter((t) => t.startsWith("ChatGPT ·") || t.startsWith("Claude ·"))).toHaveLength(2);
});
