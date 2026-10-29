/**
 * Order 6 / S-E.2 (H1-A), real rendered bytes, R1-corrected design.
 *
 * One child Node process (exportSuite.mjs) renders, through the real production dispatcher and in THIS runtime:
 *   - BASE: unchanged main 0249a4e5 (the five changed production files replaced by their exact 0249a4e5 contents,
 *     __fixtures__/base-0249a4e5/, git blob ids pinned below);
 *   - HEAD: the tree under review.
 * Historical compatibility is therefore proven against unchanged main in the same runtime on every run, independent of
 * where any committed bytes were captured. Comparison: PDF and JSON by sha256 of the complete bytes; DOCX by the sha256
 * of every package part after removing only docProps/core.xml's created/modified timestamps.
 *
 * Environment-pinned goldens (__fixtures__/goldens/<fingerprintId>.json) add a second layer: in a runtime whose
 * bytes-relevant fingerprint (zlib, arch, TZ, renderer packages, standard-font data) has a golden, every BASE PDF hash
 * and every version-1 PDF hash must equal it. An unpinned runtime fails here: PDF bytes, and so every stored PDF
 * `fileHash`, depend on that runtime.
 *
 * Original evidence: __fixtures__/historicalBaseline.json and historicalRecords.json were first captured in commit
 * 413e14b, before any production edit, from unchanged main on macOS x64 / Node 26.6.0 (zlib 1.2.12); that commit stays
 * in Git history as the original capture. Commit 82fc7fb recaptured both files from the unchanged base worktree: it
 * added six entries (two legacy source states x PDF/DOCX/JSON, 99 -> 105), and the 33 DOCX entries got new zip-level
 * hashes (baseline `sha256`/`creationSha256`, eight `length`s, and the record's `exportMetadata.fileHash`) because
 * docProps/core.xml carries the capture time. Every PDF and JSON hash, every normalized DOCX part digest, and every
 * other record field present in both captures is identical. The files have not changed since 82fc7fb. Their PDF hashes
 * are specific to the capture runtime (CI runs Node 24, zlib 1.3.2.1); record content is checked below and the PDF
 * hashes are the golden of that runtime.
 */
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import historicalRecords from "./__fixtures__/historicalRecords.json";
import historicalBaseline from "./__fixtures__/historicalBaseline.json";
import { D9, ORACLE, OLD_CAPTION, SHOWN_488, stateOf } from "./dsExportOracle";
import { CANDIDATE_SECTIONS, provenanceViolations, type BundleIdentity } from "./bundleProvenance";

type Digest = { format: string; sha256: string; length: number; bundle?: string; parts?: Record<string, string>; text?: string; pages?: number; layoutViolations?: unknown[]; paragraphs?: string[] };
type Suite = {
  fingerprint: Record<string, unknown>;
  fingerprintId: string;
  baseManifest: { sourceCommit: string; files: { path: string; vendored: string; blob: string; sha256: string }[] };
  bundles: { head: BundleIdentity; base: BundleIdentity };
  provenanceControl: { key: string; digest: Digest };
  base: Record<string, Digest>;
  baseRecords: Record<string, Record<string, unknown>>;
  historical: Record<string, Digest>;
  variants: Record<string, Digest>;
  created: Record<string, Digest>;
  redownload: Record<string, Digest>;
  canaryViolations: number;
};
type Golden = { fingerprintId: string; base: Record<string, string>; versionOne: Record<string, string> };

const HERE = __dirname;
const ROOT = path.resolve(HERE, "../../../..");
const SUITE = path.join(HERE, "exportSuite.mjs");
const BASE_DIR = path.join(HERE, "__fixtures__", "base-0249a4e5");
const GOLDENS = path.join(HERE, "__fixtures__", "goldens");
const OLD_RECORDS = historicalRecords as Record<string, Record<string, unknown>>;
const OLD_BASELINE = historicalBaseline as unknown as { entries: Record<string, Digest> };

