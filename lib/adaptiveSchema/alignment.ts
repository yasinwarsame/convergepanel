/**
 * Claim Alignment
 *
 * After all models respond, aligns their claim[] fields into a single
 * claims × models matrix (AlignedClaim[]) — the data behind the
 * consensus_map / evidence_tiers renderers, and the input to the
 * Verification Engine (agreement/certainty scoring, gate, synthesis).
 *
 * Three passes:
 * 1. Exact/fuzzy slug match (normalized Levenshtein ≤ 0.3, or shared token
 *    stem) — cheap, deterministic, no model call. Only dedupes claims whose
 *    self-assigned slugs already look alike; it is NOT relied on to catch
 *    claims about the same proposition phrased differently or argued from
 *    opposite sides — that's pass 2's job.
 * 2. One batched LLM call clusters ALL pass-1 groups (not just leftover
 *    singletons) by PROPOSITION, explicitly merging groups that take
 *    opposing positions on the same underlying question, and assigns each
 *    group a stance relative to a neutral canonical proposition. Best-effort:
 *    on any failure, groups are kept as-is (degraded but never crashes).
 * 3. Stance-extraction backfill: for every (claim, model) pair still null
 *    after pass 2, one batched call per silent model asks whether ANY part
 *    of its FULL response — its claims list AND its other fields (summary,
 *    answer, thesis, etc.) — speaks to that canonical proposition. A stance
 *    is often only implied in prose (a `summary` asserting something the
 *    model never separately listed as a Claim); checking claims alone
 *    under-reports it as silence. Only a genuine "no position anywhere in
 *    the response" answer (or a failed/degraded call) leaves the cell null
 *    — the goal is that null means true silence, not a matching miss.
 */

import "server-only";
import { z } from "zod";
import { ModelId } from "@/lib/types";
import { callGemini } from "@/lib/connectors/gemini";
import { GEMINI_API_KEY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { AlignedClaim, AlignedClaimCell, Claim, ClaimCellStance, ClaimStance } from "./types";
import { stripJsonFences, withTimeout } from "./util";

const CLUSTER_CALL_TIMEOUT_MS = 8000;
const CLUSTER_MAX_OUTPUT_TOKENS = 2000;
const BACKFILL_CALL_TIMEOUT_MS = 6000;
const BACKFILL_MAX_OUTPUT_TOKENS = 1200;

export interface ModelClaims {
  modelId: ModelId;
  claims: Claim[];
  /**
   * The model's full validated response data (every schema field — summary,
   * scalar answers, string[] lists — not just its claim[] fields). Passed
   * through to the stance-extraction backfill (pass 3) so a stance implied
   * only in prose (e.g. a `summary` field asserting something the model
   * never separately listed as a Claim) isn't missed. Optional so existing
   * callers/tests that only care about claim[]-based alignment (pass 1/2)
   * aren't forced to supply it.
   */
  fullResponseData?: Record<string, unknown> | null;
}

/**
 * Renders the non-claim[] fields of a model's full response as short
 * "key: value" lines for the backfill prompt — the surface most likely to
 * carry an implied-but-unlisted stance (summary/answer/thesis prose,
 * string[] lists like openQuestions/riskFactors). claim[]/metric[]/step[]/
 * scenario[] array-of-object fields are skipped: claims are already passed
 * separately in full detail, and the others aren't prose a stance could be
 * "implied" in the way this pass is meant to catch.
 */
function formatFullResponseForPrompt(data: Record<string, unknown> | null | undefined): string {
  if (!data) return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.trim()) {
      lines.push(`${key}: "${value.trim()}"`);
    } else if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      if (value.length > 0) lines.push(`${key}: ${(value as string[]).join("; ")}`);
    }
  }
  return lines.join("\n");
}

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

/** Exact match, normalized Levenshtein ≤ 0.3, or ≥50% shared token stem. */
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

