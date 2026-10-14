/**
 * PDF export pagination (PR B) — the pure layout rules applied to real
 * rendered PDFs by scripts/verify-pdf-layout.mjs. Each rule is shown to fire
 * on the defect shape and to stay quiet on ordinary layout.
 */
import {
  BOUNDARY_TOLERANCE,
  documentText,
  documentViolations,
  isFooterText,
  isHeadingItem,
  pageViolations,
  readingLines,
  readingOrderViolations,
  renderedMarkerSequence,
  strandedHeadingViolations,
  type PdfPageText,
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
  it("heading size boundary: 8 pt labels are headings, 9 pt body is not", () => {
    expect(isHeadingItem(t("LABEL", 0, 0, 10, 8))).toBe(true);
    expect(isHeadingItem(t("body", 0, 0, 10, 9))).toBe(false);
  });
});

describe("reading order", () => {
  it("orders by page, then line top-down, then left to right within a line", () => {
    const pages = [page([t("#A002#", 300, 700), t("#A001#", 50, 700.4), t("#A003#", 50, 680)], 1), page([t("#A004#", 50, 780)], 2)];
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