/** The exact 0249a4e5 blob ids of the five files S-E.2 changes (`git rev-parse 0249a4e5:<path>`). */
const BASE_BLOBS: Record<string, string> = {
  "lib/adaptiveSchema/researchExport.ts": "1d9d6e02b1d748459cdfd21515e754ea42c782f2",
  "lib/adaptiveSchema/exportSnapshot.ts": "40b67194dc0bc688e7c37d899a5119e839bcb174",
  "lib/adaptiveSchema/dsLabelWording.ts": "72a48162971ec16cbd5419ace6cdc1e4c45b4581",
  "lib/pdf/AdaptiveResearchDocument.tsx": "72c31cba28e76936754ce38cb5cf1877faf2b2a7",
  "lib/docx/AdaptiveResearchDocxDocument.ts": "c59bf8ea7eb2eca57a4118d24a99960e7e754421",
};

/**
 * Fixtures whose PDF bytes vary between renders on unchanged main itself (demonstrated by `exportSuite.mjs --repeat`
 * on 0249a4e5). For these only, text and page count are compared instead of bytes. None of the S-E.2 fixtures has
 * shown variation in any run; the list is empty, so every historical PDF here must match byte for byte.
 */
const KNOWN_NONDETERMINISTIC: string[] = [];

let dir: string;
let suite: Suite;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cp-se2-suite-spec-"));
  const out = path.join(dir, "suite.json");
  execFileSync(process.execPath, [SUITE, "--out", out], { env: { ...process.env, TZ: "UTC" }, stdio: "pipe", timeout: 300_000 });
  suite = JSON.parse(readFileSync(out, "utf8"));
}, 330_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const same = (a: Digest, b: Digest) => (a.format === "docx" ? JSON.stringify(a.parts) === JSON.stringify(b.parts) : a.sha256 === b.sha256 && a.length === b.length);
const letters = (t: string) => t.replace(/[^A-Za-z0-9]/g, "");
const gitBlob = (data: Buffer) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");

describe("unchanged-main renderer and runtime", () => {
  it("the vendored base files are byte-for-byte the 0249a4e5 blobs", () => {
    expect(suite.baseManifest.sourceCommit).toBe("0249a4e5fb8c3eba2adaab432935fad9335571eb");
    expect(Object.fromEntries(suite.baseManifest.files.map((f) => [f.path, f.blob]))).toEqual(BASE_BLOBS);
    for (const f of suite.baseManifest.files) expect(gitBlob(readFileSync(path.join(BASE_DIR, f.vendored)))).toBe(BASE_BLOBS[f.path]);
  });

  it("renders in UTC and records the runtime fingerprint", () => {
    expect(suite.fingerprint.tz).toBe("UTC");
    expect(suite.fingerprintId).toMatch(/^[0-9a-f]{16}$/);
    for (const k of ["node", "zlib", "platform", "arch", "deps", "pdfkitMainSha256"]) expect(suite.fingerprint[k]).toBeTruthy();
  });

  it("the records unchanged main builds are the committed historical records (413e14b evidence), except the DOCX fileHash", () => {
    const strip = (r: Record<string, unknown>) => ({ ...r, exportMetadata: { ...(r.exportMetadata as object), fileHash: null } });
    const common = Object.keys(OLD_RECORDS);
    expect(common.length).toBe(105);
    for (const k of common) expect(strip(suite.baseRecords[k])).toEqual(strip(OLD_RECORDS[k]));
    expect(Object.keys(suite.baseRecords).filter((k) => !OLD_RECORDS[k]).sort()).toEqual(["pdf", "docx", "json"].map((f) => `ds.uncontested_choose_option.unreviewed_in_queue.synthetic_identities.${f}`).sort());
  });
});

