/**
 * PDF export pagination (PR B) — composer structure contracts. The rendered
 * behaviour is proven by renderedLayout.spec.ts; these pin the structure that
 * produces it, fail-closed:
 *  - `wrap={false}` on ANY element (View, Text or anything else) is allowed
 *    only at explicitly reviewed, bounded locations: the bounded cards, the
 *    paginating-card heading block, and short heading labels. A new
 *    non-breaking element anywhere else fails here (R1 MAJOR 2: a
 *    non-breaking Text taller than a page loses its text);
 *  - every kept heading (`minPresenceAhead`) is non-breaking and has an
 *    earlier non-fixed sibling in its parent — react-pdf only honours
 *    minPresenceAhead in that position (R1 MAJOR 1);
 *  - every fixture marker is composed exactly once.
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
import { pdfStyles } from "@/lib/pdf/theme";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { extractPdfElementText } from "./testUtils";

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

/** Host elements a node expands to: function components are invoked (none use hooks), fragments and arrays flattened. */
function expand(node: unknown, depth = 0): El[] {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((n) => expand(n, depth));
  const el = node as El;
  if (typeof el !== "object" || !("type" in el)) return [];
  if (depth > 80) throw new Error("element tree too deep");
  if (typeof el.type === "function") return expand((el.type as (p: unknown) => unknown)(el.props), depth + 1);
  if (typeof el.type !== "string") return expand(el.props?.children, depth + 1); // React.Fragment
  return [el];
}

/** Visits every host element with its host-level siblings. */
function walk(node: unknown, visit: (el: El, siblings: El[], index: number) => void): void {
  const hosts = expand(node);
  hosts.forEach((el, i) => {
    visit(el, hosts, i);
    walk(el.props?.children, visit);
  });
}

const BOUNDED_CARD_LABELS = ["Report status summary", "Provenance", "Primary synthesis", "Panel conclusion"];
const HEADING_LABEL_STYLES = new Set<unknown>([pdfStyles.sectionLabel, pdfStyles.fieldLabel, pdfStyles.modelLabel]);
const MAX_HEADING_CHARS = 140;

/** The reviewed allow-list of non-breaking locations. Anything else is unsafe. */
function nonBreakingIsAllowed(el: El): string | null {
  const text = extractPdfElementText(el).trim();
  if (el.type === "VIEW" && el.props.style === pdfStyles.card && BOUNDED_CARD_LABELS.some((l) => text.startsWith(l))) return "bounded card";
  if (el.type === "VIEW" && el.props.style === pdfStyles.cardHead && text.length <= MAX_HEADING_CHARS) return "card heading block";
  if (el.type === "TEXT" && HEADING_LABEL_STYLES.has(el.props.style) && text.length <= MAX_HEADING_CHARS) return "heading label";
  return null;
}

const tree = (name: string) => AdaptiveResearchDocument({ record: pdfLayoutFixtures().find((f) => f.name === name)!.record });

describe.each(pdfLayoutFixtures().map((f) => [f.name]))("%s", (name) => {
  it("every non-breaking element (any type) is at a reviewed, bounded location", () => {
    const unsafe: string[] = [];
    let count = 0;
    walk(tree(name), (el) => {
      if (el.props?.wrap !== false) return;
      count++;
      if (!nonBreakingIsAllowed(el)) unsafe.push(`${String(el.type)}: ${extractPdfElementText(el).slice(0, 60)}`);
    });
    expect(count).toBeGreaterThan(0);
    expect(unsafe).toEqual([]);
  });

  it("a bounded card never holds model or receipt content (its Panel conclusion is only the static notice)", () => {
    walk(tree(name), (el) => {
      if (el.type !== "VIEW" || el.props.style !== pdfStyles.card || el.props.wrap !== false) return;
      const text = extractPdfElementText(el);
      expect(text).not.toMatch(/#[A-Z]+\d{3}#/);
      if (text.trim().startsWith("Panel conclusion")) expect(text).toContain("does not produce a single synthesized panel conclusion");
    });
  });

  it("every kept heading is non-breaking and has an earlier non-fixed sibling (where minPresenceAhead takes effect)", () => {
    let kept = 0;
    walk(tree(name), (el, siblings, index) => {
      if (!("minPresenceAhead" in el.props)) return;
      kept++;
      expect(el.props.minPresenceAhead).toBeGreaterThanOrEqual(36);
      expect(el.props.wrap).toBe(false);
      expect(index).toBeGreaterThan(0);
      expect(siblings.slice(0, index).some((s) => !("fixed" in s.props))).toBe(true);
    });
    expect(kept).toBeGreaterThan(0);
  });

  it("every fixture marker is composed exactly once", () => {
    const fixture = pdfLayoutFixtures().find((f) => f.name === name)!;
    const text = extractPdfElementText(tree(name));
    for (const marker of fixture.markers) expect(text.split(marker).length - 1).toBe(1);
  });
});

it("the kept headings cover every heading kind of a long legacy report", () => {
  const texts: string[] = [];
  walk(tree("legacy-contested-long-cards"), (el) => {
    if ("minPresenceAhead" in el.props) texts.push(extractPdfElementText(el).trim());
  });
  expect(texts).toContain("Model responses (5)");
  expect(texts).toEqual(expect.arrayContaining(["Panel conclusion", "Where models agree / disagree", "Settled Claims", "Disputed Claims", "Key Metrics", "Open Questions"]));
  expect(texts.filter((t) => / · /.test(t))).toHaveLength(5);
});
