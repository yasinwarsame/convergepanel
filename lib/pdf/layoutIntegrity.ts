/**
 * Adaptive Research Export — rendered-PDF layout integrity checks.
 *
 * Pure geometry over text items extracted from a REAL rendered PDF (see
 * `scripts/verify-pdf-layout.mjs`, which renders with the unmocked
 * `@react-pdf/renderer` and extracts positioned text with pdfjs). Jest cannot
 * load the ESM-only renderer, so the rendering lives in that script; the
 * rules live here so they are unit-tested and shared.
 *
 * A page passes when:
 *  - no two body text items overlap (text drawn on top of other text — the
 *    page-2 card collision seen in Production exports);
 *  - no body text is drawn outside the page's content area (above the top
 *    padding, below the bottom padding, i.e. into the footer band, or off the
 *    page) — the signature of an over-tall non-breaking block;
 * and the document passes when every expected marker string appears in the
 * extracted text exactly as often as expected (nothing silently truncated or
 * lost when content paginates).
 *
 * Coordinates are PDF user space: origin bottom-left, y up, in points.
 */

export interface PdfTextItem {
  str: string;
  /** Left edge of the glyph run. */
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  /** Font size (pdfjs reports the run height as the font size). */
  height: number;
}

/** Bounding box of one FILLED vector shape (card backgrounds, rules drawn as fills), PDF user space. */
export interface PdfShapeBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PdfPageText {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
  /** Painted vector shapes (card borders and backgrounds, rules). Absent when not extracted. */
  shapes?: PdfShapeBox[];
}

export interface PdfLayoutBox {
  /** Content area insets, in points: everything except the fixed footer must lie inside. */
  paddingTop: number;
  paddingBottom: number;
}

export type PdfLayoutViolation =
  | { kind: "overlap"; pageNumber: number; a: string; b: string; overlapRatio: number }
  | { kind: "out_of_bounds"; pageNumber: number; text: string; edge: "top" | "bottom" | "off_page" }
  | { kind: "missing_marker"; marker: string; expected: number; found: number }
  | { kind: "stranded_heading"; pageNumber: number; text: string }
  | { kind: "reading_order"; expected: string[]; found: string[] }
  | { kind: "lone_bullet"; pageNumber: number }
  | { kind: "detached_pair"; first: string; second: string; firstPage: number | null; secondPage: number | null }
  | { kind: "empty_card_fragment"; pageNumber: number; box: PdfShapeBox };

/** Text the fixed page footer draws inside the bottom padding by design. */
export function isFooterText(str: string): boolean {
  const s = str.trim();
  return s === "ConvergePanel — Adaptive Research Export" || /^Page \d+ of \d+$/.test(s);
}

/** Visual box of a glyph run: from the descender (≈ 0.25 em below the baseline) to the ascender (≈ 0.8 em above it). */
function box(item: PdfTextItem): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: item.x, x1: item.x + item.width, y0: item.y - 0.25 * item.height, y1: item.y + 0.8 * item.height };
}

function intersectionArea(a: ReturnType<typeof box>, b: ReturnType<typeof box>): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Overlap tolerance: adjacent runs on one line touch, and descenders brush the next line's ascenders; real collisions cover a large share of a glyph box. */
export const OVERLAP_RATIO_THRESHOLD = 0.3;
/** Boundary tolerance in points (sub-point float noise and glyph-box approximation). */
export const BOUNDARY_TOLERANCE = 2;

