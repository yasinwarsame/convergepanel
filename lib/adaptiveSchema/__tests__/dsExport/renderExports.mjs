#!/usr/bin/env node
/**
 * Order 6 / S-E.2: renders export records through the REAL production dispatcher (`renderAdaptiveResearchExport`:
 * real @react-pdf/renderer, real docx package, real JSON serializer) and digests the output. Jest cannot load the
 * ESM-only PDF renderer, so the specs run this in a child Node process (same pattern as scripts/verify-pdf-layout.mjs).
 *
 * Usage (run with TZ fixed, e.g. TZ=UTC):
 *   node renderExports.mjs --out <digest.json> [--records <records.json>] [--save-records <records.json>]
 *                          [--bytes <dir>] [--layout-fixtures]
 *   --records       render these stored records (a JSON object { key: record }) instead of building the fixture cases
 *   --save-records  also write the records it rendered, in their stored (Firestore) form
 *   --bytes         also write every rendered file to <dir>/<key>.<ext> (evidence; never committed)
 *   --layout-fixtures  also render every lib/pdf layout fixture in all three formats (non-DS parity controls)
 *   --layout-check  also apply lib/pdf/layoutIntegrity.ts's document rules to every PDF (overlap, out of bounds,
 *                   stranded heading, lone bullet, empty card fragment, card closing gap), after proving on the
 *                   known-bad canary that the rules detect a defect
 *
 * Built cases are rendered twice: once from the in-memory record (what the creation route renders and hashes) and
 * once from the stored form after a JSON round trip (what a re-download renders). Both hashes are reported.
 *
 * Digest per key: format, sha256, length; DOCX: sha256 of every package part after removing only the core.xml
 * created/modified timestamps (the documented DOCX nondeterminism), plus the document text; PDF and DOCX: extracted
 * text (pdf.js / the structured DOCX reader in docxText.ts).
 *
 * This is the capture tool that produced the 413e14b evidence baseline. The compatibility suite the specs run is
 * exportSuite.mjs.
 */
import { build } from "esbuild";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const out = opt("--out");
if (!out) throw new Error("--out is required");

