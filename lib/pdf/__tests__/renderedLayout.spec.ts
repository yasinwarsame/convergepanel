/**
 * PDF export pagination (PR B) — REAL rendered-PDF spatial regression.
 *
 * Jest cannot load the ESM-only @react-pdf/renderer, so this spec runs
 * scripts/verify-pdf-layout.mjs in a child Node process. That script renders
 * every fixture in lib/pdf/__fixtures__/layoutFixtures.ts (and a known-bad
 * canary) with the production renderer and extracts positioned text with
 * pdfjs-dist. The verdict below is RECOMPUTED here from that raw text
 * geometry with lib/pdf/layoutIntegrity.ts — never taken from the script's
 * own summary — so a script that stopped checking could not pass:
 *  - the canary (two consecutive over-tall non-breaking cards) MUST fail;
 *  - every fixture: no overlapping text, nothing outside the page content
 *    area, every content marker exactly once, at least its minimum pages.
 * At baseline 67fea986 the three long fixtures failed with ~1,500 overlap /
 * out-of-bounds / lost-text violations.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
import { documentViolations, type PdfPageText } from "@/lib/pdf/layoutIntegrity";

type Row = { fixture: string; pages: number; pageText: PdfPageText[] };
type Report = { canary: { pageText: PdfPageText[] }; report: Row[] };

const LAYOUT = { paddingTop: 48, paddingBottom: 56 };
const CANARY_MARKERS = Array.from({ length: 90 }, (_, i) => `#C${String(i + 1).padStart(3, "0")}#`);

let report: Report;
beforeAll(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "cp-pdf-layout-spec-"));
  try {
    const out = path.join(dir, "report.json");
    execFileSync(process.execPath, [path.join(process.cwd(), "scripts/verify-pdf-layout.mjs"), "--json", out, "--allow-fail"], {
      cwd: process.cwd(),
      stdio: "pipe",
      timeout: 90_000,
    });
    report = JSON.parse(readFileSync(out, "utf8")) as Report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

it("the check is not blind: the known-bad canary has overlapping text", () => {
  const v = documentViolations(report.canary.pageText, LAYOUT, CANARY_MARKERS.map((marker) => ({ marker, count: 1 })));
  expect(v.filter((x) => x.kind === "overlap").length).toBeGreaterThan(0);
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
  it(`paginates to at least ${fixture.minPages} page(s)`, () => {
    expect(row().pages).toBeGreaterThanOrEqual(fixture.minPages);
  });
});