export function pageViolations(page: PdfPageText, layout: PdfLayoutBox): PdfLayoutViolation[] {
  const out: PdfLayoutViolation[] = [];
  const body = page.items.filter((i) => i.str.trim().length > 0 && i.width > 0 && !isFooterText(i.str));

  for (const item of body) {
    const b = box(item);
    if (b.y1 < 0 || b.y0 > page.height || b.x1 < 0 || b.x0 > page.width) {
      out.push({ kind: "out_of_bounds", pageNumber: page.pageNumber, text: item.str, edge: "off_page" });
    } else if (item.y < layout.paddingBottom - BOUNDARY_TOLERANCE) {
      out.push({ kind: "out_of_bounds", pageNumber: page.pageNumber, text: item.str, edge: "bottom" });
    } else if (b.y1 > page.height - layout.paddingTop + BOUNDARY_TOLERANCE) {
      out.push({ kind: "out_of_bounds", pageNumber: page.pageNumber, text: item.str, edge: "top" });
    }
  }

  const boxes = body.map((item) => ({ item, b: box(item) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const area = intersectionArea(boxes[i].b, boxes[j].b);
      if (area === 0) continue;
      const smaller = Math.min(
        (boxes[i].b.x1 - boxes[i].b.x0) * (boxes[i].b.y1 - boxes[i].b.y0),
        (boxes[j].b.x1 - boxes[j].b.x0) * (boxes[j].b.y1 - boxes[j].b.y0)
      );
      const ratio = smaller > 0 ? area / smaller : 0;
      if (ratio > OVERLAP_RATIO_THRESHOLD) {
        out.push({ kind: "overlap", pageNumber: page.pageNumber, a: boxes[i].item.str, b: boxes[j].item.str, overlapRatio: Math.round(ratio * 100) / 100 });
      }
    }
  }
  return out;
}

/** Whitespace-normalized concatenation of every page's text, in reading order as extracted. */
export function documentText(pages: PdfPageText[]): string {
  return pages
    .map((p) => p.items.map((i) => i.str).join(" "))
    .join(" ")
    .replace(/\s+/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

export function documentViolations(
  pages: PdfPageText[],
  layout: PdfLayoutBox,
  expectedMarkers: ReadonlyArray<{ marker: string; count: number }>
): PdfLayoutViolation[] {
  const out = pages.flatMap((p) => pageViolations(p, layout));
  const text = documentText(pages);
  for (const { marker, count } of expectedMarkers) {
    const found = countOccurrences(text, marker);
    if (found !== count) out.push({ kind: "missing_marker", marker, expected: count, found });
  }
  return out;
}

// ─── Headings and reading order ──────────────────────────────────────────

/**
 * Heading glyph size ceiling. Section labels are 8 pt and field / model labels
 * 7.5 pt (lib/pdf/theme.ts); body text is ≥ 9 pt. The 9 pt in-card
 * sub-labels are recognised by text (SUB_LABEL_TEXTS). The only other text at
 * or below 8 pt sits inside the always-unbroken cover header and status
 * summary, which are always followed by body text on their page.
 */
export const HEADING_MAX_FONT_SIZE = 8.05;
/** Runs whose baselines differ by at most this much (points) share a line. */
export const SAME_LINE_TOLERANCE = 1;

function bodyItems(page: PdfPageText): PdfTextItem[] {
  return page.items.filter((i) => i.str.trim().length > 0 && !isFooterText(i.str));
}

/** Body text grouped into lines, top to bottom, each line's runs left to right. */
export function readingLines(page: PdfPageText): PdfTextItem[][] {
  const items = [...bodyItems(page)].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];
  for (const item of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].y - item.y) <= SAME_LINE_TOLERANCE) line.push(item);
    else lines.push([item]);
  }
  for (const line of lines) line.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * In-card sub-labels drawn at body-adjacent size (9 pt muted), which the size
 * rule alone cannot tell from body text. A run whose ENTIRE text is one of
 * these is a heading.
 */
export const SUB_LABEL_TEXTS: readonly string[] = ["Agreement", "Disagreement"];

export function isHeadingItem(item: PdfTextItem): boolean {
  return item.height <= HEADING_MAX_FONT_SIZE || SUB_LABEL_TEXTS.includes(item.str.trim());
}

/**
 * A non-final page must not END with headings: its last body line may not
 * consist only of heading runs — heading-sized labels or in-card sub-labels —
 * whose content starts on the next page. The final page is exempt.
 */