const workDir = mkdtempSync(path.join(tmpdir(), "cp-se2-render-"));
try {
  const entry = `
    export { exportCases, exportRecord, asStored, FORMATS } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
    export { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
    export { pdfLayoutFixtures } from "@/lib/pdf/__fixtures__/layoutFixtures";
    export { docxParagraphs } from "@/lib/adaptiveSchema/__tests__/dsExport/docxText";
    export { documentViolations, strandedHeadingViolations, loneBulletViolations, emptyCardFragmentViolations, cardClosingGapViolations } from "@/lib/pdf/layoutIntegrity";
    export { LayoutCanaryDocument } from "@/lib/pdf/__fixtures__/layoutCanary";
  `;
  const outfile = path.join(workDir, "bundle.mjs");
  const serverOnly = { name: "server-only", setup(b) { b.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "empty" })); b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" })); } };
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
    plugins: [serverOnly],
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    logLevel: "error",
  });
  const req = createRequire(path.join(ROOT, "package.json"));
  const src = readFileSync(outfile, "utf8")
    .replaceAll('from "react/jsx-runtime"', `from ${JSON.stringify(pathToFileURL(req.resolve("react/jsx-runtime")).href)}`)
    .replaceAll('from "react"', `from ${JSON.stringify(pathToFileURL(req.resolve("react")).href)}`)
    .replaceAll('from "@react-pdf/renderer"', `from ${JSON.stringify(pathToFileURL(req.resolve("@react-pdf/renderer")).href)}`);
  writeFileSync(outfile, src);
  const mod = await import(pathToFileURL(outfile).href);
  const JSZip = req("jszip");
  const pdfjs = await import(pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);

  const sha = (b) => createHash("sha256").update(b).digest("hex");
  // Positioned text and filled shapes, exactly as scripts/verify-pdf-layout.mjs extracts them.
  const { OPS } = pdfjs;
  const PAINT_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  async function shapesOf(page) {
    const ol = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const boxes = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i];
      const a = ol.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, a);
      else if (fn === OPS.constructPath && PAINT_OPS.has(a[0]) && a[2] && a[2].length === 4) {
        const corners = [apply(ctm, a[2][0], a[2][1]), apply(ctm, a[2][2], a[2][3]), apply(ctm, a[2][0], a[2][3]), apply(ctm, a[2][2], a[2][1])];
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        boxes.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
      }
    }
    return boxes;
  }
  const LAYOUT = { paddingTop: 48, paddingBottom: 56 };
  async function layoutViolations(bytes) {
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
        items: content.items.filter((it) => typeof it.str === "string").map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, height: it.height })),
        shapes: await shapesOf(page),
      });
    }
    return [
      ...mod.documentViolations(pages, LAYOUT, []),
      ...mod.strandedHeadingViolations(pages, LAYOUT),
      ...mod.loneBulletViolations(pages),
      ...mod.emptyCardFragmentViolations(pages, LAYOUT),
      ...mod.cardClosingGapViolations(pages, LAYOUT),
    ];
  }
  const layoutCheck = args.includes("--layout-check");
  async function pdfText(bytes) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const content = await (await doc.getPage(p)).getTextContent();
      pages.push(content.items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join(""));
    }
    await doc.cleanup?.();
    return { pages: doc.numPages, text: pages.join("\n\f\n") };
  }
  async function docxDigest(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const parts = {};
    for (const name of Object.keys(zip.files).sort()) {
      if (zip.files[name].dir) continue;
      let content = await zip.files[name].async("string");
      if (name === "docProps/core.xml") content = content.replace(/(<dcterms:(created|modified)[^>]*>)[^<]*(<\/dcterms:\2>)/g, "$1⟨date⟩$3");
      parts[name] = sha(content);
    }
    // Document text through the structured reader (docxText.ts), never by regular expressions over XML.
    const text = (await mod.docxParagraphs(bytes)).join("\n");
    return { parts, text };
  }
  const bytesDir = opt("--bytes");
  if (bytesDir) mkdirSync(bytesDir, { recursive: true });
  const ext = { pdf: "pdf", docx: "docx", json: "json" };
  async function digest(key, record) {
    const { bytes, sha256 } = await mod.renderAdaptiveResearchExport(record);
    if (sha256 !== sha(bytes)) throw new Error(`${key}: dispatcher sha256 does not match its bytes`);
    if (bytesDir) writeFileSync(path.join(bytesDir, `${key}.${ext[record.format]}`), bytes);
    const d = { format: record.format, sha256, length: bytes.length };
    if (record.format === "pdf") Object.assign(d, await pdfText(bytes));
    if (record.format === "pdf" && layoutCheck) d.layoutViolations = await layoutViolations(bytes);
    if (record.format === "docx") Object.assign(d, await docxDigest(bytes));
    return d;
  }

  const result = { node: process.version, tz: process.env.TZ ?? null, deps: {}, entries: {} };
  for (const p of ["@react-pdf/renderer", "docx", "jszip", "pdfjs-dist", "react"]) result.deps[p] = JSON.parse(readFileSync(path.join(ROOT, "node_modules", p, "package.json"), "utf8")).version;
  if (layoutCheck) {
    const { renderToBuffer } = await import(pathToFileURL(req.resolve("@react-pdf/renderer")).href);
    const React = (await import(pathToFileURL(req.resolve("react")).href)).default;
    result.canaryViolations = (await layoutViolations(await renderToBuffer(React.createElement(mod.LayoutCanaryDocument)))).length;
  }
  const stored = {};
  const recordsFile = opt("--records");
  if (recordsFile) {
    const records = JSON.parse(readFileSync(recordsFile, "utf8"));
    for (const [key, record] of Object.entries(records)) result.entries[key] = await digest(key, record);
  } else {
    for (const c of mod.exportCases()) {
      for (const format of mod.FORMATS) {
        const key = `${c.name}.${format}`;
        const record = mod.exportRecord(c, format);
        const created = await digest(`${key}.created`, record);
        // Stored form: sanitizeForFirestore, then markAdaptiveExportReady's status and hash; read back as JSON.
        const storedRecord = JSON.parse(JSON.stringify(mod.asStored({ ...record, artifactStatus: "ready", exportMetadata: { ...record.exportMetadata, fileHash: created.sha256 } })));
        stored[key] = storedRecord;
        const redownload = await digest(key, storedRecord);
        result.entries[key] = { ...redownload, creationSha256: created.sha256 };
      }
    }
    if (args.includes("--layout-fixtures")) {
      for (const f of mod.pdfLayoutFixtures()) {
        for (const format of mod.FORMATS) {
          const key = `layout.${f.name}.${format}`;
          const record = { ...f.record, format };
          stored[key] = JSON.parse(JSON.stringify(record));
          const d = await digest(key, record);
          delete d.text; // layout fixtures are parity controls: hashes only
          result.entries[key] = d;
        }
      }
    }
  }
  const save = opt("--save-records");
  if (save) writeFileSync(save, JSON.stringify(stored, null, 1));
  writeFileSync(out, JSON.stringify(result, null, 1));
  process.stdout.write(`rendered ${Object.keys(result.entries).length} entries\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
