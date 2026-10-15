/**
 * PDF export pagination (PR B) — the pure layout rules applied to real
 * rendered PDFs by scripts/verify-pdf-layout.mjs. Each rule is shown to fire
 * on the defect shape and to stay quiet on ordinary layout.
 */
import {
  BOUNDARY_TOLERANCE,
  cardBoxes,
  cardClosingGapViolations,
  MIN_CARD_CLOSING_GAP,
  detachedPairViolations,
  documentText,
  documentViolations,
  emptyCardFragmentViolations,
  isFooterText,
  isHeadingItem,
  loneBulletViolations,
  MIN_FRAGMENT_WIDTH,
  pageViolations,
  readingLines,
  readingOrderViolations,
  renderedMarkerSequence,
  strandedHeadingViolations,
  type PdfPageText,
  type PdfShapeBox,
  type PdfTextItem,
} from "@/lib/pdf/layoutIntegrity";

const LAYOUT = { paddingTop: 48, paddingBottom: 56 };
const A4 = { width: 595.28, height: 841.89 };
const t = (str: string, x: number, y: number, width = 100, height = 10): PdfTextItem => ({ str, x, y, width, height });
const page = (items: PdfTextItem[], pageNumber = 1): PdfPageText => ({ pageNumber, ...A4, items });

describe("overlap", () => {
  it("text drawn on top of other text is a violation", () => {
    const v = pageViolations(page([t("Card A line", 50, 400), t("Card B line", 60, 402)]), LAYOUT);
    expect(v).toEqual([expect.objectContaining({ kind: "overlap", a: "Card A line", b: "Card B line" })]);
  });
  it("consecutive lines (15pt leading at 10pt) do not overlap", () => {
    expect(pageViolations(page([t("line 1", 50, 400), t("line 2", 50, 385), t("line 3", 50, 370)]), LAYOUT)).toEqual([]);
  });
  it("adjacent runs on one baseline (bold key + value) do not overlap", () => {
    expect(pageViolations(page([t("claim: ", 50, 400, 30), t("value text", 80, 400, 120)]), LAYOUT)).toEqual([]);
  });
  it("a small graze below the ratio threshold is tolerated, a large one is not", () => {
    expect(pageViolations(page([t("a", 50, 400, 100), t("b", 145, 400, 100)]), LAYOUT)).toEqual([]);
    expect(pageViolations(page([t("a", 50, 400, 100), t("b", 100, 400, 100)]), LAYOUT)).toHaveLength(1);
  });
  it("whitespace-only and zero-width runs are ignored", () => {
    expect(pageViolations(page([t("   ", 50, 400), t("text", 50, 400), t("x", 50, 400, 0)]), LAYOUT)).toEqual([]);
  });
});

describe("content area", () => {
  it("body text in the bottom padding (footer band) is out of bounds", () => {
    expect(pageViolations(page([t("spilled card text", 50, 40)]), LAYOUT)).toEqual([expect.objectContaining({ kind: "out_of_bounds", edge: "bottom" })]);
  });
  it("body text above the top padding is out of bounds", () => {
    expect(pageViolations(page([t("too high", 50, A4.height - 20)]), LAYOUT)).toEqual([expect.objectContaining({ kind: "out_of_bounds", edge: "top" })]);
  });
  it("body text off the page is out of bounds", () => {
    expect(pageViolations(page([t("below page", 50, -30)]), LAYOUT)).toEqual([expect.objectContaining({ kind: "out_of_bounds", edge: "off_page" })]);
  });
  it("text exactly at the content edges (within tolerance) is fine", () => {
    expect(pageViolations(page([t("lowest line", 50, LAYOUT.paddingBottom - BOUNDARY_TOLERANCE + 0.5)]), LAYOUT)).toEqual([]);
    expect(pageViolations(page([t("top line", 50, A4.height - LAYOUT.paddingTop - 8)]), LAYOUT)).toEqual([]);
  });
  it("the fixed footer is exempt — and only the footer", () => {
    expect(isFooterText("ConvergePanel — Adaptive Research Export")).toBe(true);
    expect(isFooterText("Page 3 of 12")).toBe(true);
    expect(isFooterText("Page three")).toBe(false);
    expect(pageViolations(page([t("ConvergePanel — Adaptive Research Export", 44, 30), t("Page 1 of 2", 500, 30)]), LAYOUT)).toEqual([]);
  });
});

