#!/usr/bin/env node
/**
 * Order 6 / S-E.2 (R1 correction): the export compatibility suite, in ONE child Node process (Jest cannot load the
 * ESM-only PDF renderer).
 *
 * Two bundles of the same tree:
 *   - HEAD: the tree as it is.
 *   - BASE: the tree with the five production files S-E.2 changes replaced by their exact 0249a4e5 contents
 *     (__fixtures__/base-0249a4e5/, git blob ids in its manifest.json). Every other production file is identical between
 *     0249a4e5 and the S-E.2 head, so BASE is the unchanged-main renderer, running in THIS runtime.
 * Both go through the real dispatcher (`renderAdaptiveResearchExport`: @react-pdf PDF, docx DOCX, JSON serializer).
 *
 * Because BASE renders in the same process and runtime as HEAD, the historical comparison never depends on bytes
 * captured in another environment. Each BASE record is rendered once, on the creation path: its sha256 is the stored
 * `fileHash` a re-download must reproduce, and HEAD re-downloads the stored record.
 * `--repeat` (evidence runs) renders every BASE PDF a second time to demonstrate determinism on unchanged main.
 *
 * Usage: TZ=UTC node exportSuite.mjs --out <result.json> [--bytes <dir>] [--repeat]
 */
import { build } from "esbuild";
import { createHash } from "crypto";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir, release } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../..");
const BASE_DIR = path.join(HERE, "__fixtures__", "base-0249a4e5");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const out = opt("--out");
if (!out) throw new Error("--out is required");
const bytesDir = opt("--bytes");
if (bytesDir) mkdirSync(bytesDir, { recursive: true });

const sha = (b) => createHash("sha256").update(b).digest("hex");
const req = createRequire(path.join(ROOT, "package.json"));
const workDir = mkdtempSync(path.join(tmpdir(), "cp-se2-suite-"));

/** The vendored 0249a4e5 files, by absolute production path, after checking each against its manifest hash. */
function vendoredBase() {
  const manifest = JSON.parse(readFileSync(path.join(BASE_DIR, "manifest.json"), "utf8"));
  const map = new Map();
  for (const f of manifest.files) {
    const file = path.join(BASE_DIR, f.vendored);
    if (sha(readFileSync(file)) !== f.sha256) throw new Error(`vendored base file ${f.vendored} does not match its manifest`);
    map.set(path.join(ROOT, f.path), file);
  }
  return { manifest, map };
}

async function bundle(name, entry, substitute) {
  const outfile = path.join(workDir, `${name}.mjs`);
  const plugin = {
    name: "se2-resolve",
    setup(b) {
      b.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "empty" }));
      b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
      if (!substitute) return;
      b.onResolve({ filter: /.*/ }, async (a) => {
        if (a.pluginData?.se2 || a.namespace === "empty" || a.path === "server-only") return undefined;
        const r = await b.resolve(a.path, { resolveDir: a.resolveDir, kind: a.kind, importer: a.importer, pluginData: { se2: true } });
        if (r.errors.length) return undefined;
        const vendored = substitute.get(r.path);
        return vendored ? { path: vendored, namespace: "base0249a4e5", pluginData: { original: r.path } } : r;
      });
      b.onLoad({ filter: /.*/, namespace: "base0249a4e5" }, (a) => ({
        contents: readFileSync(a.path, "utf8"),
        loader: a.pluginData.original.endsWith(".tsx") ? "tsx" : "ts",
        resolveDir: path.dirname(a.pluginData.original),
      }));
    },
  };
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
    plugins: [plugin],
    banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
    logLevel: "error",
  });
  const src = readFileSync(outfile, "utf8")
    .replaceAll('from "react/jsx-runtime"', `from ${JSON.stringify(pathToFileURL(req.resolve("react/jsx-runtime")).href)}`)
    .replaceAll('from "react"', `from ${JSON.stringify(pathToFileURL(req.resolve("react")).href)}`)
    .replaceAll('from "@react-pdf/renderer"', `from ${JSON.stringify(pathToFileURL(req.resolve("@react-pdf/renderer")).href)}`);
  writeFileSync(outfile, src);
  return import(pathToFileURL(outfile).href);
}