class UnionFind {
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

interface ClaimNode {
  modelId: ModelId;
  claim: Claim;
}

interface StanceAnswer {
  stance: ClaimCellStance;
  excerpt: string;
}

/** Cheap heuristic used only when a model call is unavailable/fails (degraded path). */
function fallbackRelativeStance(claim: Claim): StanceAnswer {
  const stance: ClaimCellStance =
    claim.stance === "asserts" ? "agrees" : claim.stance === "disputes" ? "disputes" : "unclear";
  return { stance, excerpt: claim.claim };
}

function rawStanceFromRelative(stance: ClaimCellStance): ClaimStance {
  switch (stance) {
    case "agrees":
      return "asserts";
    case "partial":
      return "asserts";
    case "disputes":
      return "disputes";
    default:
      return "uncertain";
  }
}

// ─── Pass 2: semantic clustering + relative-stance assignment ─────────────

const SemanticClusterSchema = z.object({
  clusters: z.array(
    z.object({
      canonicalText: z.string(),
      members: z.array(
        z.object({
          key: z.string(),
          stance: z.enum(["agrees", "disputes", "partial", "unclear"]),
          excerpt: z.string(),
        })
      ),
    })
  ),
});

interface SemanticCluster {
  canonicalText: string;
  idxs: number[];
  stanceByIdx: Map<number, StanceAnswer>;
}

/**
 * Best-effort semantic reconciliation of ALL pass-1 groups (not just
 * singletons) into final clusters, with an explicit instruction to cluster
 * by proposition rather than by stance. Never throws; on any failure, keeps
 * the input groups unmerged rather than blocking the pipeline.
 */
async function semanticClusterGroups(
  groups: number[][],
  nodes: ClaimNode[]
): Promise<SemanticCluster[] | null> {
  if (groups.length <= 1) {
    return null; // nothing to reconcile — 0 or 1 group already covers everything
  }

  const keyed = groups.map((idxs, i) => ({
    key: `c${i}`,
    idxs,
    label: idxs
      .map((idx) => `[${nodes[idx].modelId}] "${nodes[idx].claim.claim}" (stance: ${nodes[idx].claim.stance})`)
      .join(" | "),
  }));

  const userMessage = keyed.map((k) => `${k.key}: ${k.label}`).join("\n");

  const systemPrompt = `You are reconciling claims raised independently by different AI models answering the same research question, so they can be compared side by side in one table.

Each line below is one GROUP of claims (already merged if the models used near-identical wording).

Your job:
1. Cluster GROUPS that are about the SAME underlying proposition into one cluster — even when they take OPPOSING positions on it. Cluster by PROPOSITION, not by stance. Example: "cap-and-trade achieves similar emissions reductions" and "carbon taxes often outperform emissions trading systems" are the SAME proposition (relative effectiveness of carbon-pricing mechanisms) argued from opposite sides, and MUST land in one cluster.
2. Do NOT merge groups that are meaningfully different assertions, even if they're on a related general topic.
3. For each cluster, write one neutral "canonicalText" (max 20 words) naming the shared proposition WITHOUT taking a side on it.
4. For every group key placed in a cluster, state that group's stance toward the canonicalText: "agrees" (supports it as stated), "disputes" (opposes or contradicts it), "partial" (partially agrees or adds a material condition), or "unclear". Include a short "excerpt" (<=15 words) paraphrasing that group's own position in its own terms.

Return ONLY JSON in this exact shape:
{ "clusters": [ { "canonicalText": "...", "members": [ { "key": "c0", "stance": "agrees", "excerpt": "..." } ] } ] }
Every input key must appear exactly once across all clusters. No prose, no markdown fences.`;

  try {
    const result = await withTimeout(
      callGemini(userMessage, null, GEMINI_API_KEY, {
        systemPromptOverride: systemPrompt,
        maxOutputTokens: CLUSTER_MAX_OUTPUT_TOKENS,
      }),
      CLUSTER_CALL_TIMEOUT_MS,
      "cluster_timeout"
    );

    if (result.status !== "ok" || !result.rawText) {
      logger.info("[adaptiveSchema] Claim cluster call failed, keeping pass-1 groups unmerged", {
        status: result.status,
      });
      return null;
    }

    const parsedJson = JSON.parse(stripJsonFences(result.rawText));
    const parsed = SemanticClusterSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.info("[adaptiveSchema] Claim cluster response failed validation, keeping pass-1 groups unmerged");
      return null;
    }

    const keyToIdxs = new Map(keyed.map((k) => [k.key, k.idxs]));
    const seenKeys = new Set<string>();
    const output: SemanticCluster[] = [];

    for (const cluster of parsed.data.clusters) {
      const idxs: number[] = [];
      const stanceByIdx = new Map<number, StanceAnswer>();
      for (const member of cluster.members) {
        if (seenKeys.has(member.key)) {
          logger.warn("[adaptiveSchema] Claim cluster response repeated a key, ignoring duplicate", { key: member.key });
          continue;
        }
        const memberIdxs = keyToIdxs.get(member.key);
        if (!memberIdxs) {
          logger.warn("[adaptiveSchema] Claim cluster response referenced an unknown key, ignoring", { key: member.key });
          continue;
        }
        seenKeys.add(member.key);
        idxs.push(...memberIdxs);
        for (const idx of memberIdxs) {
          stanceByIdx.set(idx, { stance: member.stance, excerpt: member.excerpt });
        }
      }
      if (idxs.length > 0) {
        output.push({ canonicalText: cluster.canonicalText, idxs, stanceByIdx });
      }
    }

    // Defensive: any key the model dropped stays as its own cluster, with a
    // heuristic fallback stance, so no claim is silently lost.
    for (const k of keyed) {
      if (!seenKeys.has(k.key)) {
        const stanceByIdx = new Map<number, StanceAnswer>();
        for (const idx of k.idxs) stanceByIdx.set(idx, fallbackRelativeStance(nodes[idx].claim));
        output.push({ canonicalText: nodes[k.idxs[0]].claim.claim, idxs: k.idxs, stanceByIdx });
      }
    }

    return output;
  } catch (err: any) {
    logger.warn("[adaptiveSchema] Claim cluster call threw/timed out, keeping pass-1 groups unmerged", {
      error: err?.message,
    });
    return null;
  }
}