describe("render provenance (R6): each render came from the bundle its role requires", () => {
  // Expected sources, read independently of the suite: HEAD = the five working-tree files; BASE = the pinned 0249a4e5
  // blobs of the files unchanged main's export graph compiles (at 0249a4e5 no export module imports dsLabelWording.ts,
  // so BASE must not compile any copy of it).
  const BASE_GRAPH = Object.fromEntries(Object.entries(BASE_BLOBS).filter(([p]) => p !== "lib/adaptiveSchema/dsLabelWording.ts"));
  const expected = () => ({ head: Object.fromEntries(Object.keys(BASE_BLOBS).map((p) => [p, gitBlob(readFileSync(path.join(ROOT, p)))])), base: BASE_GRAPH });
  const clone = (): Suite => JSON.parse(JSON.stringify(suite));

  it("HEAD compiled the working tree, BASE compiled the vendored 0249a4e5 files; unchanged-main renders are BASE's, candidate renders are HEAD's", () => {
    expect(provenanceViolations(suite, expected())).toEqual([]);
    expect(suite.bundles.head.sources.map((s) => s.path).sort()).toEqual(Object.keys(BASE_BLOBS).sort());
  });

  it("falsification: a real historical render by the BASE bundle in the candidate slot is rejected, though its bytes match", () => {
    const { key, digest } = suite.provenanceControl;
    // The miswiring is invisible to output comparison: unchanged main renders a historical record identically.
    expect(digest.bundle).toBe(suite.bundles.base.id);
    expect(digest.sha256).toBe(suite.historical[key].sha256);
    const miswired = clone();
    miswired.historical[key] = digest;
    expect(provenanceViolations(miswired, expected())).toEqual([`historical.${key}: rendered by BASE, expected HEAD`]);
  });

  it("R2 NIT-1: every candidate section rejects a real BASE render in its slot, though the bytes match", () => {
    // The candidate sections, written out here rather than read from the checker's own list.
    const SECTIONS = ["historical", "variants", "created", "redownload"] as const;
    expect([...CANDIDATE_SECTIONS].sort()).toEqual([...SECTIONS].sort());
    // For each section, one entry whose expected output equals a real BASE render (historical: the control render;
    // the others: non-DS and forged non-DS outputs, which unchanged main renders identically).
    const slots: Record<(typeof SECTIONS)[number], [string, Digest]> = {
      historical: [suite.provenanceControl.key, suite.provenanceControl.digest],
      variants: ["forged.nonds.comparison_matrix.unreviewed_in_queue.pdf", suite.base["nonds.comparison_matrix.unreviewed_in_queue.pdf"]],
      created: ["nonds.comparison_matrix.unreviewed_in_queue.pdf", suite.base["nonds.comparison_matrix.unreviewed_in_queue.pdf"]],
      redownload: ["nonds.financial_valuation.approved.json", suite.base["nonds.financial_valuation.approved.json"]],
    };
    for (const section of SECTIONS) {
      const [key, baseRender] = slots[section];
      expect(baseRender.bundle).toBe(suite.bundles.base.id);
      expect(suite[section][key].bundle).toBe(suite.bundles.head.id);
      expect(baseRender.sha256).toBe(suite[section][key].sha256);
      const miswired = clone();
      miswired[section][key] = baseRender;
      expect(provenanceViolations(miswired, expected())).toEqual([`${section}.${key}: rendered by BASE, expected HEAD`]);
    }
  });

  it("falsification: a HEAD render in the unchanged-main slot, swapped identities and name-only labels are rejected", () => {
    const key = suite.provenanceControl.key;
    const s1 = clone();
    s1.base[key] = suite.historical[key];
    expect(provenanceViolations(s1, expected())).toEqual([`base.${key}: rendered by HEAD, expected BASE`]);
    const s2 = clone();
    s2.bundles.head = suite.bundles.base;
    expect(provenanceViolations(s2, expected())).toEqual(expect.arrayContaining(["HEAD and BASE bundles are the same build"]));
    const s3 = clone();
    s3.bundles.head = { ...suite.bundles.head, sources: suite.bundles.base.sources };
    expect(provenanceViolations(s3, expected()).some((v) => v.startsWith("head: lib/"))).toBe(true);
    // A caller-provided name is not an identity.
    const s4 = clone();
    s4.historical[key] = { ...suite.historical[key], bundle: "head" };
    expect(provenanceViolations(s4, expected())).toEqual([`historical.${key}: rendered by "head", expected HEAD`]);
    // The expectation is read from the tree, so a BASE expected as HEAD (an unchanged candidate) fails too.
    expect(provenanceViolations(suite, { head: BASE_BLOBS, base: BASE_GRAPH })).toEqual(expect.arrayContaining([expect.stringMatching(/candidate and baseline sources are identical/)]));
  });
});

