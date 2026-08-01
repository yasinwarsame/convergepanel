/**
 * Bias & Blind Spots Detection (Synthesis Report Polish, A3)
 *
 * A dedicated model call, separate from the narrative synthesis call in
 * synthesisReport.ts — detecting shared framing/evidence-base bias requires
 * seeing each model's FULL raw response (not just its aligned claims), so it
 * can't reuse the aligned-claims summary the narrative call works from.
 *
 * Cautious by design: only attributes a bias to a model when the model call
 * supplies a concrete quoted excerpt from that model's own response, and
 * every model ID (implicated + evidence) is filtered against the run's
 * actual roster before returning — a finding that ends up with no valid
 * evidence after filtering is dropped rather than shown half-populated.
 *
 * Returns an `emptyReason` alongside `findings` (Bias & Blind Spots Tiers
 * fix, Part T1) so an empty result is never ambiguous: "below_threshold"
 * means the call ran fine and genuinely found nothing confidently
 * attributable, vs "insufficient_models"/"call_failed"/"invalid_response"
 * meaning the call never really got a chance to find anything. Surfaced in
 * the dev debug panel (ResultsDisplay.tsx's AdaptiveDebugPanel).
 */

import "server-only";
import { z } from "zod";
import { ModelId, ModelResult } from "@/lib/types";
import { AdaptiveBiasFinding, BiasEmptyReason, QueryType } from "./types";
import { callGemini } from "@/lib/connectors/gemini";
import { GEMINI_API_KEY } from "@/lib/env";
import { logger } from "@/lib/logger";
import { stripJsonFences, withTimeout } from "./util";
import { MAX_BIAS_FINDINGS, BIAS_EVIDENCE_EXCERPT_MAX_CHARS } from "./config";

const BIAS_CALL_TIMEOUT_MS = 12000;
const BIAS_MAX_OUTPUT_TOKENS = 2000;
const RAW_TEXT_CHARS_PER_MODEL = 4000;

const BiasEvidenceSchema = z.object({
  modelId: z.string(),
  excerpt: z.string(),
  rationale: z.string(),
});

const BiasFindingSchema = z.object({
  biasType: z.string(),
  description: z.string(),
  modelsImplicated: z.array(z.string()).min(1),
  evidence: z.array(BiasEvidenceSchema).min(1),
  likelyCauses: z.array(z.string()).default([]),
  impact: z.string(),
  mitigationSteps: z.array(z.string()).default([]),
});

const BiasResponseSchema = z.object({
  biasAndBlindSpots: z.array(BiasFindingSchema),
});

export interface AdaptiveBiasDetectionResult {
  findings: AdaptiveBiasFinding[];
  /** Null when findings is non-empty. */
  emptyReason: BiasEmptyReason | null;
}

/**
 * Identifies shared blind spots (evidence-base skew, framing bias, missing
 * perspectives) across a panel run. Never throws; degrades to an empty array
 * on timeout/failure — an empty list renders as "no bias signals confidently
 * attributable" in the UI, never a crash or a fabricated finding.
 */
export async function detectAdaptiveBiases(
  question: string,
  schemaId: QueryType,
  results: ModelResult[],
  modelRoster: ModelId[]
): Promise<AdaptiveBiasDetectionResult> {
  const usable = results.filter((r) => (r.status === "ok" || r.status === "substituted") && r.rawText);
  if (usable.length < 2) return { findings: [], emptyReason: "insufficient_models" };

  const rosterList = modelRoster.join(", ");
  const responsesBlock = usable
    .map((r) => `### ${r.modelId}\n${(r.rawText || "").slice(0, RAW_TEXT_CHARS_PER_MODEL)}`)
    .join("\n\n");

  const systemPrompt = `You are auditing a multi-model AI research panel for shared biases and blind spots. You will see the FULL raw responses from each model for one query (schema type: "${schemaId}").

Only use these exact model IDs, verbatim, in "modelsImplicated" and "evidence[].modelId" — never invent or alter one: ${rosterList}.

Identify shared blind spots: evidence-base skew, framing bias, missing perspectives, or other patterns that recur across models. Only attribute a bias to a model if there is a concrete indicator in that model's own response — quote it as evidence. Use cautious language ("likely", "suggests", "may indicate"), never definitive claims. At most ${MAX_BIAS_FINDINGS} findings; if none are confidently attributable, return an empty array.

Return ONLY JSON in this exact shape:
{
  "biasAndBlindSpots": [
    {
      "biasType": "short label, e.g. 'Western-centric framing'",
      "description": "plain-language explanation of the bias and how it may affect conclusions",
      "modelsImplicated": ["<modelId from roster>"],
      "evidence": [{ "modelId": "<modelId from roster>", "excerpt": "direct quote, max ${BIAS_EVIDENCE_EXCERPT_MAX_CHARS} chars, no newlines", "rationale": "why this excerpt suggests the bias" }],
      "likelyCauses": ["..."],
      "impact": "...",
      "mitigationSteps": ["..."]
    }
  ]
}
No markdown fences, no commentary outside the JSON.`;

  try {
    const result = await withTimeout(
      callGemini(`Question: "${question}"\n\n${responsesBlock}`, null, GEMINI_API_KEY, {
        systemPromptOverride: systemPrompt,
        maxOutputTokens: BIAS_MAX_OUTPUT_TOKENS,
      }),
      BIAS_CALL_TIMEOUT_MS,
      "bias_detection_timeout"
    );

    if (result.status !== "ok" || !result.rawText) {
      logger.info("[adaptiveSchema] Bias detection call failed, returning no findings", { status: result.status });
      return { findings: [], emptyReason: "call_failed" };
    }

    const parsed = BiasResponseSchema.safeParse(JSON.parse(stripJsonFences(result.rawText)));
    if (!parsed.success) {
      logger.info("[adaptiveSchema] Bias detection response failed validation, returning no findings");
      return { findings: [], emptyReason: "invalid_response" };
    }

    const rosterSet = new Set<string>(modelRoster);

    const findings = parsed.data.biasAndBlindSpots
      .slice(0, MAX_BIAS_FINDINGS)
      .map((b) => ({
        biasType: b.biasType,
        description: b.description,
        modelsImplicated: b.modelsImplicated.filter((m) => rosterSet.has(m)) as ModelId[],
        evidence: b.evidence
          .filter((e) => rosterSet.has(e.modelId))
          .map((e) => ({
            modelId: e.modelId as ModelId,
            excerpt: e.excerpt.slice(0, BIAS_EVIDENCE_EXCERPT_MAX_CHARS),
            rationale: e.rationale,
          })),
        likelyCauses: b.likelyCauses,
        impact: b.impact,
        mitigationSteps: b.mitigationSteps,
      }))
      .filter((b) => b.modelsImplicated.length > 0 && b.evidence.length > 0);

    return { findings, emptyReason: findings.length > 0 ? null : "below_threshold" };
  } catch (err: any) {
    logger.warn("[adaptiveSchema] Bias detection call threw/timed out, returning no findings", {
      error: err?.message,
    });
    return { findings: [], emptyReason: "call_failed" };
  }
}
