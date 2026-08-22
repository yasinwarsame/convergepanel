/**
 * Phase 8C-E.3.1B — mechanical extraction of the pure/Workspace-agnostic
 * Video analysis seam from `app/api/verify-video/route.ts` (frozen by the
 * 8C-E.3.0 audit, protected by the 42-test
 * `verifyVideoPipelineCharacterization.spec.ts` characterization suite).
 *
 * This is a MOVE, not a redesign. Every statement below is byte-identical
 * to the removed inline block in the route (same variable names, same
 * branching, same provider dispatch, same JSON parse/repair nesting, same
 * aggregation math), with exactly two additive, non-semantic adaptations
 * at the boundary:
 *
 *   1. The moved statements are wrapped in `executeVideoVerification()`,
 *      taking `frames`/`metadata`/`metadataAnalysis` as inputs (these were
 *      already fully computed by the route BEFORE the seam starts) and
 *      returning a plain result object.
 *   2. `totalTokens` — previously computed via the identical expression
 *      `modelResults.reduce((sum, r) => sum + (r.tokens || 0), 0)` at TWO
 *      separate call sites in the route (once for `resultDoc.totalTokens`,
 *      once again for the later `incrementUserTokenUsage()` call) — is now
 *      computed ONCE here and returned as a single field the route reads
 *      at both sites. This is safe and observably identical: `modelResults`
 *      is never mutated between those two original call sites, so both
 *      reads always produced (and still produce) the same value.
 *
 * This module owns ONLY vision-model dispatch, JSON parse/repair, and
 * result aggregation. It explicitly does NOT own — and must never be
 * extended to own — auth, adminDb, rate limiting, entitlement/quota,
 * request parsing/validation, dedup, verification-ID generation, Firestore
 * persistence, governance, either usage counter, token accounting, or HTTP
 * response construction. All of that remains in the Personal route
 * (unchanged) and will remain route-owned in the eventual Team route too.
 */

import { cleanJsonResponse, repairTruncatedJson } from "@/lib/verification/cleanJsonResponse";
import { logger } from "@/lib/logger";

import type { ExtractedFrame, MetadataAnalysis, VideoMetadata } from "@/lib/video/videoPure";
import { buildVideoVerificationPrompt } from "@/lib/video/videoVerificationPrompt";
import { callOpenAIVision, callClaudeVision, callGeminiVision } from "@/lib/video/visionCalls";

const KNOWN_MODEL_VIDEO_VERDICTS = new Set([
  "authentic_captured",
  "authentic_produced",
  "likely_manipulated",
  "inconclusive",
  "insufficient",
  "authentic",
]);

const KNOWN_VIDEO_CONTENT_TYPES = new Set([
  "camera_footage",
  "animation",
  "screen_recording",
  "ai_generated_creative",
  "ai_generated_deceptive",
  "mixed",
  "unknown",
]);

function normalizeModelVideoVerdict(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (KNOWN_MODEL_VIDEO_VERDICTS.has(s)) return s;
  return "inconclusive";
}

function normalizeVideoContentType(v: unknown): string {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (KNOWN_VIDEO_CONTENT_TYPES.has(s)) return s;
  return "unknown";
}

const MODEL_REFUSAL_PATTERNS = [
  "I'm sorry",
  "I cannot assist",
  "I can't assist",
  "I'm unable to",
  "I cannot help",
  "I can't help",
  "not able to analyze",
  "cannot process this",
  "against my guidelines",
  "content policy",
] as const;

function isVisionModelRefusalResponse(text: string): boolean {
  const t = text.trim().toLowerCase();
  return MODEL_REFUSAL_PATTERNS.some((p) => t.includes(p.toLowerCase()));
}

function refusedModelRow(
  model: { id: string; name: string },
  responseText: string,
  tokens: number | undefined
): VisionModelRow {
  logger.debug(`[verify-video] ${model.id} refused to analyze`, { modelId: model.id, textLength: responseText.length });
  return {
    modelId: model.id,
    modelName: model.name,
    status: "refused",
    verdict: "inconclusive",
    confidence: "low",
    contentType: "unknown",
    summary: "Model declined to analyze this content due to content policy restrictions.",
    visualIndicators: [],
    metadataIndicators: [],
    manipulationSignals: [],
    authenticitySignals: [],
    productionSignals: [],
    deceptionIndicators: [],
    compressionNotes: [],
    limitations: ["Model content policy prevented analysis of these frames."],
    reasoning: "",
    tokens,
  };
}

