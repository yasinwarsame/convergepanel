/**
 * PDF export pagination (PR B) — composer structure contracts. The rendered
 * behaviour is proven by renderedLayout.spec.ts; these pin the structure that
 * produces it, fail-closed:
 *  - `wrap={false}` on ANY element (View, Text or anything else) is allowed
 *    only at explicitly reviewed, bounded locations: the bounded cards, the
 *    paginating-card heading block, a card that is only its model label (a
 *    failed model), short heading labels, a bullet's mark, a short metric
 *    value and the zero-height gate of a closing long-value metric row. A new
 *    non-breaking element anywhere else fails
 *    here (R1 MAJOR 2: a non-breaking Text taller than a page loses its text);
 *  - every non-breaking element that can move (no non-breaking ancestor) has
 *    an earlier non-fixed sibling: react-pdf keeps a parent whole on the
 *    current page — overflowing it — when every child of a FIRST child moves;
 *  - every kept element (`minPresenceAhead`) is non-breaking, has an earlier
 *    non-fixed sibling in its parent — react-pdf only honours
 *    minPresenceAhead in that position (R1 MAJOR 1) — and keeps the distance
 *    its kind requires;
 *  - no metric row is non-breaking (R3 MAJOR: a label can be of any length);
 *    a long metric value splits at any line beside its label (R4 MINOR 2),
 *    and a long-value row that closes its card opens with a gate kept with
 *    one line plus the texts' closing padding (R5 MINOR 1);
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
const HEADING_LABEL_STYLES = new Set<unknown>([pdfStyles.sectionLabel, pdfStyles.fieldLabel, pdfStyles.modelLabel, pdfStyles.subLabelAfterContent]);
/** The reviewed bound on a non-breaking metric value: ≤ 32 characters in ≤ 40 % of the row → at most 3 lines. */
const METRIC_VALUE_MAX_CHARS = 32;

/*
 * Required keep-with-next distances, derived HERE from the theme (not from the
 * composer's constants): react-pdf never splits a Text of ≤ orphans + widows − 1
 * = 3 lines, so a heading must keep its own bottom margin plus three of the
 * tallest content lines (body text), and outer headings must cover the inner
 * heading's block plus its guarantee (R2 MAJOR: 40 < 47 stranded field labels).
 */
const UNSPLITTABLE_LINES = 3;
const num = (v: unknown) => Number(v ?? 0);
const BODY_LINE = num(pdfStyles.bodyText.fontSize) * num(pdfStyles.bodyText.lineHeight);
const BULLET_LINE = num(pdfStyles.bulletText.fontSize) * num(pdfStyles.bulletText.lineHeight);
const REQUIRED_FIELD = num(pdfStyles.fieldLabel.marginBottom) + UNSPLITTABLE_LINES * BODY_LINE;
const REQUIRED_SUB_LABEL = num(pdfStyles.subLabelAfterContent.marginBottom) + UNSPLITTABLE_LINES * BODY_LINE;
/** A bullet's mark is its text's first line: it must keep the rest of an unsplittable text. */
const REQUIRED_BULLET_MARK = (UNSPLITTABLE_LINES - 1) * BULLET_LINE;
/** A metric value (≥ 1 line) must keep a ≤ 3-line label whole, or ≥ 2 lines of a longer one. */
const REQUIRED_METRIC_VALUE = (UNSPLITTABLE_LINES - 1) * BODY_LINE;
/** A metric[] field label must keep a first row: top padding + a 3-line value + that value's own distance. */
const REQUIRED_METRIC_FIELD = num(pdfStyles.fieldLabel.marginBottom) + num(pdfStyles.metricRow.paddingVertical) + UNSPLITTABLE_LINES * BODY_LINE + REQUIRED_METRIC_VALUE;
const FIRST_IN_BODY_LABEL = Math.max(
  num(pdfStyles.fieldLabel.fontSize) * 1.2 + num(pdfStyles.fieldLabel.marginBottom),
  num(pdfStyles.subLabel.fontSize) * num(pdfStyles.subLabel.lineHeight) + num(pdfStyles.subLabel.marginBottom)
);
const REQUIRED_CARD_HEADING = FIRST_IN_BODY_LABEL + UNSPLITTABLE_LINES * BODY_LINE;
const REQUIRED_METRIC_FIRST_CARD_HEADING = FIRST_IN_BODY_LABEL + REQUIRED_METRIC_FIELD - num(pdfStyles.fieldLabel.marginBottom);
const CARD_HEAD_BLOCK = num(pdfStyles.cardHead.paddingTop) + num(pdfStyles.modelLabel.fontSize) * 1.2 + num(pdfStyles.modelLabel.marginBottom);
const MAX_HEADING_CHARS = 140;