describe("completeness", () => {
  const pages = [page([t("intro #M001#", 50, 700), t("#M002# split", 50, 685)], 1), page([t("tail #M003#", 50, 700)], 2)];
  it("every marker found exactly once passes", () => {
    expect(documentViolations(pages, LAYOUT, ["#M001#", "#M002#", "#M003#"].map((marker) => ({ marker, count: 1 })))).toEqual([]);
  });
  it("a lost marker is a violation", () => {
    expect(documentViolations(pages, LAYOUT, [{ marker: "#M004#", count: 1 }])).toEqual([{ kind: "missing_marker", marker: "#M004#", expected: 1, found: 0 }]);
  });
  it("a duplicated marker is a violation", () => {
    const dup = [...pages, page([t("again #M001#", 50, 700)], 3)];
    expect(documentViolations(dup, LAYOUT, [{ marker: "#M001#", count: 1 }])).toEqual([{ kind: "missing_marker", marker: "#M001#", expected: 1, found: 2 }]);
  });
  it("document text joins pages and normalizes whitespace", () => {
    expect(documentText(pages)).toBe("intro #M001# #M002# split tail #M003#");
  });
});

describe("stranded headings", () => {
  const heading = (str: string, y: number) => t(str, 50, y, 80, 7.5);
  const body = (str: string, y: number) => t(str, 50, y, 300, 10);
  it("a non-final page ending with a heading is a violation", () => {
    const pages = [page([body("text", 700), heading("BASIS", 61)], 1), page([body("first bullet", 780)], 2)];
    expect(strandedHeadingViolations(pages)).toEqual([{ kind: "stranded_heading", pageNumber: 1, text: "BASIS" }]);
  });
  it("two stacked headings at a page bottom are a violation (the last line is still a heading)", () => {
    const pages = [page([body("text", 700), heading("CLAUDE · REQUESTED: X", 75), heading("SUMMARY", 62)], 1), page([body("x", 780)], 2)];
    expect(strandedHeadingViolations(pages)).toHaveLength(1);
  });
  it("a heading followed by at least one body line on its page is fine", () => {
    const pages = [page([heading("BASIS", 80), body("first bullet", 64)], 1), page([body("x", 780)], 2)];
    expect(strandedHeadingViolations(pages)).toEqual([]);
  });
  it("the footer never counts as the last line", () => {
    const pages = [page([heading("BASIS", 80), body("first bullet", 64), t("Page 1 of 2", 500, 26, 40, 8)], 1), page([body("x", 780)], 2)];
    expect(strandedHeadingViolations(pages)).toEqual([]);
  });
  it("the final page is exempt", () => {
    expect(strandedHeadingViolations([page([body("x", 700), heading("END", 100)], 1)])).toEqual([]);
  });
  it("a 9 pt in-card sub-label alone at a page bottom is stranded; body text that merely contains the word is not", () => {
    const sub = (str: string, y: number) => t(str, 50, y, 60, 9);
    expect(strandedHeadingViolations([page([body("x", 700), sub("Disagreement", 62)], 1), page([body("y", 780)], 2)])).toEqual([
      { kind: "stranded_heading", pageNumber: 1, text: "Disagreement" },
    ]);
    expect(strandedHeadingViolations([page([body("x", 700), sub("Disagreement remains on scope", 62)], 1), page([body("y", 780)], 2)])).toEqual([]);
  });
  it("heading size boundary: 8 pt labels are headings, 9 pt body is not", () => {
    expect(isHeadingItem(t("LABEL", 0, 0, 10, 8))).toBe(true);
    expect(isHeadingItem(t("body", 0, 0, 10, 9))).toBe(false);
  });
});