export function strandedHeadingViolations(pages: PdfPageText[]): PdfLayoutViolation[] {
  const out: PdfLayoutViolation[] = [];
  pages.forEach((page, idx) => {
    if (idx === pages.length - 1) return;
    const lines = readingLines(page);
    const last = lines[lines.length - 1];
    if (last && last.every(isHeadingItem)) out.push({ kind: "stranded_heading", pageNumber: page.pageNumber, text: last.map((i) => i.str).join(" ") });
  });
  return out;
}

/** Every `#Xnnn#`-style content marker in rendered reading order (page, then line top-down, then left-right). */
export function renderedMarkerSequence(pages: PdfPageText[], markerPattern: RegExp = /#[A-Z]+\d{3}#/g): string[] {
  const seq: string[] = [];
  for (const page of pages) {
    const text = readingLines(page)
      .map((line) => line.map((i) => i.str).join(" "))
      .join("\n");
    for (const m of text.matchAll(new RegExp(markerPattern.source, "g"))) seq.push(m[0]);
  }
  return seq;
}

export function readingOrderViolations(pages: PdfPageText[], compositionOrder: readonly string[]): PdfLayoutViolation[] {
  const found = renderedMarkerSequence(pages);
  const expected = [...compositionOrder];
  return found.length === expected.length && found.every((m, i) => m === expected[i]) ? [] : [{ kind: "reading_order", expected, found }];
}

// ─── Atomic pairs and card fragments (R3) ────────────────────────────────

/** A bullet mark is a separate run beside its text: a body line that is ONLY marks is a mark left without its text. */
export function loneBulletViolations(pages: PdfPageText[]): PdfLayoutViolation[] {
  const out: PdfLayoutViolation[] = [];
  for (const page of pages) {
    for (const line of readingLines(page)) {
      if (line.every((i) => i.str.trim() === "•")) out.push({ kind: "lone_bullet", pageNumber: page.pageNumber });
    }
  }
  return out;
}

/** Each pair of markers (e.g. a metric's label and value) must be rendered on the same page. */
export function detachedPairViolations(pages: PdfPageText[], pairs: ReadonlyArray<readonly [string, string]>): PdfLayoutViolation[] {
  const pageOf = (marker: string): number | null => {
    for (const page of pages) if (page.items.some((i) => i.str.includes(marker))) return page.pageNumber;
    return null;
  };
  const out: PdfLayoutViolation[] = [];
  for (const [first, second] of pairs) {
    const a = pageOf(first);
    const b = pageOf(second);
    if (a === null || b === null || a !== b) out.push({ kind: "detached_pair", first, second, firstPage: a, secondPage: b });
  }
  return out;
}

/** Shapes narrower than this (points) are not card fragments (glyph-sized marks, hairlines' ends). */
export const MIN_FRAGMENT_WIDTH = 20;

/**
 * A painted shape lying ENTIRELY above the first line of body text on its
 * page, inside the content area, is a card fragment with no content: the
 * bottom padding and border of a card whose text ended on the previous page,
 * carried over alone. Real card tops (headings, continuations) always extend
 * down past the first text line they hold.
 */
export function emptyCardFragmentViolations(pages: PdfPageText[], layout: PdfLayoutBox): PdfLayoutViolation[] {
  const out: PdfLayoutViolation[] = [];
  for (const page of pages) {
    if (!page.shapes) continue;
    const body = page.items.filter((i) => i.str.trim().length > 0 && !isFooterText(i.str));
    if (body.length === 0) continue;
    const firstTextTop = Math.max(...body.map((i) => i.y + 0.8 * i.height));
    const contentTop = page.height - layout.paddingTop + BOUNDARY_TOLERANCE;
    for (const box of page.shapes) {
      if (box.x1 - box.x0 < MIN_FRAGMENT_WIDTH) continue;
      if (box.y0 > firstTextTop + BOUNDARY_TOLERANCE && box.y1 <= contentTop) out.push({ kind: "empty_card_fragment", pageNumber: page.pageNumber, box });
    }
  }
  return out;
}
