/**
 * Order 6 / S-E.2 (H1-A): real rendered bytes. Runs renderExports.mjs (the real production dispatcher: @react-pdf
 * PDF, docx DOCX, JSON serializer) in child Node processes with TZ=UTC, and compares against the baseline captured
 * from unchanged main 0249a4e5 before any production change (__fixtures__/historicalBaseline.json).
 *
 * Comparison rules: PDF and JSON by sha256 of the complete bytes; DOCX by the sha256 of every package part after
 * removing only docProps/core.xml's created/modified timestamps (DOCX embeds wall-clock dates and is documented as not
 * byte-reproducible; `hashReproducible` is false for it).
 *
 * Scope of the PDF claim: these fixtures render identically across repeated runs in this environment. That is not a
 * general cross-environment determinism guarantee: some longer multi-page PDFs render to one of several byte variants
 * from the same record, on main as well (see the S-E.2 PR record).
 */
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import historicalRecords from "./__fixtures__/historicalRecords.json";
import historicalBaseline from "./__fixtures__/historicalBaseline.json";
import versionOnePins from "./__fixtures__/versionOnePdfPins.json";
import { D9, ORACLE, OLD_CAPTION, SHOWN_488, stateOf } from "./dsExportOracle";

type Digest = { format: string; sha256: string; length: number; creationSha256?: string; parts?: Record<string, string>; text?: string; pages?: number };
type Run = { tz: string | null; deps: Record<string, string>; entries: Record<string, Digest> };

const SCRIPT = path.join(__dirname, "renderExports.mjs");
const HISTORICAL = historicalRecords as Record<string, { format: string; reportSnapshot: Record<string, unknown> }>;
const BASELINE = historicalBaseline as unknown as { deps: Record<string, string>; entries: Record<string, Digest> };
const PINS = (versionOnePins as { entries: Record<string, { sha256: string; length: number; pages: number }> }).entries;

let dir: string;
let historical: Run;
let created: Run;
let redownloaded: Run;

function render(args: string[]): Run {
  const out = path.join(dir, `run-${Math.random().toString(36).slice(2)}.json`);
  execFileSync(process.execPath, [SCRIPT, "--out", out, ...args], { env: { ...process.env, TZ: "UTC" }, stdio: "pipe", timeout: 240_000 });
  return JSON.parse(readFileSync(out, "utf8"));
}

const same = (a: Digest, b: Digest) => (a.format === "docx" ? JSON.stringify(a.parts) === JSON.stringify(b.parts) : a.sha256 === b.sha256 && a.length === b.length);
const letters = (t: string) => t.replace(/[^A-Za-z0-9]/g, "");

const INVALID: [string, unknown][] = [
  ["null", null],
  ["empty", {}],
  ["marker-null", { dsLabelWordingVersion: null }],
  ["marker-string-1", { dsLabelWordingVersion: "1" }],
  ["marker-2", { dsLabelWordingVersion: 2 }],
  ["marker-true", { dsLabelWordingVersion: true }],
  ["array", [1]],
];
const VARIANT_BASES = ["ds.uncontested_choose_option.unreviewed_in_queue", "ds.unresolved_option_488.unreviewed_in_queue", "ds.no_recommendation_no_options.unreviewed_in_queue"];
const FORGED_BASES = ["nonds.comparison_matrix.unreviewed_in_queue", "nonds.financial_valuation.approved"];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cp-se2-spec-"));
  // Historical records, plus invalid markers on DS records and a forged version-1 marker on non-DS records.
  const records: Record<string, unknown> = { ...HISTORICAL };
  for (const base of VARIANT_BASES)
    for (const f of ["pdf", "docx", "json"])
      for (const [label, presentation] of INVALID) {
        const r = HISTORICAL[`${base}.${f}`];
        records[`variant.${label}.${base}.${f}`] = { ...r, reportSnapshot: { ...r.reportSnapshot, presentation } };
      }
  for (const base of FORGED_BASES)
    for (const f of ["pdf", "docx", "json"]) {
      const r = HISTORICAL[`${base}.${f}`];
      records[`forged.${base}.${f}`] = { ...r, reportSnapshot: { ...r.reportSnapshot, presentation: { dsLabelWordingVersion: 1 } } };
    }
  const recordsFile = path.join(dir, "historical-and-variants.json");
  writeFileSync(recordsFile, JSON.stringify(records));
  historical = render(["--records", recordsFile]);
  // New exports, built now (marked), then re-downloaded from their stored form in a separate process.
  const stored = path.join(dir, "created-stored.json");
  created = render(["--save-records", stored, "--layout-check"]);
  redownloaded = render(["--records", stored]);
}, 600_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("controlled environment", () => {
  it("renders with TZ=UTC and the dependency versions the baseline was captured with", () => {
    expect(historical.tz).toBe("UTC");
    expect(historical.deps).toEqual(BASELINE.deps);
  });
});

