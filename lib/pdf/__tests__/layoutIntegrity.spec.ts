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
  pageViolations,
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
