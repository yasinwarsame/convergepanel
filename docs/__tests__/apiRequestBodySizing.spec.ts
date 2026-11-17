/**
 * Addendum 3, item B — quantified evidence for the owner-approved request body cap of
 * 524,288 bytes (512 KiB).
 *
 * For each encoding tier this spec BUILDS the largest legal create request literally (as raw
 * bytes), checks that it is legal (it parses as JSON, every length limit holds after NFC, the
 * metadata aggregate holds, and the contract schema from openapi.yaml accepts the NFC form), and
 * measures its exact byte length. The tier table in error-catalog.md §4.3.1 must equal the
 * computed numbers, so the documented evidence cannot drift from the computation.
 *
 * The non-NFC tiers depend on the Unicode version of the runtime (Node's ICU): the worst raw
 * bytes per counted (NFC) code point is found by scanning every code point with
 * String.prototype.normalize. The table records the Unicode version it was computed with; on a
 * runtime with a different Unicode version the exact-number assertions are replaced by the
 * verdict invariants (which hold either way).
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { codePoints, compile, dereference } from "./support/jsonSchemaSubset";

const ROOT = path.resolve(__dirname, "..", "..");
const CATALOG = path.join(ROOT, "docs/product/api-0/error-catalog.md");
const OPENAPI = path.join(ROOT, "docs/product/api-0/openapi.yaml");

const BODY_LIMIT = 524_288;
/** The Unicode version error-catalog.md §4.3.1 was computed with. Must equal the doc's statement. */
const DOCUMENTED_UNICODE = "17.0";
const LIMITS = { question: 4000, context: 20000, metaKeys: 20, metaKeyLen: 40, metaValueLen: 500, metaTotal: 4000, models: 5, modelLen: 64 };

type Mode = "utf8" | "escape";

/** JSON string literal. `utf8`: raw UTF-8 (only `"` and `\` escaped). `escape`: every code point as \uXXXX (BMP) or a surrogate pair (supplementary). */
function lit(s: string, mode: Mode): string {
  if (mode === "utf8") return JSON.stringify(s);
  let out = '"';
  for (let i = 0; i < s.length; i++) out += "\\u" + s.charCodeAt(i).toString(16).padStart(4, "0");
  return out + '"';
}

const escBytes = (cp: number): number => (cp > 0xffff ? 12 : 6);
const utf8Bytes = (cp: number): number => Buffer.byteLength(String.fromCodePoint(cp), "utf8");

interface Worst { cp: number; raw: string; bytesEscape: number; bytesUtf8: number }

/**
 * For every NFC-stable code point c, the most expensive canonically equivalent raw sequence is
 * NFD(c) with each element replaced by its most expensive singleton equivalent. Proof sketch in
 * error-catalog.md §4.3.1: raw length <= len(NFD(raw)) = sum over NFC code points of len(NFD(c)),
 * and a multi-code-point raw element never costs more per NFD element than a singleton.
 */
function scanWorst(): { escape: Worst; utf8: Worst; maxDecomposition: number } {
  const singleton = new Map<number, number[]>(); // NFD target -> raw single code points
  let maxDecomposition = 0;
  for (let x = 0; x <= 0x10ffff; x++) {
    if (x >= 0xd800 && x <= 0xdfff) continue;
    const d = Array.from(String.fromCodePoint(x).normalize("NFD"), (ch) => ch.codePointAt(0) as number);
    if (d.length > maxDecomposition) maxDecomposition = d.length;
    if (d.length === 1) {
      const list = singleton.get(d[0]) ?? [];
      list.push(x);
      singleton.set(d[0], list);
    }
  }
  const pick = (d: number, cost: (cp: number) => number): number =>
    (singleton.get(d) ?? [d]).reduce((best, x) => (cost(x) > cost(best) ? x : best), d);
  const best = (cost: (cp: number) => number): Worst => {
    let top: Worst | null = null;
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const s = String.fromCodePoint(c);
      if (s.normalize("NFC") !== s) continue;
      // Only letters and other visible code points, so text made of them is legal input (m4).
      if (!/[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Cs}\p{Z}\p{M}]/u.test(s)) continue;
      const parts = Array.from(s.normalize("NFD"), (ch) => pick(ch.codePointAt(0) as number, cost));
      const w = parts.reduce((a, x) => a + cost(x), 0);
      if (!top || w > (cost === escBytes ? top.bytesEscape : top.bytesUtf8)) {
        top = {
          cp: c,
          raw: String.fromCodePoint(...parts),
          bytesEscape: parts.reduce((a, x) => a + escBytes(x), 0),
          bytesUtf8: parts.reduce((a, x) => a + utf8Bytes(x), 0),
        };
      }
    }
    return top as Worst;
  };
  return { escape: best(escBytes), utf8: best(utf8Bytes), maxDecomposition };
}

