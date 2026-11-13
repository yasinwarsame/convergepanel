/**
 * Pure text-similarity utilities — normalization, Levenshtein-based
 * similarity, and token-stem overlap.
 *
 * Deliberately has NO "server-only" import: alignment.ts (server) uses
 * `slugsMatch` for claim-id matching, and client renderers (e.g.
 * GenericSectionsView.tsx's Uncertainties/Follow-ups dedup, Part B6) need a
 * cheap, deterministic near-duplicate merge over plain prose with no model
 * call — this module has to be safe to import from either side.
 */

import { ModelId } from "@/lib/types";

const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "or", "in", "on", "to", "is", "are", "for", "with", "by", "vs",
]);

export function normalizeSlug(slug: string): string {
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

/**
 * The largest integer d in [0, maxLen] with `d / maxLen <= ratio`, evaluated
 * with exactly that floating-point expression (so the boundary matches the
 * original `levenshtein(a, b) / maxLen <= ratio` test bit for bit), or -1 when
 * no such d exists (negative or NaN ratio). For a fixed positive maxLen,
 * `d / maxLen` is monotone non-decreasing in the integer d (IEEE division is
 * correctly rounded, and rounding is monotone), so the d satisfying the test
 * are exactly 0..k: `d / maxLen <= ratio` ⇔ `d <= k`. The Levenshtein
 * distance never exceeds maxLen, so k is capped there.
 *
 * Exported for the differential tests only (issue #315).
 */
export function maxEditsWithinRatio(maxLen: number, ratio: number): number {
  let k = Math.floor(ratio * maxLen);
  if (!(k >= 0)) k = -1; // negative or NaN
  if (k > maxLen) k = maxLen;
  // floor(ratio * maxLen) can miss by one under rounding (0.35 * 180 = 62.99…, yet 63 / 180 <= 0.35),
  // so settle k with the original expression itself.
  while (k >= 0 && k / maxLen > ratio) k--;
  while (k < maxLen && (k + 1) / maxLen <= ratio) k++;
  return k;
}

/**
 * Exact Levenshtein distance between a and b (over UTF-16 code units, as the
 * original full-matrix version) when it is ≤ k; Infinity when it exceeds k.
 * Bounded so long inputs cost O(n·k) time and O(m) memory instead of a full
 * (n+1)×(m+1) matrix (issue #315):
 *
 * - A common prefix and suffix never change the distance, so they are stripped.
 * - The distance is at least the length difference δ, so δ > k ⇒ Infinity.
 * - A cell (i, j) on any alignment path of total cost ≤ k satisfies
 *   |j−i| + |δ−(j−i)| ≤ k (its own cost is ≥ |j−i|, the rest ≥ |δ−(j−i)|),
 *   i.e. −⌊(k−δ)/2⌋ ≤ j−i ≤ ⌊(k+δ)/2⌋. Only that diagonal band is computed;
 *   cells outside it count as k+1. By induction every computed value is
 *   ≥ min(true value, k+1) and equals the true value along an optimal path of
 *   cost ≤ k, so the final cell is exact when the distance is ≤ k and > k
 *   otherwise.
 * - Every path crosses every row, so once every band cell of a row exceeds k
 *   the distance exceeds k (Ukkonen's cut-off).
 *
 * Exported for the differential tests only (issue #315).
 */
export function boundedLevenshtein(a: string, b: string, k: number): number {
  if (!(k >= 0)) return Number.POSITIVE_INFINITY;
  k = Math.floor(k);

  let start = 0;
  let endA = a.length;
  let endB = b.length;
  while (start < endA && start < endB && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }

  // s is the shorter remainder (length n), t the longer (length m); both begin at offset `start`.
  let s = a;
  let t = b;
  let n = endA - start;
  let m = endB - start;
  if (n > m) {
    s = b;
    t = a;
    const tmp = n;
    n = m;
    m = tmp;
  }
  const delta = m - n;
  if (delta > k) return Number.POSITIVE_INFINITY;
  if (n === 0) return m;

  const lowT = -Math.floor((k - delta) / 2);
  const highT = Math.floor((k + delta) / 2);
  const big = k + 1;
  const tCodes = new Uint16Array(m);
  for (let j = 0; j < m; j++) tCodes[j] = t.charCodeAt(start + j);
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j <= highT ? j : big;

  for (let i = 1; i <= n; i++) {
    const ci = s.charCodeAt(start + i - 1);
    let lo = i + lowT;
    const hi = Math.min(m, i + highT);
    let rowMin: number;
    if (lo <= 0) {
      cur[0] = i;
      rowMin = i;
      lo = 1;
    } else {
      cur[lo - 1] = big;
      rowMin = big;
    }
    for (let j = lo; j <= hi; j++) {
      let v = prev[j - 1] + (ci === tCodes[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      if (del < v) v = del;
      const ins = cur[j - 1] + 1;
      if (ins < v) v = ins;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < m) cur[hi + 1] = big;
    if (rowMin > k) return Number.POSITIVE_INFINITY;
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  const d = prev[m];
  return d <= k ? d : Number.POSITIVE_INFINITY;
}

/** `levenshtein(normA, normB) / maxLen <= ratio`, exactly as the original full-matrix test, without the full matrix. */
function normalizedLevenshteinWithin(normA: string, normB: string, ratio: number): boolean {
  const maxLen = Math.max(normA.length, normB.length);
  if (!(maxLen > 0)) return false;
  const k = maxEditsWithinRatio(maxLen, ratio);
  return k >= 0 && boundedLevenshtein(normA, normB, k) <= k;
}

/** Exact match, normalized Levenshtein ≤ 0.3, or ≥50% shared token stem. Tuned for short self-assigned claim-id slugs (alignment.ts pass 1). */
export function slugsMatch(slugA: string, slugB: string): boolean {
  const normA = normalizeSlug(slugA);
  const normB = normalizeSlug(slugB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  if (normalizedLevenshteinWithin(normA, normB, 0.3)) {
    return true;
  }

  const tokensA = slugTokens(slugA);
  const tokensB = slugTokens(slugB);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setB = new Set(tokensB);
  const overlap = tokensA.filter((t) => setB.has(t)).length;
  return overlap / Math.min(tokensA.length, tokensB.length) >= 0.5;
}

/**
 * Near-duplicate check for full prose sentences (not short id-slugs) — a
 * HIGHER bar than slugsMatch's defaults on both signals, since a mistaken
 * merge here silently drops a genuinely distinct point rather than just
 * failing to pre-merge before an LLM reconciliation pass gets a look. Used
 * by B6's Uncertainties/Follow-ups dedup, which has no model call at all —
 * this IS the whole merge decision, not a cheap pre-pass.
 */
export function textsAreNearDuplicates(
  a: string,
  b: string,
  opts: { levenshteinMaxRatio: number; tokenOverlapMin: number }
): boolean {
  const normA = normalizeSlug(a);
  const normB = normalizeSlug(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  if (normalizedLevenshteinWithin(normA, normB, opts.levenshteinMaxRatio)) {
    return true;
  }

  const tokensA = slugTokens(a);
  const tokensB = slugTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setB = new Set(tokensB);
  const overlap = tokensA.filter((t) => setB.has(t)).length;
  return overlap / Math.min(tokensA.length, tokensB.length) >= opts.tokenOverlapMin;
}

/**
 * Exact token-SET equality (order-independent) — unlike
 * textsAreNearDuplicates' overlap-coefficient (overlap / min-length), which
 * scores 1.0 for ANY subset relationship no matter how high tokenOverlapMin
 * is set (a smaller set fully contained in a larger one always has
 * overlap/min = 1). That makes textsAreNearDuplicates unsuitable whenever a
 * subset match must NOT be treated as identity — e.g. comparisonAlignment.ts's
 * subject axis, where "iPhone 15" and "iPhone 15 Pro" are different real
 * products and no tokenOverlapMin value can keep them apart via that
 * formula. This checks the token sets are exactly equal instead, so it still
 * catches reordering ("Tesla Model 3" vs "Model 3 Tesla") without merging
 * genuine supersets.
 */
export function hasIdenticalTokenSet(a: string, b: string): boolean {
  const tokensA = new Set(slugTokens(a));
  const tokensB = new Set(slugTokens(b));
  if (tokensA.size === 0 || tokensB.size === 0 || tokensA.size !== tokensB.size) return false;
  for (const t of tokensA) if (!tokensB.has(t)) return false;
  return true;
}

export class UnionFind {
  private parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i: number): number {
    if (this.parent[i] !== i) this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }
  union(i: number, j: number): void {
    const ri = this.find(i);
    const rj = this.find(j);
    if (ri !== rj) this.parent[ri] = rj;
  }
}

export interface TextItemSource {
  modelId: ModelId;
  text: string;
}

export interface MergedTextItem {
  /** The longest text among the merged group — usually the most complete phrasing, not just the first-seen one. */
  text: string;
  /** Distinct models that raised a near-duplicate of this item (never inflated by the same model repeating itself). */
  modelCount: number;
  modelIds: ModelId[];
}

/**
 * Merges near-duplicate text items (via textsAreNearDuplicates, union-find —
 * the same cheap deterministic clustering shape as alignment.ts pass 1, no
 * model call), ranks by how many distinct models raised each merged item
 * (descending, ties broken by first-seen order), and caps the result.
 */
export function mergeAndRankTextItems(
  items: TextItemSource[],
  opts: { levenshteinMaxRatio: number; tokenOverlapMin: number; cap: number }
): MergedTextItem[] {
  if (items.length === 0) return [];

  const uf = new UnionFind(items.length);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (textsAreNearDuplicates(items[i].text, items[j].text, opts)) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const merged: MergedTextItem[] = Array.from(groups.values()).map((idxs) => {
    const modelIds = Array.from(new Set(idxs.map((i) => items[i].modelId)));
    const text = idxs.map((i) => items[i].text).reduce((longest, t) => (t.length > longest.length ? t : longest));
    return { text, modelCount: modelIds.length, modelIds };
  });

  // Stable-ish rank: descending modelCount, ties keep first-group-seen order (Array.from(Map) preserves insertion order).
  return merged.sort((a, b) => b.modelCount - a.modelCount).slice(0, opts.cap);
}

/**
 * Convenience wrapper for plain string lists with no natural per-item model
 * attribution — e.g. AdaptiveSynthesisReport.whereModelsAgree, which is one
 * synthesis model's own list of consensus sentences, not one item per
 * source model. Gives each item a synthetic per-index "source" so the SAME
 * clustering pass still merges near-duplicate phrasings (Part B6's dedup,
 * reused for the "Where Models Agree" list) — the merge-group size then
 * ranks how many near-duplicate variants were folded together, which is
 * still a reasonable "how consistently was this stated" signal even without
 * real per-model attribution.
 */
export function dedupeTextList(
  items: string[],
  opts: { levenshteinMaxRatio: number; tokenOverlapMin: number; cap: number }
): string[] {
  const sources: TextItemSource[] = items.map((text, idx) => ({ modelId: `item-${idx}` as ModelId, text }));
  return mergeAndRankTextItems(sources, opts).map((m) => m.text);
}
