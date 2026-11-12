/**
 * Issue #315 — bounded Levenshtein in textSimilarity.ts.
 *
 * The full (n+1)×(m+1) matrix was replaced by an exact bounded test of
 * `levenshtein(normA, normB) / maxLen <= ratio`. These tests compare the new
 * code against a VERBATIM copy of the original implementation (the oracle
 * below — never import it from the subject), for the distance itself where it
 * is ≤ k and for the two public predicates at every ratio a real caller uses.
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import {
  boundedLevenshtein,
  dedupeTextList,
  maxEditsWithinRatio,
  slugsMatch,
  textsAreNearDuplicates,
} from "@/lib/adaptiveSchema/textSimilarity";

// ─── Oracle: the original code, verbatim (textSimilarity.ts at d3789e6; the two predicates call
// the memoized oracleDistance, which is that same levenshtein) ─────

// Jest runs specs in a vm context, where every free global lookup (`Math.min`, `Array`) in the oracle's
// inner loop is ~10× slower; binding them lexically keeps the verbatim body below and makes it affordable.
const { Math, Array } = globalThis;

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "to", "is", "are", "for", "with", "by", "vs",
]);

function normalizeSlug(slug: string): string {
  return slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugTokens(slug: string): string[] {
  return normalizeSlug(slug)
    .split("-")
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** Memoized wrapper over the verbatim oracle (pure, so caching cannot change a result). */
const oracleCache = new Map<string, number>();
function oracleDistance(a: string, b: string): number {
  const key = `${a}\u0000${b}`;
  let d = oracleCache.get(key);
  if (d === undefined) {
    d = levenshtein(a, b);
    if (a.length * b.length > 10_000) oracleCache.set(key, d);
  }
  return d;
}

function oracleSlugsMatch(slugA: string, slugB: string): boolean {
  const normA = normalizeSlug(slugA);
  const normB = normalizeSlug(slugB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen > 0 && oracleDistance(normA, normB) / maxLen <= 0.3) {
    return true;
  }

  const tokensA = slugTokens(slugA);
  const tokensB = slugTokens(slugB);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setB = new Set(tokensB);
  const overlap = tokensA.filter((t) => setB.has(t)).length;
  return overlap / Math.min(tokensA.length, tokensB.length) >= 0.5;
}

function oracleTextsAreNearDuplicates(
  a: string,
  b: string,
  opts: { levenshteinMaxRatio: number; tokenOverlapMin: number }
): boolean {
  const normA = normalizeSlug(a);
  const normB = normalizeSlug(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen > 0 && oracleDistance(normA, normB) / maxLen <= opts.levenshteinMaxRatio) {
    return true;
  }

  const tokensA = slugTokens(a);
  const tokensB = slugTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setB = new Set(tokensB);
  const overlap = tokensA.filter((t) => setB.has(t)).length;
  return overlap / Math.min(tokensA.length, tokensB.length) >= opts.tokenOverlapMin;
}

// ─── Thresholds used by real callers ────────────────────────────────────────

/** Every (levenshteinMaxRatio, tokenOverlapMin) pair passed by a production caller (pinned against the source below). */
const CALLER_THRESHOLDS = [
  { levenshteinMaxRatio: 0.15, tokenOverlapMin: 1.01 }, // comparison/decisionSupport subject+option identity
  { levenshteinMaxRatio: 0.2, tokenOverlapMin: 0.7 }, // config.ts TEXT_DEDUP_THRESHOLDS
  { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.7 }, // FACTOR / DIMENSION / CRITERION
  { levenshteinMaxRatio: 0.25, tokenOverlapMin: 0.6 }, // LABEL / ATTRIBUTE
  { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5 }, // LIST / SUBFIELD / NOTES / VALUE / NARRATIVE
  { levenshteinMaxRatio: 0.35, tokenOverlapMin: 0.45 }, // PROSE / DIRECT_ANSWER / RISK
];
const CALLER_RATIOS = [0.15, 0.2, 0.25, 0.3, 0.35];
/** tokenOverlapMin = Infinity disables the token branch, so the predicate is the Levenshtein branch alone. */
const LEV_ONLY = CALLER_RATIOS.map((levenshteinMaxRatio) => ({ levenshteinMaxRatio, tokenOverlapMin: Infinity }));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