function buildAlignedClaim(
  canonicalText: string,
  idxs: number[],
  nodes: ClaimNode[],
  modelOrder: ModelId[],
  stanceByIdx: Map<number, StanceAnswer>
): AlignedClaim {
  const cellByModel = new Map<ModelId, AlignedClaimCell>();

  for (const idx of idxs) {
    const { modelId, claim } = nodes[idx];
    if (cellByModel.has(modelId)) continue; // first claim wins if a model raised >1 claim in this cluster
    const resolved = stanceByIdx.get(idx) ?? fallbackRelativeStance(claim);
    cellByModel.set(modelId, {
      modelId,
      stance: resolved.stance,
      rawStance: claim.stance,
      confidence: claim.confidence,
      excerpt: resolved.excerpt || claim.claim,
      evidenceType: claim.evidenceType,
      ...(claim.camps ? { camps: claim.camps } : {}),
    });
  }

  const representativeId = normalizeSlug(canonicalText) || `cluster-${idxs[0]}`;

  return {
    id: representativeId,
    claimText: canonicalText,
    cells: modelOrder.map((modelId) => cellByModel.get(modelId) ?? null),
    // Scored downstream by the schema's AgreementComparator + scoring.ts —
    // alignment only produces the matrix, never the score.
    agreementScore: 0,
    certaintyScore: 0,
    status: "single_source",
  };
}

// ─── Pass 3: stance-extraction backfill for silent cells ──────────────────

const BackfillResponseSchema = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      hasPosition: z.boolean(),
      stance: z.enum(["agrees", "disputes", "partial", "unclear"]).optional(),
      excerpt: z.string().optional(),
    })
  ),
});

