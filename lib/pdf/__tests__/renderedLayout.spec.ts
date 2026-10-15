/**
 * PDF export pagination (PR B) — REAL rendered-PDF spatial regression.
 *
 * Jest cannot load the ESM-only @react-pdf/renderer, so this spec runs
 * scripts/verify-pdf-layout.mjs in a child Node process. That script renders
 * every fixture in lib/pdf/__fixtures__/layoutFixtures.ts (and a known-bad
 * canary) with the production renderer and extracts positioned text with
 * pdfjs-dist. The verdict below is RECOMPUTED here from that raw text
 * geometry with lib/pdf/layoutIntegrity.ts — never taken from the script's
 * own summary — and the expected reading order is derived here from the
 * export RECORD's own data order (synthesis, then each model in order, each
 * field in schema order; receipt sections in document order), independent
 * of both the composer and the PDF:
 *  - the canary (two consecutive over-tall non-breaking cards) MUST fail;
 *  - every fixture: no overlapping text; nothing outside the page content
 *    area (footer band, off page); every content marker exactly once; markers
 *    in composition order; no non-final page ending with a heading; no bullet
 *    mark without its text; every metric's label and value on one page (the
 *    pairs derived HERE from the record); no empty card fragment (from the
 *    painted shapes); at least the fixture's minimum page count;
 *  - a bullet text or metric label continued onto later pages keeps its
 *    indent.
 * The fixtures include single text units taller than a page and heading
 * boundary sweeps (R1 MAJOR 1 and 2, MINOR 3), three-line field values and
 * "Disagreement" sub-label grids, page-long verdict texts, the R2 reviewer's
 * reproduction (R2 MAJOR, MINOR 2, MINOR 3), and the R3 reviewer's
 * reproductions with bullet, metric and card-closing grids (R3 MAJOR,
 * MINOR 1).
 */