export type VisionModelRow = {
  modelId: string;
  modelName: string;
  status: "ok" | "refused" | "parse_error" | "error";
  verdict: string;
  confidence: string;
  contentType: string;
  summary: string;
  visualIndicators: string[];
  metadataIndicators: string[];
  manipulationSignals: string[];
  authenticitySignals: string[];
  productionSignals: string[];
  deceptionIndicators: string[];
  compressionNotes: string[];
  limitations: string[];
  reasoning: string;
  tokens?: number;
};

// Static provider config table — pure, no per-request dependency, hoisted
// to module scope purely so `VIDEO_VISION_MODEL_COUNT` (needed by the
// route's own `aggregateSummary.totalModels`, a response field outside
// this extraction's seam) stays derived from the same single source of
// truth rather than a second hand-maintained literal in the route.
const VIDEO_VISION_MODELS = [
  { id: "chatgpt", name: "GPT-4o", caller: callOpenAIVision },
  { id: "claude", name: "Claude", caller: callClaudeVision },
  { id: "gemini", name: "Gemini", caller: callGeminiVision },
];

/** Always 3 today — exported so the route never hand-maintains a second copy of this count. */
export const VIDEO_VISION_MODEL_COUNT = VIDEO_VISION_MODELS.length;

export interface VideoVerificationExecutionResult {
  modelResults: VisionModelRow[];
  aggregateVerdict: string;
  aggregateContentType: string;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  /** Raw 0-1 fraction — route call sites apply `Math.round(supportRatio * 100)` themselves, unchanged. */
  supportRatio: number;
  agreementPoints: string[];
  disagreementPoints: string[];
  verdictCounts: {
    authentic_captured: number;
    authentic_produced: number;
    likely_manipulated: number;
    inconclusive: number;
    insufficient: number;
  };
  totalTokens: number;
}

/**
 * Pure, Workspace-agnostic Video analysis: prompt construction, 3-provider
 * vision dispatch, per-model JSON parse/repair, and result aggregation.
 * Byte-identical logic to the removed inline route block — see this
 * module's own header comment for the two narrow, non-semantic
 * adaptations made at the function boundary.
 */
