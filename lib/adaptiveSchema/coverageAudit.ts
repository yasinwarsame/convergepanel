/**
 * Bias & Blind Spots — Tier 2: panel coverage audit (Synthesis Report
 * Polish, Bias-Blind-Spots-Tiers fix).
 *
 * A dedicated model call, separate from both the narrative synthesis call
 * (synthesisReport.ts) and Tier 1's per-model bias detection
 * (biasDetection.ts): this one asks a single question about the PANEL AS A
 * WHOLE — which dimensions a domain expert would expect covered that no
 * model addressed at all. Distinct from Tier 1 (which flags biased/skewed
 * coverage that IS present) — this flags coverage that's simply absent.
 *
 * Cautious by design, same rationale as biasDetection.ts: instructed not to
 * invent gaps, and degrades to an empty array (never a crash) on any
 * call/parse failure.
 */

import "server-only";
import { z } from "zod";
import { AdaptiveCoverageGap, QueryType } from "./types";
import { callGemini } from "@/lib/connectors/gemini";
import { GEMINI_API_KEY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { stripJsonFences, withTimeout } from "./util";
import { MAX_COVERAGE_GAPS } from "./config";

const COVERAGE_CALL_TIMEOUT_MS = 10000;
const COVERAGE_MAX_OUTPUT_TOKENS = 900;

const CoverageGapSchema = z.object({
  dimension: z.string(),
  whyItMatters: z.string(),
  followUpQuestion: z.string(),
});

const CoverageResponseSchema = z.object({
  gaps: z.array(CoverageGapSchema),
});

/**
 * Audits what the panel, taken together, never addressed for this question.
 * Never throws; degrades to [] on timeout/failure/malformed response — an
 * empty list renders as "nothing to flag" in the UI, never a crash or an
 * invented gap.
 *
 * Takes plain claim/finding text rather than `AlignedClaim[]` — the only
 * thing this function ever needed from a row was its text, so this stays
 * schema-agnostic and reusable by any pipeline's own unit of content
 * (`AlignedClaim.claimText` for the claim-matrix pipeline,
 * `AggregatedResearchFinding.summary` for deep_research's parallel path —
 * see deepResearchAlignment.ts).
 */
export async function auditPanelCoverage(
  question: string,
  schemaId: QueryType,
  claimTexts: string[]
): Promise<AdaptiveCoverageGap[]> {
  if (claimTexts.length === 0) return [];

  const claimsList = claimTexts.map((t) => `- ${t}`).join("\n");

  const systemPrompt = `You are auditing a multi-model AI research panel's coverage of a research question (schema type: "${schemaId}").

List up to ${MAX_COVERAGE_GAPS} dimensions a domain expert would expect an answer to this question to cover that NO model addressed. For each: what's missing, why it matters, and one concrete follow-up question the user could run to fill the gap. Do not invent gaps — only name genuinely expected dimensions that are absent from the claims below. If the panel's coverage looks complete, return an empty array.

Return ONLY JSON in this exact shape:
{
  "gaps": [
    { "dimension": "short label for the missing dimension", "whyItMatters": "1-2 sentences on why a domain expert would expect this covered", "followUpQuestion": "one concrete follow-up question the user could run" }
  ]
}
No markdown fences, no commentary outside the JSON.`;

  const userMessage = `Question: "${question}"

Claims the panel already covered (aligned across models):
${claimsList}`;

  try {
    const result = await withTimeout(
      callGemini(userMessage, null, GEMINI_API_KEY, {
        systemPromptOverride: systemPrompt,
        maxOutputTokens: COVERAGE_MAX_OUTPUT_TOKENS,
      }),
      COVERAGE_CALL_TIMEOUT_MS,
      "coverage_audit_timeout"
    );

    if (result.status !== "ok" || !result.rawText) {
      logger.info("[adaptiveSchema] Coverage audit call failed, returning no gaps", { status: result.status });
      return [];
    }

    const parsed = CoverageResponseSchema.safeParse(JSON.parse(stripJsonFences(result.rawText)));
    if (!parsed.success) {
      logger.info("[adaptiveSchema] Coverage audit response failed validation, returning no gaps");
      return [];
    }

    return parsed.data.gaps.slice(0, MAX_COVERAGE_GAPS);
  } catch (err: any) {
    logger.warn("[adaptiveSchema] Coverage audit call threw/timed out, returning no gaps", {
      error: err?.message,
    });
    return [];
  }
}