describe("reading order", () => {
  it("orders by page, then line top-down, then left to right within a line", () => {
    // Same line, but the right-hand run has the (slightly) higher baseline: only the x order puts it second.
    const pages = [page([t("#A002#", 300, 700.4), t("#A001#", 50, 700), t("#A003#", 50, 680)], 1), page([t("#A004#", 50, 780)], 2)];
    expect(readingLines(pages[0]).map((l) => l.map((i) => i.str))).toEqual([["#A001#", "#A002#"], ["#A003#"]]);
    expect(renderedMarkerSequence(pages)).toEqual(["#A001#", "#A002#", "#A003#", "#A004#"]);
  });
  it("matching composition order passes; a swap, a loss or an extra fails", () => {
    const pages = [page([t("a #A001# b #A002#", 50, 700), t("#A003#", 50, 680)])];
    expect(readingOrderViolations(pages, ["#A001#", "#A002#", "#A003#"])).toEqual([]);
    expect(readingOrderViolations(pages, ["#A002#", "#A001#", "#A003#"])).toHaveLength(1);
    expect(readingOrderViolations(pages, ["#A001#", "#A002#"])).toHaveLength(1);
    expect(readingOrderViolations(pages, ["#A001#", "#A002#", "#A003#", "#A004#"])).toHaveLength(1);
  });
  it("a marker that migrated ahead of an earlier section fails", () => {
    const pages = [page([t("#B003#", 50, 700), t("#B001#", 50, 680), t("#B002#", 50, 660)])];
    expect(readingOrderViolations(pages, ["#B001#", "#B002#", "#B003#"])).toEqual([
      { kind: "reading_order", expected: ["#B001#", "#B002#", "#B003#"], found: ["#B003#", "#B001#", "#B002#"] },
    ]);
  });
  it("body text that merely looks like the footer is still read (only exact footer strings are exempt)", () => {
    expect(renderedMarkerSequence([page([t("Page 1 of 2 #A001#", 50, 700)])])).toEqual(["#A001#"]);
  });
});

describe("lone bullet mark", () => {
  it("a line holding only a bullet mark is a violation", () => {
    expect(loneBulletViolations([page([t("body line", 50, 400), t("•", 50, 70, 5)], 1)])).toEqual([{ kind: "lone_bullet", pageNumber: 1 }]);
  });
  it("a mark beside its text on the same line is fine", () => {
    expect(loneBulletViolations([page([t("•", 50, 400, 5), t("bullet text", 60, 400)])])).toEqual([]);
  });
  it("a bullet character inside body text is not a lone mark", () => {
    expect(loneBulletViolations([page([t("a • b", 50, 400)])])).toEqual([]);
  });
});

describe("detached pair", () => {
  const pages = [page([t("Revenue #N001#", 50, 80), t("12 USD #N002#", 400, 80)], 1), page([t("Margin #N003#", 50, 780)], 2), page([t("5 pct #N004#", 400, 760)], 3)];
  it("a label and value on one page pass", () => {
    expect(detachedPairViolations(pages, [["#N001#", "#N002#"]])).toEqual([]);
  });
  it("a label and value on different pages fail, with both pages", () => {
    expect(detachedPairViolations(pages, [["#N003#", "#N004#"]])).toEqual([{ kind: "detached_pair", first: "#N003#", second: "#N004#", firstPage: 2, secondPage: 3 }]);
  });
  it("a missing half fails", () => {
    expect(detachedPairViolations(pages, [["#N001#", "#N999#"]])).toEqual([{ kind: "detached_pair", first: "#N001#", second: "#N999#", firstPage: 1, secondPage: null }]);
  });
});

