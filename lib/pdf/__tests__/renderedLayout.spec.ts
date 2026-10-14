/**
 * PDF export pagination (PR B) — REAL rendered-PDF spatial regression.
 *
 * Jest cannot load the ESM-only @react-pdf/renderer, so this spec runs
 * scripts/verify-pdf-layout.mjs in a child Node process. That script renders
 * every fixture in lib/pdf/__fixtures__/layoutFixtures.ts with the production
 * renderer, extracts positioned text with pdfjs-dist and applies
 * lib/pdf/layoutIntegrity.ts: no overlapping text, nothing outside the page
 * content area, every content marker present exactly once, and the expected
 * minimum page count. Before this fix the three long fixtures failed with
 * ~1,500 overlap / out-of-bounds / lost-marker violations.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";

type Report = { canary: { detected: boolean; violationCounts: Record<string, number> }; report: Array<{ fixture: string; pages: number; markers: number; violationCounts: Record<string, number>; sampleViolations: unknown[] }> };

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

it("the check is not blind: a known-bad non-breaking block is reported", () => {
  expect(report.canary.detected).toBe(true);
  expect(Object.values(report.canary.violationCounts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
});

it("renders every fixture", () => {
  expect(report.report.map((r) => r.fixture).sort()).toEqual(pdfLayoutFixtures().map((f) => f.name).sort());
});

describe.each(pdfLayoutFixtures().map((f) => [f.name, f.minPages, f.markers.length] as const))("%s", (name, minPages, markerCount) => {
  const row = () => report.report.find((r) => r.fixture === name)!;
  it("has no overlapping, out-of-bounds or lost text", () => {
    expect({ counts: row().violationCounts, sample: row().sampleViolations }).toEqual({ counts: {}, sample: [] });
  });
  it(`paginates to at least ${minPages} page(s)`, () => {
    expect(row().pages).toBeGreaterThanOrEqual(minPages);
  });
  it("checked every content marker", () => {
    expect(row().markers).toBe(markerCount);
  });
});