jest.mock("@react-pdf/renderer", () => ({
  Document: "DOCUMENT",
  Page: "PAGE",
  View: "VIEW",
  Text: "TEXT",
  StyleSheet: { create: (styles: unknown) => styles },
  renderToBuffer: jest.fn(),
}));

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import type { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import {
  detachedPairViolations,
  documentViolations,
  emptyCardFragmentViolations,
  loneBulletViolations,
  readingOrderViolations,
  strandedHeadingViolations,
  type PdfPageText,
} from "@/lib/pdf/layoutIntegrity";
import { extractPdfElementText } from "./testUtils";

type Row = { fixture: string; pages: number; pageText: PdfPageText[] };
type Report = { canary: { detected: boolean; violationCounts: Record<string, number>; pageText: PdfPageText[] }; report: Row[] };

const LAYOUT = { paddingTop: 48, paddingBottom: 56 };
const CANARY_MARKERS = Array.from({ length: 90 }, (_, i) => `#C${String(i + 1).padStart(3, "0")}#`);

const MARKER = /#[A-Z]+\d{3}#/g;

/**
 * The semantic order a reader must meet the content in, from the record's data
 * alone: JSON serialization keeps array order and object key order, so the
 * markers of this projection come out in document order.
 */
function canonicalMarkerOrder(record: AdaptiveResearchExportV1): string[] {
  const snap = record.reportSnapshot as unknown as Record<string, any>;
  let projection: unknown[];
  if (record.schemaFamily === "legacy") {
    const legacy = snap.legacy;
    const synthesis = legacy.synthesisReport;
    const vc = synthesis?.verdictCard;
    const fields = SCHEMA_REGISTRY[legacy.schemaId as keyof typeof SCHEMA_REGISTRY].fields;
    projection = [
      synthesis?.unifiedAnswer,
      vc?.topConsensus,
      vc?.keyDisagreement,
      vc?.disagreementDetail,
      vc?.caveat,
      (legacy.modelResponses ?? []).map((r: { data?: Record<string, unknown> }) => fields.map((f) => r.data?.[f.key])),
    ];
  } else {
    const m2 = snap.milestone2;
    const r = m2.decisionReceipt;
    projection = [r?.conclusion, r?.basis, r?.assumptions, r?.uncertainties, r?.limitations, r?.sources, m2.result?.tradeoffs, m2.result?.bestUseRecommendations];
  }
  return JSON.stringify(projection).match(MARKER) ?? [];
}

/** The reviewed bound below which a metric renders as a label/value row (beyond it: one "label — value" paragraph). */
const METRIC_ROW_VALUE_MAX_CHARS = 32;

/** Every metric row's [label marker, value marker], from the record's own data (legacy model responses). */
function metricPairsFromRecord(record: AdaptiveResearchExportV1): Array<[string, string]> {
  const snap = record.reportSnapshot as unknown as Record<string, any>;
  if (record.schemaFamily !== "legacy") return [];
  const fields = SCHEMA_REGISTRY[snap.legacy.schemaId as keyof typeof SCHEMA_REGISTRY].fields.filter((f) => f.type === "metric[]");
  const pairs: Array<[string, string]> = [];
  for (const r of snap.legacy.modelResponses ?? []) {
    for (const f of fields) {
      for (const item of (r.data?.[f.key] ?? []) as Array<{ label?: unknown; value?: unknown; unit?: unknown }>) {
        const valueText = item.value != null ? `${item.value} ${item.unit ?? ""}`.trim() : "—";
        const a = String(item.label ?? "").match(MARKER)?.[0];
        const b = valueText.match(MARKER)?.[0];
        if (a && b && valueText.length <= METRIC_ROW_VALUE_MAX_CHARS) pairs.push([a, b]);
      }
    }
  }
  return pairs;
}

/** The distinct start x of every text run carrying one of `markers` — one value when the text keeps its indent. */
function runStarts(pages: PdfPageText[], markers: string[]): number[] {
  const xs = new Set<string>();
  for (const page of pages) for (const item of page.items) if (markers.some((m) => item.str.includes(m))) xs.add(item.x.toFixed(2));
  return [...xs].map(Number);
}

let report: Report;
beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp-pdf-layout-spec-"));
  try {
    const out = path.join(dir, "report.json");
    execFileSync(process.execPath, [path.join(process.cwd(), "scripts/verify-pdf-layout.mjs"), "--json", out, "--allow-fail"], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 480_000,
    });
    report = JSON.parse(readFileSync(out, "utf8")) as Report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);

it("the check is not blind: the known-bad canary has overlapping text, and the script reports it", () => {
  const v = documentViolations(report.canary.pageText, LAYOUT, CANARY_MARKERS.map((marker) => ({ marker, count: 1 })));
  expect(v.filter((x) => x.kind === "overlap").length).toBeGreaterThan(0);
  // The CLI (npm run verify:pdf-layout) exits on its own verdict — it must agree with the independent one.
  expect(report.canary.violationCounts.overlap).toBe(v.filter((x) => x.kind === "overlap").length);
  expect(report.canary.detected).toBe(true);
});

it("renders every fixture", () => {
  expect(report.report.map((r) => r.fixture).sort()).toEqual(pdfLayoutFixtures().map((f) => f.name).sort());
});

describe.each(pdfLayoutFixtures().map((f) => [f.name, f] as const))("%s", (name, fixture) => {
  const row = () => report.report.find((r) => r.fixture === name)!;
  it("extracted real text on every page", () => {
    expect(row().pageText.length).toBe(row().pages);
    for (const p of row().pageText) expect(p.items.some((i) => i.str.trim().length > 0)).toBe(true);
  });
  it("has no overlapping, out-of-bounds or lost text (recomputed from raw geometry)", () => {
    expect(documentViolations(row().pageText, LAYOUT, fixture.markers.map((marker) => ({ marker, count: 1 })))).toEqual([]);
  });
  it("keeps every heading with its content (no non-final page ends with a heading)", () => {
    expect(strandedHeadingViolations(row().pageText)).toEqual([]);
  });
  it("renders content markers in the record's semantic order (and composes them in that order)", () => {
    const canonical = canonicalMarkerOrder(fixture.record);
    expect([...canonical].sort()).toEqual([...fixture.markers].sort());
    expect(extractPdfElementText(AdaptiveResearchDocument({ record: fixture.record })).match(MARKER) ?? []).toEqual(canonical);
    expect(readingOrderViolations(row().pageText, canonical)).toEqual([]);
  });
  it("leaves no bullet mark without its text, no metric value apart from its label, and no empty card fragment", () => {
    expect(loneBulletViolations(row().pageText)).toEqual([]);
    expect(detachedPairViolations(row().pageText, metricPairsFromRecord(fixture.record))).toEqual([]);
    expect(emptyCardFragmentViolations(row().pageText, LAYOUT)).toEqual([]);
  });
  it(`paginates to at least ${fixture.minPages} page(s)`, () => {
    expect(row().pages).toBeGreaterThanOrEqual(fixture.minPages);
  });
});