describe("empty card fragment", () => {
  const box = (x0: number, x1: number, y0: number, y1: number): PdfShapeBox => ({ x0, x1, y0, y1 });
  const withShapes = (items: PdfTextItem[], shapes: PdfShapeBox[]): PdfPageText => ({ ...page(items), shapes });
  const firstLineY = 770;
  it("a card fill lying wholly above the page's first text line is an empty fragment", () => {
    const strip = box(44, 551, 781, 793.9);
    expect(emptyCardFragmentViolations([withShapes([t("continued text", 57, firstLineY)], [strip])], LAYOUT)).toEqual([{ kind: "empty_card_fragment", pageNumber: 1, box: strip }]);
  });
  it("a 1 pt border-only remainder is caught too", () => {
    expect(emptyCardFragmentViolations([withShapes([t("next card", 57, firstLineY)], [box(44, 551, 792.9, 793.9)])], LAYOUT)).toHaveLength(1);
  });
  it("a card fill that reaches down past the first text line holds content and is fine", () => {
    expect(emptyCardFragmentViolations([withShapes([t("card text", 57, firstLineY)], [box(44, 551, 600, 793.9)])], LAYOUT)).toEqual([]);
  });
  it("narrow shapes (marks, rule ends) and shapes in the header band are ignored", () => {
    const header = box(44, 551, A4.height - 20, A4.height - 10);
    expect(emptyCardFragmentViolations([withShapes([t("card text", 57, firstLineY)], [box(44, 44 + MIN_FRAGMENT_WIDTH - 1, 781, 793), header])], LAYOUT)).toEqual([]);
  });
  it("pages without extracted shapes are not judged", () => {
    expect(emptyCardFragmentViolations([page([t("card text", 57, firstLineY)])], LAYOUT)).toEqual([]);
  });
});

describe("card closing gap", () => {
  const box = (x0: number, x1: number, y0: number, y1: number): PdfShapeBox => ({ x0, x1, y0, y1 });
  const withShapes = (items: PdfTextItem[], shapes: PdfShapeBox[]): PdfPageText => ({ ...page(items), shapes });
  it("a card ending on its page with its edge against its last text has lost its closing padding", () => {
    const card = box(44, 551, 397.5, 600);
    expect(cardClosingGapViolations([withShapes([t("first line", 57, 580), t("last line", 57, 400)], [card])], LAYOUT)).toEqual([
      { kind: "card_closing_gap", pageNumber: 1, box: card, gap: 0 },
    ]);
  });
  it("the threshold is real: a 4 pt gap (a closing lost, only a row's padding left) is still a violation", () => {
    expect(cardClosingGapViolations([withShapes([t("last line", 57, 400)], [box(44, 551, 400 - 2.5 - 4, 600)])], LAYOUT)).toHaveLength(1);
  });
  it("a card that keeps its closing padding below its last text is fine", () => {
    expect(cardClosingGapViolations([withShapes([t("last line", 57, 400)], [box(44, 551, 400 - 2.5 - MIN_CARD_CLOSING_GAP, 600)])], LAYOUT)).toEqual([]);
  });
  it("a card split at the page bottom continues on the next page and is not judged", () => {
    expect(cardClosingGapViolations([withShapes([t("last line on page", 57, 60)], [box(44, 551, LAYOUT.paddingBottom, 600)])], LAYOUT)).toEqual([]);
  });
  it("a card's heading and body blocks are measured as one card", () => {
    const head = box(44, 551, 575, 600);
    const body = box(44, 551, 400, 575);
    expect(cardClosingGapViolations([withShapes([t("HEADING", 57, 580, 100, 7.5), t("body", 57, 450)], [head, body])], LAYOUT)).toEqual([]);
    expect(cardBoxes(withShapes([], [head, body]))).toEqual([box(44, 551, 400, 600)]);
  });
  it("a heading block above a 1 pt body (a card with no body content) is a card end without its closing padding", () => {
    // R4 MINOR 1: a failed model's card closed 4.6 pt under its label; the head was exempt for having a body below it.
    const head = box(44, 551, 223.5, 248.8);
    const body = box(44, 551, 222.5, 223.5);
    const v = cardClosingGapViolations([withShapes([t("CLAUDE · MODEL NOT RECORDED", 57, 229, 100, 7.5)], [head, body])], LAYOUT);
    expect(v).toEqual([{ kind: "card_closing_gap", pageNumber: 1, box: box(44, 551, 222.5, 248.8), gap: 4.6 }]);
  });
  it("narrow shapes (badges, marks) and pages without shapes are ignored", () => {
    expect(cardClosingGapViolations([withShapes([t("badge", 480, 700)], [box(470, 540, 698, 712)])], LAYOUT)).toEqual([]);
    expect(cardClosingGapViolations([page([t("text", 57, 400)])], LAYOUT)).toEqual([]);
  });
});