// ─── Deterministic generators ──────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(r: () => number, alphabet: string, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

function mutate(r: () => number, s: string, alphabet: string, edits: number): string {
  let out = s;
  for (let e = 0; e < edits; e++) {
    const op = Math.floor(r() * 3);
    const pos = Math.floor(r() * (out.length + 1));
    const ch = alphabet[Math.floor(r() * alphabet.length)];
    if (op === 0) out = out.slice(0, pos) + ch + out.slice(pos);
    else if (op === 1 && out.length > 0) out = out.slice(0, Math.min(pos, out.length - 1)) + out.slice(Math.min(pos, out.length - 1) + 1);
    else if (out.length > 0) {
      const p = Math.min(pos, out.length - 1);
      out = out.slice(0, p) + ch + out.slice(p + 1);
    }
  }
  return out;
}

function allStrings(alphabet: string, maxLen: number): string[] {
  const out = [""];
  let frontier = [""];
  for (let len = 1; len <= maxLen; len++) {
    frontier = frontier.flatMap((s) => alphabet.split("").map((c) => s + c));
    out.push(...frontier);
  }
  return out;
}

/** The bounded distance must equal the original where it is ≤ k and be Infinity (never ≤ k) otherwise. */
function expectBoundedMatches(a: string, b: string, k: number, d: number = levenshtein(a, b)): void {
  const got = boundedLevenshtein(a, b, k);
  const want = d <= k ? d : Number.POSITIVE_INFINITY;
  if (got !== want) throw new Error(`boundedLevenshtein(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${k}) = ${got}, oracle ${d}`);
}