describe("historical records (no marker): HEAD reproduces unchanged main in this runtime", () => {
  it("every historical PDF, JSON and DOCX re-renders identically; every stored PDF/JSON fileHash is reproduced", () => {
    const keys = Object.keys(suite.base);
    expect(keys.length).toBe(108);
    const diffs: string[] = [];
    for (const k of keys) {
      const b = suite.base[k];
      const h = suite.historical[k];
      if (same(h, b)) continue;
      if (b.format === "pdf" && KNOWN_NONDETERMINISTIC.includes(k) && h.text === b.text && h.pages === b.pages) continue;
      diffs.push(k);
    }
    expect(diffs).toEqual([]);
    for (const k of keys.filter((x) => !x.endsWith(".docx"))) expect(suite.historical[k].sha256).toBe(suite.baseRecords[k].exportMetadata && (suite.baseRecords[k].exportMetadata as { fileHash: string }).fileHash);
  });

  it("every invalid marker renders exactly the unmarked historical output", () => {
    const keys = Object.keys(suite.variants).filter((k) => k.startsWith("invalid."));
    expect(keys.length).toBe(7 * 3 + 7 * 3 + 7 * 2);
    for (const k of keys) expect(same(suite.variants[k], suite.base[k.split(".").slice(2).join(".")])).toBe(true);
  });

  it("a version-1 marker forged onto a non-DS record changes no byte", () => {
    const keys = Object.keys(suite.variants).filter((k) => k.startsWith("forged."));
    expect(keys.length).toBe(6);
    for (const k of keys) expect(same(suite.variants[k], suite.base[k.slice("forged.".length)])).toBe(true);
  });
});

describe("environment-pinned goldens", () => {
  const file = () => path.join(GOLDENS, `${suite.fingerprintId}.json`);

  it("this runtime is pinned: its golden exists", () => {
    // A runtime without a golden is a new PDF-bytes environment; record it with goldens/README.md before relying on it.
    expect({ fingerprintId: suite.fingerprintId, fingerprint: suite.fingerprint, pinned: existsSync(file()) }).toEqual({ fingerprintId: suite.fingerprintId, fingerprint: suite.fingerprint, pinned: true });
  });

  it("unchanged-main PDFs and version-1 PDFs equal the golden of this runtime", () => {
    if (!existsSync(file())) throw new Error(`no golden for runtime ${suite.fingerprintId}`);
    const golden: Golden = JSON.parse(readFileSync(file(), "utf8"));
    expect(golden.fingerprintId).toBe(suite.fingerprintId);
    const basePdf = Object.fromEntries(Object.entries(suite.base).filter(([k]) => k.endsWith(".pdf")).map(([k, d]) => [k, d.sha256]));
    const v1Pdf = Object.fromEntries(Object.entries(suite.created).filter(([k]) => k.startsWith("ds.") && k.endsWith(".pdf")).map(([k, d]) => [k, d.sha256]));
    expect(basePdf).toEqual(golden.base);
    expect(v1Pdf).toEqual(golden.versionOne);
  });

  it("the original 413e14b PDF hashes are the golden of their own runtime (macOS x64, Node 26.6.0)", () => {
    const n26 = JSON.parse(readFileSync(path.join(GOLDENS, "1b18e34ab428be92.json"), "utf8")) as Golden & { fingerprint: Record<string, unknown> };
    expect(n26.fingerprint.zlib).toBe("1.2.12");
    for (const [k, d] of Object.entries(OLD_BASELINE.entries)) if (d.format === "pdf") expect(n26.base[k]).toBe(d.sha256);
  });
});