describe("stranded heading versus a complete label-only card", () => {
  const box = (x0: number, x1: number, y0: number, y1: number): PdfShapeBox => ({ x0, x1, y0, y1 });
  const at = (items: PdfTextItem[], shapes: PdfShapeBox[], pageNumber: number): PdfPageText => ({ ...page(items, pageNumber), shapes });
  const next = at([t("next page text", 57, 700)], [box(44, 551, 600, 780)], 2);
  it("a page ending on a label-only card closed with its padding is not a stranded heading", () => {
    const label = t("CLAUDE · MODEL NOT RECORDED", 57, 100, 100, 7.5);
    const card = box(44, 551, 100 - 1.9 - 4 - 12, 125);
    expect(strandedHeadingViolations([at([t("body", 57, 300), label], [box(44, 551, 280, 320), card], 1), next], LAYOUT)).toEqual([]);
  });
  it("a card heading block whose body moved to the next page is stranded (it ends at its label, without closing padding)", () => {
    const label = t("CLAUDE · MODEL NOT RECORDED", 57, 100, 100, 7.5);
    const head = box(44, 551, 100 - 1.9 - 4, 125);
    expect(strandedHeadingViolations([at([t("body", 57, 300), label], [box(44, 551, 280, 320), head], 1), next], LAYOUT)).toHaveLength(1);
  });
  it("a field label at the end of a card body that continues on the next page is stranded", () => {
    const label = t("METRICS", 57, 70, 60, 7.5);
    expect(strandedHeadingViolations([at([t("body", 57, 300), label], [box(44, 551, LAYOUT.paddingBottom, 320)], 1), next], LAYOUT)).toHaveLength(1);
  });
  it("a label-only card that ends flush at the page bottom is complete when the next page opens with new heading content", () => {
    const label = t("CLAUDE · MODEL NOT RECORDED", 57, 75, 100, 7.5);
    const card = box(44, 551, 56.5, 94.7);
    const nextCard = at([t("GROK · MODEL NOT RECORDED", 57, 780, 100, 7.5), t("text", 57, 760)], [box(44, 551, 700, 794)], 2);
    expect(strandedHeadingViolations([at([t("body", 57, 300), label], [box(44, 551, 280, 320), card], 1), nextCard], LAYOUT)).toEqual([]);
  });
  it("a heading at the bottom of a card that reaches the page bottom is stranded when the next page opens with its body text", () => {
    const label = t("METRICS", 57, 75, 60, 7.5);
    const continued = at([t("value text", 57, 780), t("more", 57, 765)], [box(44, 551, 700, 794)], 2);
    expect(strandedHeadingViolations([at([t("body", 57, 300), label], [box(44, 551, 56.5, 320)], 1), continued], LAYOUT)).toHaveLength(1);
  });
  it("without shapes or layout the rule is unchanged", () => {
    const label = t("CLAUDE · MODEL NOT RECORDED", 57, 100, 100, 7.5);
    expect(strandedHeadingViolations([page([t("body", 57, 300), label]), page([t("x", 57, 700)], 2)])).toHaveLength(1);
  });
});