/**
 * Ask one model, given its own full structured response (not just its
 * Claim[] list — a stance can be implied only in prose, e.g. a `summary`
 * field, without the model ever separately listing it as a Claim), whether
 * it takes a position on each canonical proposition it didn't already
 * cluster into. Never throws; returns null (leave cells null — true silence
 * assumed) on any failure or degraded response.
 */
async function backfillOneModel(
  modelClaims: Claim[],
  targets: { key: string; text: string }[],
  fullResponseData?: Record<string, unknown> | null
): Promise<Map<string, StanceAnswer & { hasPosition: true }> | null> {
  if (targets.length === 0 || modelClaims.length === 0) return new Map();

  const claimsBlock = modelClaims
    .map((c) => `- "${c.claim}" (stance: ${c.stance}, confidence: ${c.confidence})`)
    .join("\n");
  const fullResponseBlock = formatFullResponseForPrompt(fullResponseData);
  const questionsBlock = targets.map((t) => `${t.key}: ${t.text}`).join("\n");
  const userMessage = `This model's structured claims list:\n${claimsBlock}${
    fullResponseBlock ? `\n\nThis model's FULL response (other fields — summary, answer, lists — may imply a stance not captured above):\n${fullResponseBlock}` : ""
  }\n\nCanonical propositions to check:\n${questionsBlock}`;

  const systemPrompt = `You are given one AI model's full response from a multi-model research panel — its structured claims list AND its other response fields (summary, answer, thesis, lists, etc.) — plus a list of canonical propositions raised by OTHER models in the same panel that this model's claims were not automatically matched to.

For each canonical proposition, decide: does ANY part of this model's response — its claims list, OR its summary/answer/other fields — take a position on it, directly or as a clear implication, even if worded very differently or never listed as a separate claim?
- If yes: "hasPosition": true, plus "stance" toward the proposition ("agrees" | "disputes" | "partial" | "unclear") and a short "excerpt" (<=15 words) quoting or closely paraphrasing whichever part of the response implies it (claims list OR summary/other fields).
- Only answer "hasPosition": false when the response genuinely never touches the topic anywhere — in the claims list OR the other fields. Do not default to false just because the claims list alone is silent; check the full response first.

Do not invent a position the response doesn't support — when the full response truly never touches the topic, say "hasPosition": false.