/**
 * Whether an element's style is `base`, or `base` with only a closing box added (`textProps`: the card's closing
 * padding and margin on its last text — e.g. a closing field label whose value renders nothing, R5 NIT 2).
 */
const hasStyle = (el: El, base: object): boolean => {
  const style = el.props.style as Record<string, unknown> | undefined;
  if (style === base) return true;
  if (!style || typeof style !== "object") return false;
  const closingKeys = new Set(["paddingBottom", "marginBottom"]);
  const keys = new Set([...Object.keys(base), ...Object.keys(style)]);
  return [...keys].every((k) => closingKeys.has(k) || style[k] === (base as Record<string, unknown>)[k]) && num(style.paddingBottom) > 0;
};
/** The zero-height, childless gate a closing long-value metric row opens with (after its anchor). */
const isRowGate = (el: El) => el.type === "VIEW" && "minPresenceAhead" in el.props && (el.props.style as { height?: unknown } | undefined)?.height === 0 && expand(el.props.children).length === 0;
const isAnchor = (el: El) => el.type === "VIEW" && (el.props.style as { height?: unknown } | undefined)?.height === 0 && expand(el.props.children).length === 0;
/** A metric row: drawn `row-reverse` (value composed first, kept with its label). */
const isMetricRow = (el: El) => el.type === "VIEW" && (el.props.style as { flexDirection?: unknown } | undefined)?.flexDirection === "row-reverse";
const contains = (el: El, pred: (e: El) => boolean): boolean => {
  let found = false;
  walk(el, (e) => {
    if (pred(e)) found = true;
  });
  return found;
};
/** Whether a paginating card's body (the sibling after its heading block) opens with a metric[] field. */
function bodyOpensWithMetrics(body: El | undefined): boolean {
  if (!body) return false;
  const wrapper = expand(body.props.children)[0];
  const content = expand(wrapper?.props.children).filter((e) => !isAnchor(e));
  return content[1] !== undefined && contains(content[1], isMetricRow);
}

/** The reviewed allow-list of non-breaking locations. Anything else is unsafe. */
function nonBreakingIsAllowed(el: El): string | null {
  const text = extractPdfElementText(el).trim();
  if (el.type === "VIEW" && el.props.style === pdfStyles.card && BOUNDED_CARD_LABELS.some((l) => text.startsWith(l))) return "bounded card";
  if (el.type === "VIEW" && el.props.style === pdfStyles.cardHead && text.length <= MAX_HEADING_CHARS) return "card heading block";
  if (
    el.type === "VIEW" &&
    el.props.style === pdfStyles.labelOnlyCard &&
    expand(el.props.children).every((c) => c.type === "TEXT" && c.props.style === pdfStyles.modelLabel) &&
    text.length <= MAX_HEADING_CHARS
  )
    return "label-only card";
  if (el.type === "TEXT" && [...HEADING_LABEL_STYLES].some((style) => hasStyle(el, style as object)) && text.length <= MAX_HEADING_CHARS) return "heading label";
  if (isRowGate(el)) return "metric row gate (zero height, draws nothing)";
  if (el.type === "TEXT" && el.props.style === pdfStyles.bulletMark && text === "•") return "bullet mark";
  if (
    el.type === "TEXT" &&
    (el.props.style as { fontFamily?: unknown; maxWidth?: unknown }).fontFamily === pdfStyles.metricValue.fontFamily &&
    (el.props.style as { maxWidth?: unknown }).maxWidth === "40%" &&
    text.length <= METRIC_VALUE_MAX_CHARS
  )
    return "metric value";
  return null;
}