export async function executeVideoVerification(
  frames: ExtractedFrame[],
  metadata: VideoMetadata,
  metadataAnalysis: MetadataAnalysis,
  allWarnings: string[]
): Promise<VideoVerificationExecutionResult> {
  const prompt = buildVideoVerificationPrompt(metadata, metadataAnalysis, frames.length);

  const visionModels = VIDEO_VISION_MODELS;

  logger.debug(`[verify-video] Dispatching to vision models`, { frames: frames.length, models: visionModels.length });

  const modelPromises = visionModels.map(async (model): Promise<VisionModelRow> => {
    const modelStart = Date.now();
    try {
      const response = await model.caller(prompt, frames);
      const elapsed = Date.now() - modelStart;
      logger.debug(`[verify-video] ${model.id} responded`, { modelId: model.id, elapsedMs: elapsed });

      const responseText = response.text || "";
      if (isVisionModelRefusalResponse(responseText)) {
        return refusedModelRow(model, responseText, response.tokens);
      }

      let parsed: Record<string, unknown>;
      try {
        const cleaned = cleanJsonResponse(response.text);
        parsed = JSON.parse(cleaned) as Record<string, unknown>;
      } catch {
        if (isVisionModelRefusalResponse(responseText)) {
          return refusedModelRow(model, responseText, response.tokens);
        }
        try {
          const repaired = repairTruncatedJson(cleanJsonResponse(response.text));
          parsed = JSON.parse(repaired) as Record<string, unknown>;
          logger.debug(`[verify-video] Repaired truncated JSON`, { modelId: model.id });
        } catch {
          if (isVisionModelRefusalResponse(responseText)) {
            return refusedModelRow(model, responseText, response.tokens);
          }
          logger.error(`[verify-video] JSON parse failed`, { modelId: model.id, responseLength: response.text.length });
          return {
            modelId: model.id,
            modelName: model.name,
            status: "parse_error",
            verdict: "insufficient",
            confidence: "low",
            contentType: "unknown",
            summary: "Model returned invalid JSON; could not parse verification result.",
            visualIndicators: [],
            metadataIndicators: [],
            manipulationSignals: [],
            authenticitySignals: [],
            productionSignals: [],
            deceptionIndicators: [],
            compressionNotes: [],
            limitations: ["Response could not be parsed"],
            reasoning: "",
            tokens: response.tokens,
          };
        }
      }

      const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

      return {
        modelId: model.id,
        modelName: model.name,
        status: "ok",
        verdict: normalizeModelVideoVerdict(parsed.verdict),
        confidence: typeof parsed.confidence === "string" ? parsed.confidence : "low",
        contentType: normalizeVideoContentType(parsed.contentType),
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        visualIndicators: asStrArr(parsed.visualIndicators),
        metadataIndicators: asStrArr(parsed.metadataIndicators),
        manipulationSignals: asStrArr(parsed.manipulationSignals),
        authenticitySignals: asStrArr(parsed.authenticitySignals),
        productionSignals: asStrArr(parsed.productionSignals),
        deceptionIndicators: asStrArr(parsed.deceptionIndicators),
        compressionNotes: asStrArr(parsed.compressionNotes),
        limitations: asStrArr(parsed.limitations),
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
        tokens: response.tokens,
      };
    } catch (err: unknown) {
      const elapsed = Date.now() - modelStart;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[verify-video] ${model.id} failed`, { modelId: model.id, elapsedMs: elapsed, error: msg });
      return {
        modelId: model.id,
        modelName: model.name,
        status: "error",
        verdict: "insufficient",
        confidence: "low",
        contentType: "unknown",
        summary: `Model failed: ${msg}`,
        visualIndicators: [],
        metadataIndicators: [],
        manipulationSignals: [],
        authenticitySignals: [],
        productionSignals: [],
        deceptionIndicators: [],
        compressionNotes: [],
        limitations: [`Model error: ${msg}`],
        reasoning: "",
        tokens: 0,
      };
    }
  });

  const settledResults = await Promise.allSettled(modelPromises);
  const modelResults: VisionModelRow[] = settledResults.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const model = visionModels[i];
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    logger.error(`[verify-video] ${model.id} promise rejected unexpectedly`, { modelId: model.id, error: msg });
    return {
      modelId: model.id,
      modelName: model.name,
      status: "error" as const,
      verdict: "insufficient",
      confidence: "low",
      contentType: "unknown",
      summary: `Model failed unexpectedly: ${msg}`,
      visualIndicators: [],
      metadataIndicators: [],
      manipulationSignals: [],
      authenticitySignals: [],
      productionSignals: [],
      deceptionIndicators: [],
      compressionNotes: [],
      limitations: [`Unexpected model error: ${msg}`],
      reasoning: "",
      tokens: 0,
    };
  });

  logger.debug(`[verify-video] All models responded`, {
    statuses: modelResults.map((r) => `${r.modelId}=${r.status}`).join(", "),
  });

  const refusedCount = modelResults.filter((r) => r.status === "refused").length;
  if (refusedCount > 0) {
    logger.debug(`[verify-video] ${refusedCount} model(s) refused to analyze — excluded from consensus`);
  }

  const usableResults = modelResults.filter((r) => r.status === "ok");
  const totalUsable = usableResults.length;

  const verdictCounts = {
    authentic_captured: usableResults.filter((r) => r.verdict === "authentic_captured").length,
    authentic_produced: usableResults.filter((r) => r.verdict === "authentic_produced").length,
    likely_manipulated: usableResults.filter((r) => r.verdict === "likely_manipulated").length,
    inconclusive: usableResults.filter((r) => r.verdict === "inconclusive").length,
    insufficient: usableResults.filter((r) => r.verdict === "insufficient").length,
  };

  const legacyAuthentic = usableResults.filter((r) => r.verdict === "authentic").length;
  verdictCounts.authentic_captured += legacyAuthentic;

  let aggregateVerdict: string;
  if (totalUsable === 0) {
    aggregateVerdict = "insufficient";
  } else if (verdictCounts.likely_manipulated / totalUsable >= 0.67) {
    aggregateVerdict = "likely_manipulated";
  } else if (verdictCounts.authentic_captured / totalUsable >= 0.67) {
    aggregateVerdict = "authentic_captured";
  } else if (verdictCounts.authentic_produced / totalUsable >= 0.67) {
    aggregateVerdict = "authentic_produced";
  } else if (
    (verdictCounts.authentic_captured + verdictCounts.authentic_produced) / totalUsable >= 0.67
  ) {
    aggregateVerdict =
      verdictCounts.authentic_captured >= verdictCounts.authentic_produced
        ? "authentic_captured"
        : "authentic_produced";
  } else if (verdictCounts.insufficient / totalUsable >= 0.5) {
    aggregateVerdict = "insufficient";
  } else {
    aggregateVerdict = "inconclusive";
  }
  // 0.67 = 2/3 majority among models that returned parseable JSON.

  const contentTypeTally = new Map<string, number>();
  for (const r of usableResults) {
    const ct = r.contentType && r.contentType !== "unknown" ? r.contentType : null;
    if (ct) {
      contentTypeTally.set(ct, (contentTypeTally.get(ct) || 0) + 1);
    }
  }
  let aggregateContentType = "unknown";
  if (contentTypeTally.size > 0) {
    let best = "unknown";
    let bestN = 0;
    for (const [ct, n] of contentTypeTally) {
      if (n > bestN) {
        best = ct;
        bestN = n;
      }
    }
    aggregateContentType = best;
  }

  const maxAgreement = Math.max(
    verdictCounts.authentic_captured,
    verdictCounts.authentic_produced,
    verdictCounts.likely_manipulated,
    verdictCounts.inconclusive,
    verdictCounts.insufficient
  );
  const supportRatio = totalUsable > 0 ? maxAgreement / totalUsable : 0;

  let consensusScore = Math.round(supportRatio * 100);
  if (metadataAnalysis.flags.some((f) => f.severity === "suspicious")) {
    consensusScore = Math.max(0, consensusScore - 10);
  }
  if (totalUsable < 3) {
    consensusScore = Math.max(0, consensusScore - 15);
  }
  if (allWarnings.length > 2) {
    consensusScore = Math.max(0, consensusScore - 5);
  }
  // Penalties: suspicious metadata, missing model agreement, noisy client-side extraction warnings.
  consensusScore = Math.min(100, Math.max(0, consensusScore));

  const confidenceLabel = consensusScore >= 80 ? "High" : consensusScore >= 50 ? "Medium" : "Low";
  const evidenceQuality = consensusScore >= 75 ? "strong" : consensusScore >= 50 ? "mixed" : "weak";

  const agreementPoints: string[] = [];
  const disagreementPoints: string[] = [];

  if (verdictCounts.authentic_captured >= 2) {
    agreementPoints.push(
      `${verdictCounts.authentic_captured}/${totalUsable} models identified this as authentic camera footage`
    );
  }
  if (verdictCounts.authentic_produced >= 2) {
    agreementPoints.push(
      `${verdictCounts.authentic_produced}/${totalUsable} models identified this as legitimately produced content`
    );
  }
  if (verdictCounts.likely_manipulated >= 2) {
    agreementPoints.push(
      `${verdictCounts.likely_manipulated}/${totalUsable} models detected deceptive manipulation indicators`
    );
  }

  const manipSignalCounts = new Map<string, number>();
  for (const r of usableResults) {
    for (const signal of r.manipulationSignals) {
      const key = signal.toLowerCase().substring(0, 80);
      manipSignalCounts.set(key, (manipSignalCounts.get(key) || 0) + 1);
    }
  }
  for (const [signal, count] of manipSignalCounts) {
    if (count >= 2 && totalUsable > 0) {
      agreementPoints.push(`${count}/${totalUsable} models flagged: ${signal}`);
    }
  }

  if (verdictCounts.authentic_captured > 0 && verdictCounts.authentic_produced > 0) {
    const capturedModels = usableResults
      .filter((r) => r.verdict === "authentic_captured" || r.verdict === "authentic")
      .map((r) => r.modelName);
    const producedModels = usableResults
      .filter((r) => r.verdict === "authentic_produced")
      .map((r) => r.modelName);
    disagreementPoints.push(
      `${capturedModels.join(", ")} identified camera footage; ${producedModels.join(", ")} identified produced/animated content`
    );
  }

  const nonDeceptiveVerdicts = new Set(["authentic_captured", "authentic_produced", "authentic"]);
  const hasNonDeceptive = usableResults.some((r) => nonDeceptiveVerdicts.has(r.verdict));
  const hasManip = usableResults.some((r) => r.verdict === "likely_manipulated");
  if (hasNonDeceptive && hasManip) {
    const okModels = usableResults
      .filter((r) => nonDeceptiveVerdicts.has(r.verdict))
      .map((r) => r.modelName);
    const manipModels = usableResults
      .filter((r) => r.verdict === "likely_manipulated")
      .map((r) => r.modelName);
    disagreementPoints.push(
      `${okModels.join(", ")} found authentic-style content; ${manipModels.join(", ")} found deceptive manipulation indicators`
    );
  }

  if (
    verdictCounts.inconclusive > 0 &&
    (verdictCounts.authentic_captured > 0 ||
      verdictCounts.authentic_produced > 0 ||
      verdictCounts.likely_manipulated > 0)
  ) {
    const incModels = usableResults.filter((r) => r.verdict === "inconclusive").map((r) => r.modelName);
    disagreementPoints.push(
      `${incModels.join(", ")} could not determine authenticity while other models reached a verdict`
    );
  }

  const totalTokens = modelResults.reduce((sum, r) => sum + (r.tokens || 0), 0);

  return {
    modelResults,
    aggregateVerdict,
    aggregateContentType,
    consensusScore,
    confidenceLabel,
    evidenceQuality,
    supportRatio,
    agreementPoints,
    disagreementPoints,
    verdictCounts,
    totalTokens,
  };
}