Return ONLY JSON: { "answers": [ { "key": "q0", "hasPosition": true, "stance": "agrees", "excerpt": "..." } ] }
Every question key must appear exactly once. No prose, no markdown fences.`;

  try {
    const result = await withTimeout(
      callGemini(userMessage, null, GEMINI_API_KEY, {
        systemPromptOverride: systemPrompt,
        maxOutputTokens: BACKFILL_MAX_OUTPUT_TOKENS,
      }),
      BACKFILL_CALL_TIMEOUT_MS,
      "backfill_timeout"
    );

    if (result.status !== "ok" || !result.rawText) {
      logger.info("[adaptiveSchema] Stance backfill call failed, leaving cells null (silence assumed)", {
        status: result.status,
      });
      return null;
    }

    const parsedJson = JSON.parse(stripJsonFences(result.rawText));
    const parsed = BackfillResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.info("[adaptiveSchema] Stance backfill response failed validation, leaving cells null");
      return null;
    }

    const out = new Map<string, StanceAnswer & { hasPosition: true }>();
    for (const answer of parsed.data.answers) {
      if (answer.hasPosition && answer.stance) {
        out.set(answer.key, { hasPosition: true, stance: answer.stance, excerpt: answer.excerpt || "" });
      }
    }
    return out;
  } catch (err: any) {
    logger.warn("[adaptiveSchema] Stance backfill call threw/timed out, leaving cells null", {
      error: err?.message,
    });
    return null;
  }
}

/**
 * For every (claim, model) pair still null after clustering, ask the silent
 * model directly whether it takes a position. Runs one call per model in
 * parallel (never per-claim — that would multiply latency/cost).
 */
async function backfillSilentCells(
  clusters: AlignedClaim[],
  perModelClaims: ModelClaims[],
  modelOrder: ModelId[]
): Promise<AlignedClaim[]> {
  const claimsByModel = new Map(perModelClaims.map((m) => [m.modelId, m.claims]));
  const fullResponseByModel = new Map(perModelClaims.map((m) => [m.modelId, m.fullResponseData]));

  const perModelResults = await Promise.all(
    modelOrder.map(async (modelId, modelIdx) => {
      const modelClaims = claimsByModel.get(modelId) || [];
      if (modelClaims.length === 0) return null; // contributed nothing this run — nothing to check

      const nullClusterIdxs = clusters
        .map((c, ci) => ci)
        .filter((ci) => clusters[ci].cells[modelIdx] === null);

      if (nullClusterIdxs.length === 0) return null;

      const targets = nullClusterIdxs.map((ci, i) => ({ key: `q${i}`, text: clusters[ci].claimText }));
      const answers = await backfillOneModel(modelClaims, targets, fullResponseByModel.get(modelId));
      if (!answers) return null;

      return { modelId, modelIdx, nullClusterIdxs, answers };
    })
  );

  const next = clusters.map((c) => ({ ...c, cells: [...c.cells] }));

  for (const res of perModelResults) {
    if (!res) continue;
    const { modelId, modelIdx, nullClusterIdxs, answers } = res;
    nullClusterIdxs.forEach((ci, i) => {
      const answer = answers.get(`q${i}`);
      if (answer) {
        next[ci].cells[modelIdx] = {
          modelId,
          stance: answer.stance,
          rawStance: rawStanceFromRelative(answer.stance),
          confidence: "majority_view", // inferred position, not the model's stated one
          excerpt: answer.excerpt,
          backfilled: true,
        };
      }
    });
  }

  return next;
}

/**
 * Align claims across models into a claims × models matrix.
 * `modelOrder` (derived from perModelClaims) determines the cell order in
 * every AlignedClaim so renderers can build a stable column layout.
 */
export async function alignClaims(perModelClaims: ModelClaims[]): Promise<AlignedClaim[]> {
  const modelOrder = perModelClaims.map((m) => m.modelId);

  const nodes: ClaimNode[] = [];
  for (const { modelId, claims } of perModelClaims) {
    for (const claim of claims) {
      nodes.push({ modelId, claim });
    }
  }

  if (nodes.length === 0) return [];

  // Pass 1: cheap deterministic pre-merge of near-identically-slugged claims.
  const uf = new UnionFind(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (slugsMatch(nodes[i].claim.id, nodes[j].claim.id)) {
        uf.union(i, j);
      }
    }
  }

  const groupMap = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const root = uf.find(i);
    if (!groupMap.has(root)) groupMap.set(root, []);
    groupMap.get(root)!.push(i);
  }
  const groups = Array.from(groupMap.values());

  // Pass 2: semantic reconciliation across ALL groups (lets a claim rejoin a
  // cluster pass 1 missed, and merges opposing-stance claims about the same
  // proposition into one row). Only worth the model call when at least one
  // group is still a model-singleton after pass 1 — if every group already
  // has ≥2 distinct models, slug-matching alone produced unambiguous
  // clusters and there's nothing left to reconcile. Degrades to the pass-1
  // groups on failure.
  const hasUnresolvedSingleton = groups.some((idxs) => new Set(idxs.map((i) => nodes[i].modelId)).size < 2);
  const semanticClusters =
    groups.length > 1 && hasUnresolvedSingleton ? await semanticClusterGroups(groups, nodes) : null;

  const baseAlignedClaims = (semanticClusters ?? groups.map((idxs) => ({
    canonicalText: nodes[idxs[0]].claim.claim,
    idxs,
    stanceByIdx: new Map(idxs.map((idx) => [idx, fallbackRelativeStance(nodes[idx].claim)])),
  }))).map((c) => buildAlignedClaim(c.canonicalText, c.idxs, nodes, modelOrder, c.stanceByIdx));

  // Pass 3: stance-extraction backfill so null means true silence.
  return backfillSilentCells(baseAlignedClaims, perModelClaims, modelOrder);
}