describe("historical records (no marker): byte/part-identical to the 0249a4e5 baseline", () => {
  it("every historical PDF, DOCX and JSON matches", () => {
    const keys = Object.keys(BASELINE.entries);
    expect(keys.length).toBe(105);
    const diffs = keys.filter((k) => !same(historical.entries[k], BASELINE.entries[k]));
    expect(diffs).toEqual([]);
  });

  it("re-downloading a historical PDF reproduces its stored creation hash", () => {
    for (const [k, b] of Object.entries(BASELINE.entries)) {
      if (b.format === "pdf" || b.format === "json") expect(historical.entries[k].sha256).toBe(b.creationSha256);
    }
  });

  it("every invalid marker renders exactly the unmarked historical output", () => {
    for (const base of VARIANT_BASES)
      for (const f of ["pdf", "docx", "json"])
        for (const [label] of INVALID) expect(same(historical.entries[`variant.${label}.${base}.${f}`], BASELINE.entries[`${base}.${f}`])).toBe(true);
  });

  it("a version-1 marker forged onto a non-DS record changes no byte", () => {
    for (const base of FORGED_BASES) for (const f of ["pdf", "docx", "json"]) expect(same(historical.entries[`forged.${base}.${f}`], BASELINE.entries[`${base}.${f}`])).toBe(true);
  });
});

describe("new exports", () => {
  const dsKeys = () => Object.keys(created.entries).filter((k) => k.startsWith("ds."));

  it("non-DS exports built now are byte/part-identical to the baseline", () => {
    const keys = Object.keys(created.entries).filter((k) => k.startsWith("nonds."));
    expect(keys.length).toBe(9);
    for (const k of keys) expect(same(created.entries[k], BASELINE.entries[k])).toBe(true);
  });

  it("JSON of a new DS export is byte-identical to the historical JSON of the same run (marker never serialized)", () => {
    const keys = dsKeys().filter((k) => k.endsWith(".json"));
    expect(keys.length).toBe(32);
    for (const k of keys) expect(created.entries[k].sha256).toBe(BASELINE.entries[k].sha256);
  });

  it("new DS PDFs and DOCX differ from the historical render (the version-1 branch is taken)", () => {
    for (const k of dsKeys().filter((x) => !x.endsWith(".json"))) expect(same(created.entries[k], BASELINE.entries[k])).toBe(false);
  });

  it("version-1 PDF hash: the creation hash is reproduced on re-download, in the same and in a separate process, and equals the pin", () => {
    const keys = dsKeys().filter((k) => k.endsWith(".pdf"));
    expect(Object.keys(PINS).sort()).toEqual(keys.sort());
    for (const k of keys) {
      const c = created.entries[k];
      expect(c.creationSha256).toBe(c.sha256);
      expect(redownloaded.entries[k].sha256).toBe(c.sha256);
      expect({ sha256: c.sha256, length: c.length, pages: c.pages }).toEqual(PINS[k]);
    }
  });

  it("version-1 DOCX: normalized parts reproduced on re-download", () => {
    for (const k of dsKeys().filter((x) => x.endsWith(".docx"))) expect(redownloaded.entries[k].parts).toEqual(created.entries[k].parts);
  });

  it("real PDF text: corrected status wording, D-9 per the oracle, no historical caption", () => {
    for (const k of dsKeys().filter((x) => x.endsWith(".pdf"))) {
      const o = ORACLE[stateOf(k)];
      const text = letters(created.entries[k].text ?? "");
      expect(text).toContain(letters("MODEL AGREEMENT"));
      expect(text).toContain(letters(o.agreement));
      expect(text).not.toContain(letters("SOURCE GROUNDING"));
      expect(text).not.toContain(letters(OLD_CAPTION));
      expect(text.split(letters(D9)).length - 1).toBe(o.d9 ? 1 : 0);
      if (o.conclusion488 === "presented" && !k.includes("no_governance_record")) expect(text).toContain(letters(SHOWN_488));
    }
  });

  it("layout: no lib/pdf/layoutIntegrity violation in any new PDF, and the rules detect the known-bad canary", () => {
    expect((created as Run & { canaryViolations?: number }).canaryViolations).toBeGreaterThan(0);
    const pdfs = Object.entries(created.entries).filter(([, d]) => d.format === "pdf");
    expect(pdfs.length).toBe(35);
    for (const [k, d] of pdfs) expect({ k, v: (d as Digest & { layoutViolations?: unknown[] }).layoutViolations }).toEqual({ k, v: [] });
  });

  it("every PDF parses with pdf.js and every DOCX package has its core parts", () => {
    for (const [k, d] of Object.entries(created.entries)) {
      if (d.format === "pdf") expect(d.pages).toBeGreaterThanOrEqual(1);
      if (d.format === "docx") expect(Object.keys(d.parts ?? {})).toEqual(expect.arrayContaining(["[Content_Types].xml", "word/document.xml", "docProps/core.xml"]));
      expect(k).toBeTruthy();
    }
  });
});