it("the pair and fragment rules are exercised: many metric pairs, and painted card shapes on every fixture page", () => {
  const pairs = pdfLayoutFixtures().reduce((n, f) => n + metricPairsFromRecord(f.record).length, 0);
  expect(pairs).toBeGreaterThan(1000);
  for (const r of report.report) for (const p of r.pageText) expect((p.shapes ?? []).length).toBeGreaterThan(0);
});

it("a bullet text continued over pages keeps its indent (its mark is not repeated)", () => {
  const fixture = pdfLayoutFixtures().find((f) => f.name === "single-text-over-page-milestone2")!;
  const bullet = (fixture.record.reportSnapshot as unknown as { milestone2: { decisionReceipt: { basis: string[] } } }).milestone2.decisionReceipt.basis[0];
  const row = report.report.find((r) => r.fixture === fixture.name)!;
  const markers = bullet.match(MARKER)!;
  const pages = new Set(row.pageText.filter((p) => p.items.some((i) => markers.some((m) => i.str.includes(m)))).map((p) => p.pageNumber));
  expect(pages.size).toBeGreaterThan(1);
  expect(runStarts(row.pageText, markers)).toHaveLength(1);
});

it("a metric label continued over pages keeps its indent", () => {
  // page-long-metric-label: markers throughout the label. metric-row-extremes: a page-long label of "W" words (one
  // marker) — every W-word run after the label's first page is a continuation and must start at the label's x.
  const fixture = pdfLayoutFixtures().find((f) => f.name === "page-long-metric-label")!;
  const metrics = (fixture.record.reportSnapshot as unknown as { legacy: { modelResponses: Array<{ data: { metrics: Array<{ label: string }> } }> } }).legacy.modelResponses[0].data.metrics;
  const row = report.report.find((r) => r.fixture === fixture.name)!;
  const markers = metrics[0].label.match(MARKER)!;
  const pages = new Set(row.pageText.filter((p) => p.items.some((i) => markers.some((m) => i.str.includes(m)))).map((p) => p.pageNumber));
  expect(pages.size).toBeGreaterThan(1);
  expect(runStarts(row.pageText, markers)).toHaveLength(1);

  const extremes = report.report.find((r) => r.fixture === "metric-row-extremes")!;
  const firstMarker = (pdfLayoutFixtures().find((f) => f.name === "metric-row-extremes")!.record.reportSnapshot as unknown as {
    legacy: { modelResponses: Array<{ data: { metrics: Array<{ label: string }> } }> };
  }).legacy.modelResponses[0].data.metrics[0].label.match(MARKER)![0];
  const start = extremes.pageText.find((p) => p.items.some((i) => i.str.includes(firstMarker)))!;
  const labelX = start.items.find((i) => i.str.includes(firstMarker))!.x;
  const continuation = extremes.pageText.filter((p) => p.pageNumber > start.pageNumber).flatMap((p) => p.items.filter((i) => /^W[W ]*$/.test(i.str.trim())));
  expect(continuation.length).toBeGreaterThan(20);
  expect(new Set(continuation.map((i) => i.x.toFixed(2)))).toEqual(new Set([labelX.toFixed(2)]));
});
