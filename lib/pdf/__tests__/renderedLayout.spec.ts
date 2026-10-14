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
 *    in composition order; no non-final page ending with a heading; at least
 *    the fixture's minimum page count.
 * The fixtures include single text units taller than a page and heading
 * boundary sweeps (R1 MAJOR 1 and 2, MINOR 3), three-line field values and
 * "Disagreement" sub-label grids, page-long verdict texts, and the R2
 * reviewer's reproduction (R2 MAJOR, MINOR 2, MINOR 3).
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
import { documentViolations, readingOrderViolations, strandedHeadingViolations, type PdfPageText } from "@/lib/pdf/layoutIntegrity";
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
  it(`paginates to at least ${fixture.minPages} page(s)`, () => {
    expect(row().pages).toBeGreaterThanOrEqual(fixture.minPages);
  });
});