/** Visits every non-breaking element that can itself move (no non-breaking ancestor), with its host siblings. */
function walkMovable(node: unknown, visit: (el: El, siblings: El[], index: number) => void): void {
  const hosts = expand(node);
  hosts.forEach((el, i) => {
    if (el.props?.wrap === false) visit(el, hosts, i);
    else walkMovable(el.props?.children, visit);
  });
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

  it("every movable non-breaking element has an earlier non-fixed sibling (react-pdf never keeps its parent whole)", () => {
    const first: string[] = [];
    walkMovable(tree(name), (el, siblings, index) => {
      if (!siblings.slice(0, index).some((s) => !("fixed" in s.props))) first.push(`${String(el.type)}: ${extractPdfElementText(el).slice(0, 60)}`);
    });
    expect(first).toEqual([]);
  });

  it("no metric row is non-breaking; a short value precedes (is kept with) its label, a long one splits at any line beside it", () => {
    walk(tree(name), (el) => {
      if (isMetricRow(el)) {
        expect(el.props.wrap).not.toBe(false);
        const content = expand(el.props.children).filter((e) => !isAnchor(e));
        expect(content).toHaveLength(2);
        expect(content[1].props.wrap).not.toBe(false);
        if (extractPdfElementText(content[0]).trim().length <= METRIC_VALUE_MAX_CHARS) {
          expect(content[0].props.wrap).toBe(false);
        } else {
          // R4 MINOR 2: both texts split at any line.
          for (const text of content) expect([text.props.wrap, text.props.orphans, text.props.widows]).toEqual([undefined, 1, 1]);
          // R5 MINOR 1: a 1-line text with the closing padding moves whole where a longer one keeps a line, so a row
          // whose texts carry the card's closing padding opens with a gate kept with one line plus that padding.
          const closingPadding = Math.max(...content.map((c) => num((c.props.style as { paddingBottom?: unknown }).paddingBottom)));
          const hosts = expand(el.props.children);
          const gates = hosts.filter(isRowGate);
          if (closingPadding > 0) {
            expect(gates).toHaveLength(1);
            expect(hosts.indexOf(gates[0])).toBe(1);
            expect(isAnchor(hosts[0]) && !isRowGate(hosts[0])).toBe(true);
            expect(gates[0].props.minPresenceAhead).toBeGreaterThanOrEqual(BODY_LINE + closingPadding);
          } else expect(gates).toHaveLength(0);
        }
      }
    });
  });

  it("a bounded card never holds model or receipt content (its Panel conclusion is only the static notice)", () => {
    walk(tree(name), (el) => {
      if (el.type !== "VIEW" || el.props.style !== pdfStyles.card || el.props.wrap !== false) return;
      const text = extractPdfElementText(el);
      expect(text).not.toMatch(/#[A-Z]+\d{3}#/);
      if (text.trim().startsWith("Panel conclusion")) expect(text).toContain("does not produce a single synthesized panel conclusion");
    });
  });

  it("every kept heading is non-breaking, has an earlier non-fixed sibling, and keeps enough content for its kind", () => {
    let kept = 0;
    walk(tree(name), (el, siblings, index) => {
      if (!("minPresenceAhead" in el.props)) return;
      kept++;
      const ahead = el.props.minPresenceAhead as number;
      const cardRequirement = (headIndex: number) => (bodyOpensWithMetrics(siblings[headIndex + 1]) ? REQUIRED_METRIC_FIRST_CARD_HEADING : REQUIRED_CARD_HEADING);
      if (hasStyle(el, pdfStyles.fieldLabel)) {
        const metric = siblings[index + 1] !== undefined && contains(siblings[index + 1], isMetricRow);
        expect(ahead).toBeGreaterThanOrEqual(metric ? REQUIRED_METRIC_FIELD : REQUIRED_FIELD);
      } else if (el.props.style === pdfStyles.subLabelAfterContent) expect(ahead).toBeGreaterThanOrEqual(REQUIRED_SUB_LABEL);
      else if (el.props.style === pdfStyles.cardHead) expect(ahead).toBeGreaterThanOrEqual(cardRequirement(index));
      else if (el.props.style === pdfStyles.sectionLabel) {
        const head = siblings.findIndex((s, i) => i > index && s.props.style === pdfStyles.cardHead);
        expect(ahead).toBeGreaterThanOrEqual(CARD_HEAD_BLOCK + (head >= 0 ? cardRequirement(head) : REQUIRED_CARD_HEADING));
      } else if (el.props.style === pdfStyles.bulletMark) expect(ahead).toBeGreaterThanOrEqual(REQUIRED_BULLET_MARK);
      else if (isRowGate(el)) {
        // Checked against its row's texts in the metric-row test; here: it is one line plus at least the card padding.
        expect(ahead).toBeGreaterThanOrEqual(BODY_LINE + num(pdfStyles.cardHead.paddingTop));
      }
      else if ((el.props.style as { maxWidth?: unknown }).maxWidth === "40%") expect(ahead).toBeGreaterThanOrEqual(REQUIRED_METRIC_VALUE);
      else throw new Error(`unclassified kept heading: ${extractPdfElementText(el)}`);
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

it("the derived requirements are the ones R2 and R3 established", () => {
  expect(BODY_LINE).toBe(15);
  expect(REQUIRED_FIELD).toBe(47);
  expect(REQUIRED_SUB_LABEL).toBe(48);
  expect(REQUIRED_CARD_HEADING).toBeGreaterThan(60);
  expect(REQUIRED_BULLET_MARK).toBe(28);
  expect(REQUIRED_METRIC_VALUE).toBe(30);
  expect(REQUIRED_METRIC_FIELD).toBe(80);
  expect(REQUIRED_METRIC_FIRST_CARD_HEADING).toBeGreaterThan(REQUIRED_CARD_HEADING);
});

it("a card whose first field is a metric[] keeps the longer metric distance at the card and section headings", () => {
  const record = pdfLayoutFixtures().find((f) => f.name === "metric-first-00-0")!.record;
  let cards = 0;
  walk(AdaptiveResearchDocument({ record }), (el, siblings, index) => {
    if (el.props.style !== pdfStyles.cardHead) return;
    cards++;
    expect(bodyOpensWithMetrics(siblings[index + 1])).toBe(true);
    expect(el.props.minPresenceAhead).toBeGreaterThanOrEqual(REQUIRED_METRIC_FIRST_CARD_HEADING);
  });
  expect(cards).toBeGreaterThan(0);
});

it("the Disagreement sub-label is a kept heading (non-breaking, after content, with its guarantee)", () => {
  const found: unknown[] = [];
  walk(tree("disagreement-label-0-00"), (el, siblings, index) => {
    if (el.type === "TEXT" && extractPdfElementText(el).trim() === "Disagreement") {
      found.push(el);
      expect(el.props.style).toBe(pdfStyles.subLabelAfterContent);
      expect(el.props.wrap).toBe(false);
      expect(el.props.minPresenceAhead).toBeGreaterThanOrEqual(REQUIRED_SUB_LABEL);
      expect(index).toBeGreaterThan(0);
      expect(extractPdfElementText(siblings[index + 1]).length).toBeGreaterThan(0);
    }
  });
  expect(found).toHaveLength(1);
});

it("the kept headings cover every heading kind of a long legacy report", () => {
  const texts: string[] = [];
  walk(tree("legacy-contested-long-cards"), (el) => {
    if ("minPresenceAhead" in el.props) texts.push(extractPdfElementText(el).trim());
  });
  expect(texts).toContain("Model responses (5)");
  expect(texts).toEqual(expect.arrayContaining(["Panel conclusion", "Where models agree / disagree", "Disagreement", "Settled Claims", "Disputed Claims", "Key Metrics", "Open Questions"]));
  expect(texts.filter((t) => / · /.test(t))).toHaveLength(5);
});
