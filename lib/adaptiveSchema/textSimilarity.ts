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

/** Exact match, normalized Levenshtein ≤ 0.3, or ≥50% shared token stem. Tuned for short self-assigned claim-id slugs (alignment.ts pass 1). */
export function slugsMatch(slugA: string, slugB: string): boolean {
  const normA = normalizeSlug(slugA);
  const normB = normalizeSlug(slugB);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen > 0 && levenshtein(normA, normB) / maxLen <= 0.3) {
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

  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen > 0 && levenshtein(normA, normB) / maxLen <= opts.levenshteinMaxRatio) {
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