try {
  const { manifest, map } = vendoredBase();
  const entry = `
    export { exportCases, exportRecord, asStored, FORMATS } from "@/lib/adaptiveSchema/__tests__/dsExport/dsExportFixtures";
    export { renderAdaptiveResearchExport } from "@/lib/pdf/renderAdaptiveResearchPdf";
    export { docxParagraphs } from "@/lib/adaptiveSchema/__tests__/dsExport/docxText";
  `;
  const head = await bundle("head", `${entry}
    export { documentViolations, strandedHeadingViolations, loneBulletViolations, emptyCardFragmentViolations, cardClosingGapViolations } from "@/lib/pdf/layoutIntegrity";
    export { LayoutCanaryDocument } from "@/lib/pdf/__fixtures__/layoutCanary";`, null);
  const base = await bundle("base", entry, map);
  const pdfjs = await import(pathToFileURL(path.join(ROOT, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
  const JSZip = req("jszip");

  // ─── runtime fingerprint ──────────────────────────────────────────────
  const version = (p) => JSON.parse(readFileSync(path.join(ROOT, "node_modules", p, "package.json"), "utf8")).version;
  const deps = {};
  for (const p of ["@react-pdf/renderer", "@react-pdf/pdfkit", "@react-pdf/layout", "@react-pdf/font", "@react-pdf/textkit", "@react-pdf/render", "fontkit", "yoga-layout", "docx", "jszip", "mammoth", "pdfjs-dist", "react", "esbuild"]) deps[p] = version(p);
  const fontData = sha(readFileSync(req.resolve("@react-pdf/pdfkit")));
  const fingerprint = {
    node: process.version,
    zlib: process.versions.zlib,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    tz: process.env.TZ ?? null,
    deps,
    pdfkitMainSha256: fontData,
  };
  // The bytes-relevant identity: renderer packages, compression library, arch and timezone.
  const fingerprintId = sha(JSON.stringify([fingerprint.zlib, fingerprint.arch, fingerprint.tz, deps["@react-pdf/renderer"], deps["@react-pdf/pdfkit"], deps["@react-pdf/layout"], deps["@react-pdf/font"], deps["@react-pdf/textkit"], deps["@react-pdf/render"], deps.fontkit, deps["yoga-layout"], deps.docx, deps.jszip, fontData])).slice(0, 16);

  // ─── digests ──────────────────────────────────────────────────────────
  const { OPS } = pdfjs;
  const PAINT_OPS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  async function readPdf(bytes) {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const pages = [];
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const [, , width, height] = page.view;
      const content = await page.getTextContent();
      const items = content.items.filter((it) => typeof it.str === "string");
      lines.push(items.map((i) => i.str + (i.hasEOL ? "\n" : "")).join(""));
      const ol = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const shapes = [];
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i];
        const a = ol.argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === OPS.transform) ctm = mul(ctm, a);
        else if (fn === OPS.constructPath && PAINT_OPS.has(a[0]) && a[2] && a[2].length === 4) {
          const c = [apply(ctm, a[2][0], a[2][1]), apply(ctm, a[2][2], a[2][3]), apply(ctm, a[2][0], a[2][3]), apply(ctm, a[2][2], a[2][1])];
          shapes.push({ x0: Math.min(...c.map((q) => q[0])), x1: Math.max(...c.map((q) => q[0])), y0: Math.min(...c.map((q) => q[1])), y1: Math.max(...c.map((q) => q[1])) });
        }
      }
      pages.push({ pageNumber: p, width, height, items: items.map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, height: it.height })), shapes });
    }
    await doc.cleanup?.();
    return { pages, text: lines.join("\n\f\n") };
  }
  const LAYOUT = { paddingTop: 48, paddingBottom: 56 };
  const layoutViolations = (pages) => [
    ...head.documentViolations(pages, LAYOUT, []),
    ...head.strandedHeadingViolations(pages, LAYOUT),
    ...head.loneBulletViolations(pages),
    ...head.emptyCardFragmentViolations(pages, LAYOUT),
    ...head.cardClosingGapViolations(pages, LAYOUT),
  ];
  async function docxParts(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const parts = {};
    for (const name of Object.keys(zip.files).sort()) {
      if (zip.files[name].dir) continue;
      let content = await zip.files[name].async("string");
      // Only DOCX's documented nondeterminism is neutralized: core.xml's created/modified timestamps.
      if (name === "docProps/core.xml") content = content.replace(/(<dcterms:(created|modified)[^>]*>)[^<]*(<\/dcterms:\2>)/g, "$1⟨date⟩$3");
      parts[name] = sha(content);
    }
    return parts;
  }
  const ext = { pdf: "pdf", docx: "docx", json: "json" };
  /** Rendered bytes by key, so text is extracted only where a comparison needs it. */
  const kept = new Map();
  async function render(mod, key, record, { text = false, layout = false, paragraphs = false } = {}) {
    const { bytes, sha256 } = await mod.renderAdaptiveResearchExport(record);
    if (sha256 !== sha(bytes)) throw new Error(`${key}: dispatcher sha256 does not match its bytes`);
    if (bytesDir) writeFileSync(path.join(bytesDir, `${key}.${ext[record.format]}`), bytes);
    const d = { format: record.format, sha256, length: bytes.length };
    kept.set(key, bytes);
    if (record.format === "pdf" && (text || layout)) {
      const pdf = await readPdf(bytes);
      d.pages = pdf.pages.length;
      if (text) d.text = pdf.text;
      if (layout) d.layoutViolations = layoutViolations(pdf.pages);
    }
    if (record.format === "docx") {
      d.parts = await docxParts(bytes);
      if (paragraphs) d.paragraphs = await mod.docxParagraphs(bytes);
    }
    return d;
  }
  const stored = (mod, record, fileHash) => JSON.parse(JSON.stringify(mod.asStored({ ...record, artifactStatus: "ready", exportMetadata: { ...record.exportMetadata, fileHash } })));

  const result = { fingerprint, fingerprintId, baseManifest: manifest, base: {}, baseRepeat: {}, baseRecords: {}, historical: {}, variants: {}, created: {}, redownload: {} };
  const t0 = Date.now();

  // 1. Unchanged main: build the records with the 0249a4e5 builder, store them, render them (PDF twice).
  for (const c of base.exportCases()) {
    for (const format of base.FORMATS) {
      const key = `${c.name}.${format}`;
      const record = base.exportRecord(c, format);
      const created = await render(base, `base.${key}`, record);
      result.baseRecords[key] = stored(base, record, created.sha256);
      result.base[key] = created;
      if (format === "pdf" && args.includes("--repeat")) result.baseRepeat[key] = (await render(base, `base.${key}.repeat`, result.baseRecords[key])).sha256;
    }
  }
  result.timing = { baseMs: Date.now() - t0 };

  // 2. HEAD renders the same stored historical records.
  for (const [key, s] of Object.entries(result.baseRecords)) {
    const h = await render(head, `historical.${key}`, s);
    // Structure of both sides, only where the bytes differ (the spec then decides: a byte difference fails unless the
    // fixture is a documented nondeterministic one, and even then text and page count must match).
    if (s.format === "pdf" && h.sha256 !== result.base[key].sha256) {
      const [a, b] = [await readPdf(kept.get(`base.${key}`)), await readPdf(kept.get(`historical.${key}`))];
      Object.assign(result.base[key], { text: a.text, pages: a.pages.length });
      Object.assign(h, { text: b.text, pages: b.pages.length });
    }
    result.historical[key] = h;
  }

  // 3. Invalid markers on DS records and a forged version-1 marker on non-DS records (HEAD renderer).
  const INVALID = [["null", null], ["empty", {}], ["marker-null", { dsLabelWordingVersion: null }], ["marker-string-1", { dsLabelWordingVersion: "1" }], ["marker-2", { dsLabelWordingVersion: 2 }], ["marker-true", { dsLabelWordingVersion: true }], ["array", [1]]];
  const withPresentation = (s, presentation) => ({ ...s, reportSnapshot: { ...s.reportSnapshot, presentation } });
  for (const k of ["ds.uncontested_choose_option.unreviewed_in_queue", "ds.unresolved_option_488.unreviewed_in_queue", "ds.no_recommendation_no_options.unreviewed_in_queue"])
    for (const f of k.startsWith("ds.no_recommendation") ? ["docx", "json"] : ["pdf", "docx", "json"])
      for (const [label, p] of INVALID) result.variants[`invalid.${label}.${k}.${f}`] = await render(head, `variant.${label}.${k}.${f}`, withPresentation(result.baseRecords[`${k}.${f}`], p));
  for (const k of ["nonds.comparison_matrix.unreviewed_in_queue", "nonds.financial_valuation.approved"])
    for (const f of ["pdf", "docx", "json"]) result.variants[`forged.${k}.${f}`] = await render(head, `forged.${k}.${f}`, withPresentation(result.baseRecords[`${k}.${f}`], { dsLabelWordingVersion: 1 }));

  // 4. New exports with the HEAD builder: creation render, then the stored form re-downloaded.
  for (const c of head.exportCases()) {
    for (const format of head.FORMATS) {
      const key = `${c.name}.${format}`;
      const record = head.exportRecord(c, format);
      const created = await render(head, `created.${key}`, record, { text: format === "pdf", layout: format === "pdf", paragraphs: format === "docx" });
      result.created[key] = created;
      result.redownload[key] = await render(head, `redownload.${key}`, stored(head, record, created.sha256));
    }
  }
  const { renderToBuffer } = await import(pathToFileURL(req.resolve("@react-pdf/renderer")).href);
  const React = (await import(pathToFileURL(req.resolve("react")).href)).default;
  result.canaryViolations = layoutViolations((await readPdf(await renderToBuffer(React.createElement(head.LayoutCanaryDocument)))).pages).length;
  result.timing.totalMs = Date.now() - t0;
  writeFileSync(out, JSON.stringify(result));
  process.stdout.write(`suite ${result.fingerprintId} ${Object.keys(result.base).length} base, ${Object.keys(result.created).length} created, ${result.timing.totalMs} ms\n`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