/** The metadata layout (entry count, key and value code points) that maximizes bytes. */
function worstMetadata(keyCost: number, valueCost: number): { n: number; keyCps: number; valueCps: number } {
  let top = { n: 0, keyCps: 0, valueCps: 0, bytes: -1 };
  for (let n = 1; n <= LIMITS.metaKeys; n++) {
    for (let valueCps = 0; valueCps <= Math.min(LIMITS.metaValueLen * n, LIMITS.metaTotal - n); valueCps++) {
      const keyCps = Math.min(LIMITS.metaKeyLen * n, LIMITS.metaTotal - valueCps);
      const bytes = keyCps * keyCost + valueCps * valueCost + n * 6;
      if (bytes > top.bytes) top = { n, keyCps, valueCps, bytes };
    }
  }
  return top;
}

function spread(total: number, parts: number, max: number, min = 0): number[] {
  const out = Array.from({ length: parts }, () => min);
  let left = total - min * parts;
  for (let i = 0; i < parts && left > 0; i++) {
    const add = Math.min(max - min, left);
    out[i] += add;
    left -= add;
  }
  expect(left).toBe(0);
  return out;
}

interface Tier { id: string; label: string; mode: Mode; textUnit: string; nfc: boolean }

function build(t: Tier): string {
  const unit = t.textUnit; // the raw form of ONE counted (NFC) code point
  const name = (s: string): string => lit(s, t.mode);
  // A leading ASCII letter keeps the text legal even if `unit` were a mark.
  const text = (n: number): string => "a" + unit.repeat(n - 1);
  const keyCost = t.mode === "escape" ? 6 : 1;
  const unitCps = codePoints(unit);
  const valueCost = Buffer.byteLength(t.mode === "escape" ? lit(unit, "escape") : unit, "utf8") - (t.mode === "escape" ? 2 : 0);
  const m = worstMetadata(keyCost, valueCost);
  const keyLens = spread(m.keyCps, m.n, LIMITS.metaKeyLen, 1);
  const valLens = spread(m.valueCps, m.n, LIMITS.metaValueLen);
  const keyChars = "abcdefghijklmnopqrstuvwxyz";
  const meta = keyLens.map((kl, i) => {
    const key = keyChars[i] + "x".repeat(kl - 1);
    const val = unit.repeat(valLens[i]);
    return `${name(key)}:${lit(val, t.mode)}`;
  });
  expect(unitCps).toBeGreaterThanOrEqual(1);
  const models = Array.from({ length: LIMITS.models }, (_, i) => lit("m".repeat(LIMITS.modelLen - 1) + String(i), t.mode));
  return (
    "{" +
    `${name("type")}:${lit("research", t.mode)},` +
    `${name("input")}:{${name("question")}:${lit(text(LIMITS.question), t.mode)},${name("context")}:${lit(text(LIMITS.context), t.mode)}},` +
    `${name("models")}:[${models.join(",")}],` +
    `${name("options")}:{${name("synthesis")}:false,${name("allow_fallback")}:false,${name("retain_input")}:false,${name("retain_model_responses")}:false},` +
    `${name("metadata")}:{${meta.join(",")}}` +
    "}"
  );
}

const nfcDeep = (v: unknown): unknown => {
  if (typeof v === "string") return v.normalize("NFC");
  if (Array.isArray(v)) return v.map(nfcDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.normalize("NFC"), nfcDeep(x)]));
  return v;
};

function documentedTiers(): { unicode: string; rows: Map<string, number>; text: string } {
  const md = fs.readFileSync(CATALOG, "utf8");
  const start = md.indexOf("#### 4.3.1");
  const end = md.indexOf("### 4.4", start);
  expect(start).toBeGreaterThan(-1);
  const text = md.slice(start, end);
  const unicode = /computed with Unicode (\d+\.\d+)/.exec(text)?.[1] ?? "";
  const rows = new Map<string, number>();
  for (const m of text.matchAll(/^\| (T\d) \| [^|]+ \| [^|]+ \| ([\d,]+) \| ([\d.]+)% \| (fits|exceeds) \|$/gm)) {
    rows.set(m[1], Number(m[2].replace(/,/g, "")));
  }
  return { unicode, rows, text };
}

