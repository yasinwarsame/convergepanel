#!/usr/bin/env node
/**
 * Rendered-PDF layout regression check for the Adaptive Research Export.
 *
 * Renders every fixture in lib/pdf/__fixtures__/layoutFixtures.ts with the
 * REAL, unmocked @react-pdf/renderer (the production renderer — Jest cannot
 * load it, it is ESM-only), extracts positioned text with pdfjs-dist, and
 * applies the rules in lib/pdf/layoutIntegrity.ts:
 *   - no overlapping body text on any page;
 *   - no body text outside the page content area (the footer band, off page);
 *   - every content marker present exactly once (nothing lost or truncated);
 *   - the fixture occupies at least its expected page count.
 * It first renders a known-bad canary (lib/pdf/__fixtures__/layoutCanary.tsx)
 * and fails unless the check reports violations for it, so a broken
 * extractor or rule can never pass silently.
 *
 * Usage: node scripts/verify-pdf-layout.mjs [--json <out.json>] [--allow-fail] [--pdf-dir <dir>]
 * Exit code 1 on any violation unless --allow-fail (used to record baselines).
 * Deterministic: no network, no fonts beyond react-pdf's built-in Helvetica.
 */
import { build } from "esbuild";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const workDir = mkdtempSync(path.join(tmpdir(), "cp-pdf-layout-"));
try {
  const entry = `
    export { AdaptiveResearchDocument } from "@/lib/pdf/AdaptiveResearchDocument";
    export { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
    export { documentViolations } from "@/lib/pdf/layoutIntegrity";
    export { LayoutCanaryDocument, CANARY_MARKERS } from "@/lib/pdf/__fixtures__/layoutCanary";
  `;
  const outfile = path.join(workDir, "bundle.mjs");
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    outfile,
    tsconfig: path.join(ROOT, "tsconfig.json"),
    external: ["react", "react/jsx-runtime", "@react-pdf/renderer"],
    nodePaths: [path.join(ROOT, "node_modules")],
    logLevel: "error",
  });
  // The bundle imports react / @react-pdf/renderer by bare name; resolve them from the repo.
  const { createRequire } = await import("module");
  const req = createRequire(path.join(ROOT, "package.json"));
  const bundleSrc = (await import("fs")).readFileSync(outfile, "utf8")
    .replaceAll('from "react/jsx-runtime"', `from ${JSON.stringify(pathToFileURL(req.resolve("react/jsx-runtime")).href)}`)
    .replaceAll('from "react"', `from ${JSON.stringify(pathToFileURL(req.resolve("react")).href)}`)
    .replaceAll('from "@react-pdf/renderer"', `from ${JSON.stringify(pathToFileURL(req.resolve("@react-pdf/renderer")).href)}`);
  writeFileSync(outfile, bundleSrc);

  const mod = await import(pathToFileURL(outfile).href);
  const { renderToBuffer } = await import(pathToFileURL(req.resolve("@react-pdf/renderer")).href);
  const React = (await import(pathToFileURL(req.resolve("react")).href)).default;
  const pdfjs = await import(pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);

  const LAYOUT = { paddingTop: 48, paddingBottom: 56 };
  const pdfDir = opt("--pdf-dir");
  if (pdfDir) mkdirSync(pdfDir, { recursive: true });
  const report = [];
  let failed = false;

  async function extract(bytes) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const [, , width, height] = page.view;
      const content = await page.getTextContent();
      pages.push({
        pageNumber: p,
        width,
        height,
        items: content.items
          .filter((it) => typeof it.str === "string")
          .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, height: it.height })),
      });
    }
    return { doc, pages };
  }

  /** The ONE check, shared by the canary and every fixture: render → extract → rules. */
  async function check(element, markers, minPages) {
    const bytes = await renderToBuffer(element);
    const { doc, pages } = await extract(bytes);
    const violations = mod.documentViolations(pages, LAYOUT, markers.map((marker) => ({ marker, count: 1 })));
    if (doc.numPages < minPages) violations.push({ kind: "too_few_pages", expectedAtLeast: minPages, found: doc.numPages });
    const counts = violations.reduce((acc, v) => ({ ...acc, [v.kind]: (acc[v.kind] ?? 0) + 1 }), {});
    return { bytes, pages: doc.numPages, pageText: pages, violations, counts };
  }

  // Canary: the check must SEE the known defect, or nothing below can be trusted.
  const canaryResult = await check(React.createElement(mod.LayoutCanaryDocument), mod.CANARY_MARKERS, 1);
  const canaryCounts = canaryResult.counts;
  const canaryPageText = canaryResult.pageText;
  const canaryDetected = canaryResult.violations.length > 0;
  if (!canaryDetected) failed = true;
  console.log(`${canaryDetected ? "PASS" : "FAIL"} canary (known-bad layout must be detected): ${canaryResult.violations.length} violations ${JSON.stringify(canaryCounts)}`);

  for (const fixture of mod.pdfLayoutFixtures()) {
    const { bytes, pages: numPages, pageText, violations, counts } = await check(
      React.createElement(mod.AdaptiveResearchDocument, { record: fixture.record }),
      fixture.markers,
      fixture.minPages
    );
    if (pdfDir) writeFileSync(path.join(pdfDir, `${fixture.name}.pdf`), bytes);
    const doc = { numPages };
    if (violations.length > 0) failed = true;
    report.push({
      fixture: fixture.name,
      pages: doc.numPages,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      markers: fixture.markers.length,
      violationCounts: counts,
      sampleViolations: violations.slice(0, 8),
      // Raw extracted text geometry, so a consumer can recompute the verdict independently of this script.
      pageText,
    });
    console.log(`${violations.length === 0 ? "PASS" : "FAIL"} ${fixture.name}: ${doc.numPages} pages, ${violations.length} violations ${JSON.stringify(counts)}`);
  }

  const jsonOut = opt("--json");
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ generatedBy: "scripts/verify-pdf-layout.mjs", canary: { detected: canaryDetected, violationCounts: canaryCounts, pageText: canaryPageText }, report }, null, 1) + "\n");
  if (failed && !flag("--allow-fail")) process.exitCode = 1;
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