let predicateComparisons = 0;
function expectPredicatesMatch(a: string, b: string): void {
  for (const opts of [...CALLER_THRESHOLDS, ...LEV_ONLY]) {
    const got = textsAreNearDuplicates(a, b, opts);
    const want = oracleTextsAreNearDuplicates(a, b, opts);
    if (got !== want) throw new Error(`textsAreNearDuplicates(${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(opts)}) = ${got}, oracle ${want}`);
    predicateComparisons++;
  }
  if (slugsMatch(a, b) !== oracleSlugsMatch(a, b)) throw new Error(`slugsMatch(${JSON.stringify(a)}, ${JSON.stringify(b)}) differs from oracle`);
  predicateComparisons++;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("the thresholds under test are the ones real callers pass", () => {
  it("every levenshteinMaxRatio literal in production code is covered", () => {
    const root = process.cwd();
    const ratios = new Set<number>();
    for (const dir of ["lib", "components", "app"]) {
      for (const file of sourceFiles(join(root, dir))) {
        for (const m of readFileSync(file, "utf8").matchAll(/levenshteinMaxRatio:\s*([0-9.]+)/g)) ratios.add(Number(m[1]));
      }
    }
    expect(Array.from(ratios).sort()).toEqual(CALLER_RATIOS);
    // slugsMatch's hard-coded 0.3 and its 0.5 overlap are covered by expectPredicatesMatch.
    expect(readFileSync(join(root, "lib/adaptiveSchema/textSimilarity.ts"), "utf8")).toContain("normalizedLevenshteinWithin(normA, normB, 0.3)");
  });
});

describe("maxEditsWithinRatio reproduces `d / maxLen <= ratio` exactly", () => {
  const ratios = [...CALLER_RATIOS, 0, -0, 0.1, 1 / 3, 0.7, 0.9999999999999999, 1, 1.5, -0.1, 1e-12];

  it("exhaustively over every d for maxLen ≤ 600", () => {
    let checks = 0;
    for (let maxLen = 1; maxLen <= 600; maxLen++) {
      for (const ratio of ratios) {
        const k = maxEditsWithinRatio(maxLen, ratio);
        for (let d = 0; d <= maxLen; d++) {
          if (d / maxLen <= ratio !== d <= k) throw new Error(`maxLen=${maxLen} ratio=${ratio} d=${d} k=${k}`);
          checks++;
        }
      }
    }
    expect(checks).toBeGreaterThan(2_500_000);
  });

  it("at the boundary for every maxLen ≤ 200000", () => {
    for (let maxLen = 1; maxLen <= 200_000; maxLen++) {
      for (const ratio of CALLER_RATIOS) {
        const k = maxEditsWithinRatio(maxLen, ratio);
        if (!(k >= 0 && k / maxLen <= ratio)) throw new Error(`k too large: maxLen=${maxLen} ratio=${ratio} k=${k}`);
        if (k < maxLen && (k + 1) / maxLen <= ratio) throw new Error(`k too small: maxLen=${maxLen} ratio=${ratio} k=${k}`);
      }
    }
  });

  it("degenerate ratios: NaN and negatives admit nothing, ≥ 1 and Infinity admit everything", () => {
    expect(maxEditsWithinRatio(10, NaN)).toBe(-1);
    expect(maxEditsWithinRatio(10, -0.01)).toBe(-1);
    expect(maxEditsWithinRatio(10, -Infinity)).toBe(-1);
    expect(maxEditsWithinRatio(10, 0)).toBe(0);
    expect(maxEditsWithinRatio(10, 1)).toBe(10);
    expect(maxEditsWithinRatio(10, Infinity)).toBe(10);
    // FP boundary: 0.3 * 10 is 3.0000000000000004, but 3 / 10 <= 0.3 holds, so 3 is admitted.
    expect(maxEditsWithinRatio(10, 0.3)).toBe(3);
    expect(3 / 10 <= 0.3).toBe(true);
    // and the other direction: 0.35 * 180 is 62.99999999999999, but 63 / 180 <= 0.35 holds — floor alone would reject d = 63.
    expect(Math.floor(0.35 * 180)).toBe(62);
    expect(63 / 180 <= 0.35).toBe(true);
    expect(maxEditsWithinRatio(180, 0.35)).toBe(63);
  });
});

describe("boundedLevenshtein against the original", () => {
  it("exhaustively: every pair over {a,b} up to length 7, every k in 0..8", () => {
    const strings = allStrings("ab", 7);
    let pairs = 0;
    for (const a of strings) {
      for (const b of strings) {
        const d = levenshtein(a, b);
        for (let k = 0; k <= 8; k++) expectBoundedMatches(a, b, k, d);
        pairs++;
      }
    }
    expect(pairs).toBe(255 * 255);
  });

  it("exhaustively: every pair over {a,b,c} up to length 4, every k in 0..5", () => {
    const strings = allStrings("abc", 4);
    for (const a of strings) {
      for (const b of strings) {
        const d = levenshtein(a, b);
        for (let k = 0; k <= 5; k++) expectBoundedMatches(a, b, k, d);
      }
    }
    expect(strings.length).toBe(121);
  });

  it("k < 0, NaN or fractional", () => {
    expect(boundedLevenshtein("abc", "abc", -1)).toBe(Number.POSITIVE_INFINITY);
    expect(boundedLevenshtein("abc", "abd", NaN)).toBe(Number.POSITIVE_INFINITY);
    expect(boundedLevenshtein("abc", "abd", 1.9)).toBe(1);
    expect(boundedLevenshtein("abc", "xyz", 2.9)).toBe(Number.POSITIVE_INFINITY);
    expect(boundedLevenshtein("", "", 0)).toBe(0);
    expect(boundedLevenshtein("", "abc", 3)).toBe(3);
    expect(boundedLevenshtein("abc", "", 2)).toBe(Number.POSITIVE_INFINITY);
  });

  it("randomized (fixed seed): 6000 pairs, k at d−2..d+2 and at every caller ratio", () => {
    const r = mulberry32(315);
    const alphabets = ["ab", "abcd", "abcdefghijklmnopqrstuvwxyz0123456789-", "-a"];
    let checks = 0;
    for (let n = 0; n < 6000; n++) {
      const alphabet = alphabets[n % alphabets.length];
      const base = randomString(r, alphabet, Math.floor(r() * 120));
      const other = r() < 0.15 ? randomString(r, alphabet, Math.floor(r() * 120)) : mutate(r, base, alphabet, Math.floor(r() * Math.max(1, base.length * 0.5)));
      const d = levenshtein(base, other);
      for (let k = Math.max(0, d - 2); k <= d + 2; k++) {
        expectBoundedMatches(base, other, k, d);
        expectBoundedMatches(other, base, k, d);
        checks += 2;
      }
      const maxLen = Math.max(base.length, other.length);
      if (maxLen > 0) {
        for (const ratio of CALLER_RATIOS) {
          const k = maxEditsWithinRatio(maxLen, ratio);
          expect(boundedLevenshtein(base, other, k) <= k).toBe(d / maxLen <= ratio);
          checks++;
        }
      }
    }
    expect(checks).toBeGreaterThan(60_000);
  });

  it("near-boundary (fixed seed): distances straddling floor(ratio · maxLen) for each caller ratio", () => {
    const r = mulberry32(4150);
    const alphabet = "abcdefghij";
    let atBoundary = 0;
    for (let n = 0; n < 2500; n++) {
      const ratio = CALLER_RATIOS[n % CALLER_RATIOS.length];
      const base = randomString(r, alphabet, 20 + Math.floor(r() * 140));
      const target = Math.floor(ratio * base.length) + Math.floor(r() * 5) - 2;
      const other = mutate(r, base, alphabet, Math.max(0, target));
      const d = levenshtein(base, other);
      const maxLen = Math.max(base.length, other.length);
      const k = maxEditsWithinRatio(maxLen, ratio);
      if (Math.abs(d - k) <= 1) atBoundary++;
      expectBoundedMatches(base, other, k, d);
      expect(boundedLevenshtein(base, other, k) <= k).toBe(d / maxLen <= ratio);
    }
    expect(atBoundary).toBeGreaterThan(300);
  });

  it("adversarial long strings (≈1.2 KB, the largest the full-matrix oracle runs in reasonable time)", () => {
    const words = "word ".repeat(240);
    const r = mulberry32(99);
    const prose = randomString(r, "abcdefghijklmnopqrstuvwxyz     ", 1200);
    const cases: Array<[string, string]> = [
      [`u0 ${words}`, `u1 ${words}`], // the #315 shape: repeated words, one-character difference
      [words, words.slice(0, 600) + "x" + words.slice(601)], // one substitution in the middle
      [words, "x" + words], // one insertion at the start
      [words, words + "x"], // one insertion at the end
      [words, words.slice(1)], // one deletion
      [words, "drow ".repeat(240)], // same multiset, every word reversed
      [prose, randomString(r, "abcdefghijklmnopqrstuvwxyz     ", 1200)], // completely different
      [prose, randomString(r, "0123456789", 1200)], // disjoint alphabets
      [prose, prose.split("").reverse().join("")],
      [prose, mutate(r, prose, "abcdefghijklmnopqrstuvwxyz ", 300)],
      [prose, mutate(r, prose, "abcdefghijklmnopqrstuvwxyz ", 420)],
      ["ab".repeat(600), "ba".repeat(600)], // periodic shift
      ["a".repeat(1200), "a".repeat(800)], // pure length difference
      ["a".repeat(1200), "b".repeat(1200)],
      ["é日本🙂".repeat(240), "é日本🙂".repeat(239) + "e日本🙂"], // multi-byte / surrogate pairs (UTF-16 code units)
      ["🙂".repeat(500), "🙃".repeat(500)], // differ in the low surrogate only
    ];
    for (const [a, b] of cases) {
      const d = levenshtein(a, b);
      const maxLen = Math.max(a.length, b.length);
      const ks = new Set([0, 1, d - 1, d, d + 1, ...CALLER_RATIOS.map((ratio) => maxEditsWithinRatio(maxLen, ratio))]);
      for (const k of ks) {
        if (k < 0) continue;
        expectBoundedMatches(a, b, k, d);
        expectBoundedMatches(b, a, k, d);
      }
      expectPredicatesMatch(a, b);
    }
  });
});

describe("textsAreNearDuplicates and slugsMatch are unchanged", () => {
  const PROSE = [
    "It's unclear how much of the inflation spike was driven by supply chain disruption versus monetary policy.",
    "The relative contribution of supply chain disruption vs monetary policy to the inflation spike is unclear.",
    "It's unclear whether the Fed will cut rates again this year.",
    "Pricing for both products changes frequently, so the comparison may be out of date.",
    "Pricing changes frequently for both products; this comparison may already be out of date.",
    "Limited public benchmarks exist for the newer model.",
    "There are limited public benchmarks for the newer model.",
    "Long-term health effects have not been studied in large randomized trials.",
    "No large randomized trials have studied the long-term health effects.",
    "Carbon taxes reduce emissions more cheaply than regulatory standards in most sectors.",
    "Regulatory standards can act faster than carbon taxes where demand is inelastic.",
    "Enforcement capacity varies widely across jurisdictions.",
    "Enforcement capacity varies across jurisdictions.",
    "Results may not generalize outside high-income countries.",
    "Results may not generalise outside of high-income countries.",
    "The study population was small (n = 42) and drawn from a single clinic.",
    "Single-clinic sample of 42 participants limits generalizability.",
    "Data after 2024 was not available to the panel.",
    "Data after 2023 was not available to the panel.",
    "Whether the subsidy will be renewed in 2027 is unknown.",
    "iPhone 15", "iPhone 15 Pro", "Tesla Model 3", "Model 3 Tesla", "Perplexity", "Perplexity Pro",
    "demand-pull-inflation", "demand-pull-inflaton", "supply-chain-disruption", "cost-push-inflation",
    "the of and", "", "   ", "!!!", "Ünïcödé — façade naïve café", "unicode facade naive cafe", "日本語のテキスト", "中文文本",
  ];

  it("over every pair of a realistic model-prose corpus, both orders", () => {
    for (const a of PROSE) for (const b of PROSE) expectPredicatesMatch(a, b);
    expect(predicateComparisons).toBeGreaterThan(PROSE.length * PROSE.length * 10);
  });

  it("over randomized near-duplicate sentences (fixed seed)", () => {
    const r = mulberry32(2026);
    const vocab = "the evidence suggests carbon pricing reduces emissions although regulatory standards may achieve faster results in sectors with inelastic demand and uncertain enforcement capacity across jurisdictions of a to is".split(" ");
    for (let n = 0; n < 3000; n++) {
      const len = 3 + Math.floor(r() * 30);
      const words = Array.from({ length: len }, () => vocab[Math.floor(r() * vocab.length)]);
      const edited = words.slice();
      const edits = Math.floor(r() * Math.max(1, len * 0.5));
      for (let e = 0; e < edits; e++) {
        const op = Math.floor(r() * 3);
        const pos = Math.floor(r() * edited.length);
        if (op === 0) edited.splice(pos, 0, vocab[Math.floor(r() * vocab.length)]);
        else if (op === 1 && edited.length > 1) edited.splice(pos, 1);
        else edited[pos] = vocab[Math.floor(r() * vocab.length)];
      }
      const a = words.join(" ");
      const b = r() < 0.3 ? edited.join(" ").toUpperCase() + "." : edited.join(" ");
      expectPredicatesMatch(a, b);
    }
  });
});

describe("long inputs are bounded (#315 regression)", () => {
  it("the 3 × 7.5 KB uncertainties case dedupes in well under 2 s, merging the one-character variants", () => {
    const items = Array.from({ length: 3 }, (_, i) => `u${i} ${"word ".repeat(1500)}`);
    expect(items.map((s) => s.length)).toEqual([7503, 7503, 7503]);
    const t0 = performance.now();
    const out = dedupeTextList(items, { levenshteinMaxRatio: 0.3, tokenOverlapMin: 0.5, cap: 5 });
    expect(performance.now() - t0).toBeLessThan(2000);
    // normalized strings differ in exactly one character, so the original merged all three too
    expect(boundedLevenshtein(normalizeSlug(items[0]), normalizeSlug(items[1]), 1)).toBe(1);
    expect(out).toEqual([items[0]]);
  });

  it("two dissimilar 7.5 KB items: the bounded check rejects them in well under 2 s", () => {
    const r = mulberry32(7);
    const a = randomString(r, "abcdefghijklmnopqrstuvwxyz ", 7500);
    const b = randomString(r, "abcdefghijklmnopqrstuvwxyz ", 7500);
    const t0 = performance.now();
    const results = LEV_ONLY.map((opts) => textsAreNearDuplicates(a, b, opts));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(results).toEqual(LEV_ONLY.map(() => false));
  });
});