describe("new exports", () => {
  const dsKeys = () => Object.keys(suite.created).filter((k) => k.startsWith("ds."));

  it("non-DS exports built now equal unchanged main's", () => {
    const keys = Object.keys(suite.created).filter((k) => k.startsWith("nonds."));
    expect(keys.length).toBe(9);
    for (const k of keys) expect(same(suite.created[k], suite.base[k])).toBe(true);
  });

  it("JSON of a new DS export is byte-identical to unchanged main's JSON of the same run (marker never serialized)", () => {
    const keys = dsKeys().filter((k) => k.endsWith(".json"));
    expect(keys.length).toBe(33);
    for (const k of keys) expect(suite.created[k].sha256).toBe(suite.base[k].sha256);
  });

  it("new DS PDFs and DOCX take the version-1 branch (differ from unchanged main)", () => {
    for (const k of dsKeys().filter((x) => !x.endsWith(".json"))) expect(same(suite.created[k], suite.base[k])).toBe(false);
  });

  it("hash contract: a re-download of the stored version-1 PDF reproduces its creation hash; DOCX parts reproduce", () => {
    for (const k of dsKeys()) {
      if (k.endsWith(".docx")) expect(suite.redownload[k].parts).toEqual(suite.created[k].parts);
      else expect(suite.redownload[k].sha256).toBe(suite.created[k].sha256);
    }
  });

  it("real PDF text: corrected status wording, D-9 per the oracle, no historical caption, no word hyphenated in the status block (R1 NIT-1)", () => {
    for (const k of dsKeys().filter((x) => x.endsWith(".pdf"))) {
      const o = ORACLE[stateOf(k)];
      const raw = suite.created[k].text ?? "";
      const text = letters(raw);
      expect(text).toContain(letters("MODEL AGREEMENT"));
      expect(text).toContain(letters(o.agreement));
      expect(text).toContain(letters(o.sources));
      expect(text).not.toContain(letters("SOURCE GROUNDING"));
      expect(text).not.toContain(letters(OLD_CAPTION));
      expect(text.split(letters(D9)).length - 1).toBe(o.d9 ? 1 : 0);
      if (o.conclusion488 === "presented" && !k.includes("no_governance_record")) expect(text).toContain(letters(SHOWN_488));
      // Half-width cells (agreement, sources) and the full-width D-9 line: no line of the status block ends in a
      // fragment of one of their words, and each value appears with its words intact. (The Models chips are the shared,
      // legacy-identical identity rendering, outside NIT-1; they hyphenate as historical exports do.)
      const block = raw.slice(raw.indexOf("REPORT STATUS SUMMARY"), Math.max(raw.indexOf("CONCLUSION"), raw.indexOf("PRIMARY SYNTHESIS")));
      const valueWords = [...o.agreement.split(" "), ...o.sources.split(" "), ...(o.d9 ? D9.split(" ") : [])].map(letters).filter(Boolean);
      const split = block
        .split("\n")
        .map((l) => /([A-Za-z]+)-$/.exec(l.trimEnd())?.[1])
        .filter((frag): frag is string => !!frag && valueWords.some((w) => w.length > frag.length && w.startsWith(frag)));
      expect({ k, split }).toEqual({ k, split: [] });
      const words = block.replace(/\s+/g, " ");
      for (const w of [...o.agreement.split(" "), ...o.sources.split(" ")]) expect(words).toContain(w.replace(/[;.]$/, ""));
      if (o.d9) for (const w of D9.split(" ")) expect(words).toContain(w.replace(/[;.,)]$/, "").replace(/^\(/, ""));
    }
  });

  it("layout: no lib/pdf/layoutIntegrity violation in any new PDF, and the rules detect the known-bad canary", () => {
    expect(suite.canaryViolations).toBeGreaterThan(0);
    const pdfs = Object.entries(suite.created).filter(([, d]) => d.format === "pdf");
    expect(pdfs.length).toBe(36);
    for (const [k, d] of pdfs) expect({ k, v: d.layoutViolations }).toEqual({ k, v: [] });
  });

  it("every PDF parses with pdf.js and every DOCX package has its core parts and readable paragraphs", () => {
    for (const d of Object.values(suite.created)) {
      if (d.format === "pdf") expect(d.pages).toBeGreaterThanOrEqual(1);
      if (d.format === "docx") {
        expect(Object.keys(d.parts ?? {})).toEqual(expect.arrayContaining(["[Content_Types].xml", "word/document.xml", "docProps/core.xml"]));
        expect((d.paragraphs ?? []).length).toBeGreaterThan(10);
      }
    }
  });
});