describe("B: the 512 KiB body cap against every legal request encoding", () => {
  const worst = scanWorst();
  const tiers: Tier[] = [
    { id: "T1", label: "NFC, ASCII", mode: "utf8", textUnit: "a", nfc: true },
    { id: "T2", label: "NFC, CJK (3-byte UTF-8)", mode: "utf8", textUnit: "中", nfc: true },
    { id: "T3", label: "NFC, supplementary (4-byte UTF-8)", mode: "utf8", textUnit: "\u{1F600}", nfc: true },
    { id: "T4", label: "NFC, BMP escapes", mode: "escape", textUnit: "中", nfc: true },
    { id: "T5", label: "NFC, surrogate-pair escapes", mode: "escape", textUnit: "\u{1F600}", nfc: true },
    { id: "T6", label: "non-NFC, raw UTF-8", mode: "utf8", textUnit: worst.utf8.raw, nfc: false },
    { id: "T7", label: "non-NFC, escapes", mode: "escape", textUnit: worst.escape.raw, nfc: false },
  ];
  const schema = compile(dereference(yaml.load(fs.readFileSync(OPENAPI, "utf8")), "#/components/schemas/CreateVerificationRequest"));
  const bytes = new Map<string, number>();

  it.each(tiers.map((t) => [t.id, t] as const))("%s builds a LEGAL maximal request and measures it", (_id, t) => {
    const body = build(t);
    const parsed = JSON.parse(body) as { input: { question: string; context: string }; metadata: Record<string, string> };
    const n = nfcDeep(parsed) as typeof parsed;
    expect(codePoints(n.input.question)).toBe(LIMITS.question);
    expect(codePoints(n.input.context)).toBe(LIMITS.context);
    const metaTotal = Object.entries(n.metadata).reduce((a, [k, v]) => a + codePoints(k) + codePoints(v), 0);
    expect(metaTotal).toBeLessThanOrEqual(LIMITS.metaTotal);
    expect(schema(n)).toBe(true);
    // The non-NFC tiers really are non-NFC on the wire, and carry more raw code points.
    if (!t.nfc) expect(codePoints(parsed.input.context)).toBeGreaterThan(LIMITS.context);
    else expect(parsed.input.context).toBe(n.input.context);
    bytes.set(t.id, Buffer.byteLength(body, "utf8"));
  });

  it("the worst raw bytes per counted code point are found by an exhaustive scan", () => {
    expect(worst.maxDecomposition).toBe(4);
    // NFC escaped text is at most 12 bytes per code point; decomposition multiplies it.
    expect(worst.escape.bytesEscape).toBeGreaterThanOrEqual(24);
    expect(worst.utf8.bytesUtf8).toBeGreaterThanOrEqual(12);
  });

  it("the Unicode version the doc declares is pinned in this spec (the gate cannot be dodged by editing the doc)", () => {
    expect(documentedTiers().unicode).toBe(DOCUMENTED_UNICODE);
  });

  it("verdict on THIS runtime's own computation: every NFC tier fits, the decomposed+escaped tier T7 exceeds", () => {
    for (const t of tiers.filter((x) => x.nfc)) expect({ tier: t.id, fits: (bytes.get(t.id) as number) <= BODY_LIMIT }).toEqual({ tier: t.id, fits: true });
    expect(bytes.get("T5") as number).toBeLessThanOrEqual(BODY_LIMIT);
    expect(bytes.get("T7") as number).toBeGreaterThan(BODY_LIMIT);
    expect(documentedTiers().text).toContain("OWNER DECISION REQUIRED");
  });

  it("error-catalog.md §4.3.1 records exactly the computed numbers (all tiers when the runtime Unicode version matches; NFC tiers always)", () => {
    const doc = documentedTiers();
    expect(Array.from(doc.rows.keys())).toEqual(tiers.map((t) => t.id));
    const exact = process.versions.unicode === DOCUMENTED_UNICODE;
    if (!exact) {
      // Visible on every run where the non-NFC figures could not be re-derived exactly.
      console.warn(`apiRequestBodySizing: runtime Unicode ${process.versions.unicode} != documented ${DOCUMENTED_UNICODE}; ` +
        "the non-NFC tier figures (T6, T7) were NOT re-derived exactly; only the verdict was checked.");
    }
    for (const t of tiers) {
      if (!exact && !t.nfc) continue;
      const b = bytes.get(t.id) as number;
      expect({ tier: t.id, bytes: doc.rows.get(t.id) }).toEqual({ tier: t.id, bytes: b });
      const row = new RegExp(`^\\| ${t.id} \\| .* \\| (fits|exceeds) \\|$`, "m").exec(doc.text)?.[1];
      expect({ tier: t.id, verdict: row }).toEqual({ tier: t.id, verdict: b <= BODY_LIMIT ? "fits" : "exceeds" });
    }
    if (exact) {
      expect(doc.text).toContain(`U+${worst.escape.cp.toString(16).toUpperCase()}`);
      expect(doc.text).toContain(`${worst.escape.bytesEscape} bytes`);
    }
  });

  it("the body cap is 524,288 bytes everywhere it is stated", () => {
    const api = yaml.load(fs.readFileSync(OPENAPI, "utf8")) as { components: { responses: { TooLarge: { description: string } } } };
    expect(api.components.responses.TooLarge.description).toContain("524,288 bytes");
    const md = fs.readFileSync(CATALOG, "utf8");
    expect(md).toContain("| Request body | **524,288 bytes (512 KiB)");
    for (const f of ["docs/product/api-0/error-catalog.md", "docs/product/api-0/openapi.yaml", "docs/product/api-0/threat-model.md"]) {
      expect({ f, stale: /65,536|64 KiB|64 KB/.test(fs.readFileSync(path.join(ROOT, f), "utf8")) }).toEqual({ f, stale: false });
    }
  });
});
