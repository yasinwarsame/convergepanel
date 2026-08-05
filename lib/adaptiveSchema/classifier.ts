/**
 * Query Classifier
 *
 * Runs once, before fan-out, to tag a query with a QueryClassification.
 * Uses the cheapest/fastest connector already in CONNECTOR_MAP (Gemini 2.5
 * Flash) via the existing systemPromptOverride hook — no new provider wiring.
 *
 * Contract: this function must NEVER throw and must NEVER block the pipeline
 * beyond CLASSIFIER_TIMEOUT_MS. Any failure mode (timeout, network error,
 * malformed JSON, low self-reported confidence) falls through to the
 * "generic" classification so the panel always has a schema to render.
 */

import "server-only";
import { createHash } from "crypto";
import { z } from "zod";
import { callGemini } from "@/lib/connectors/gemini";
import { GEMINI_API_KEY } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  QueryClassification,
  QueryClassificationFallbackReason,
  QueryType,
  AnswerShape,
  RiskLevel,
  EvidenceRequirement,
  FreshnessRequirement,
  ClassificationInputType,
  VerificationMethod,
  HandoffTarget,
} from "./types";
import { CLASSIFIER_SYSTEM_PROMPT } from "./classifierPrompt";
import { stripJsonFences, withTimeout } from "./util";

// Was 3000ms — far tighter than every other Gemini call in this module
// (cluster 8000ms, backfill 6000ms, synthesis 10000ms, bias 12000ms) despite
// sharing the same rate-limited GEMINI_API_KEY under concurrent panel load.
// Observed in production (2026-07-27): under concurrent load this budget was
// too tight and the classifier silently fell through to "generic" for
// legitimately contested_empirical questions. Raised to match the other
// short Gemini calls in this module.
const CLASSIFIER_TIMEOUT_MS = 8000;
// Was 300 — too tight for gemini-2.5-flash, which shares its "thinking"
// token budget with maxOutputTokens on this SDK/model combination. At 300,
// thinking alone routinely consumed the entire budget (finishReason
// MAX_TOKENS with a handful of visible completion tokens), truncating the
// JSON response to nothing and silently falling through to "generic" for
// every query, regardless of its actual type — the same "silently fell
// through to generic" failure class as the CLASSIFIER_TIMEOUT_MS fix above,
// just via truncation instead of timeout. thinkingBudget: 0 below (now
// supported by the Gemini connector) is the primary fix — this raise is
// defense in depth in case thinking can't be fully suppressed.
const CLASSIFIER_MAX_OUTPUT_TOKENS = 1024;
const CONFIDENCE_THRESHOLD = 0.6;
const CACHE_MAX_ENTRIES = 200;

// Every queryType the classifier may output — the full 28-type taxonomy,
// not just the 10 "active" ones. Classification and routing are
// deliberately separate concerns: the classifier's job is to say what a
// question IS as accurately as possible; routeClassifiedQuery.ts (reading
// schemaRegistry.ts's implementationStatus) is what decides whether it's
// safe to actually execute. Under-teaching the classifier to avoid
// "wasting" accuracy on disabled types would just make disabled types
// silently misclassify as "generic" instead of correctly routing to
// graceful_limitation — the exact bug this redesign exists to prevent.
const QUERY_TYPES: QueryType[] = [
  "contested_empirical",
  "legal_regulatory",
  "financial_valuation",
  "factual_lookup",
  "procedural",
  "medical_health",
  "forecast_speculative",
  "creative_generative",
  "generic",
  "graceful_limitation",
  "claim_verification",
  "media_authenticity_review",
  "document_qa",
  "document_comparison",
  "data_analysis",
  "current_live_information",
  "definition_explanation",
  "causal_explanation",
  "ranked_enumeration",
  "checklist_taxonomy",
  "comparison_matrix",
  "deep_research",
  "evidence_review",
  "bias_blindspot_audit",
  "decision_support",
  "scenario_analysis",
  "step_by_step_plan",
  "transformation",
];

const ANSWER_SHAPES: AnswerShape[] = [
  "consensus_map",
  "rule_application",
  "metrics_grid",
  "verdict_card",
  "step_diff",
  "evidence_tiers",
  "scenario_tree",
  "gallery",
  "generic_sections",
  "direct_answer",
  "limitation_notice",
  "ranked_list",
  "comparison_grid",
  "definition_card",
  "causal_map",
  "checklist_taxonomy_view",
  "deep_research_view",
  "evidence_review_view",
  "bias_blindspot_audit_view",
  "decision_support_view",
];

const RISK_LEVELS: RiskLevel[] = ["casual", "professional", "high_stakes", "safety_critical"];
const EVIDENCE_REQUIREMENTS: EvidenceRequirement[] = ["low", "medium", "high", "regulated"];
const FRESHNESS_LEVELS: FreshnessRequirement[] = ["timeless", "date_sensitive", "recent", "live"];
const INPUT_TYPES: ClassificationInputType[] = [
  "text",
  "url",
  "document",
  "documents",
  "image",
  "video",
  "audio",
  "dataset",
  "mixed",
];
const VERIFICATION_METHODS: VerificationMethod[] = [
  "cross_model_consistency",
  "claim_stance_agreement",
  "semantic_item_overlap",
  "rank_correlation",
  "source_support",
  "numerical_consistency",
  "document_alignment",
  "visual_signal_comparison",
  "human_review",
  "none",
];

/** Maps a classified handoff queryType to its dedicated-feature target — kept in sync with schemaRegistry.ts's handoffEntry() calls. */
const HANDOFF_TARGET_BY_QUERY_TYPE: Partial<Record<QueryType, HandoffTarget>> = {
  claim_verification: "claim_verification",
  media_authenticity_review: "video_verification",
};

// queryType/answerShape are render-critical — they select the schema, so
// they stay strictly validated and a bad value correctly fails the whole
// classification. The remaining enums are cross-cutting metadata (never
// used to pick a renderer) and the model can conflate two similarly-named
// ones under real conditions — observed in production: "timeSensitivity"
// (low/medium/high) returned a "freshness"-shaped value like "recent"
// instead. Previously that single mismatched field failed the ENTIRE
// classification via safeParse and threw away a perfectly correct
// queryType, silently downgrading the run to "generic" no differently than
// a real misclassification would. `.catch()` degrades just that one field
// to a safe default instead, so a genuinely correct queryType still reaches
// its dedicated schema/renderer.
const ClassificationSchema = z.object({
  queryType: z.enum(QUERY_TYPES as [QueryType, ...QueryType[]]),
  domain: z.string(),
  answerShape: z.enum(ANSWER_SHAPES as [AnswerShape, ...AnswerShape[]]),
  quantExpected: z.boolean(),
  timeSensitivity: z.enum(["low", "medium", "high"]).catch("low"),
  userIntent: z
    .enum(["understand_debate", "get_answer", "make_decision", "learn_process", "generate_content"])
    .catch("get_answer"),
  confidence: z.number().min(0).max(1),
  riskLevel: z.enum(RISK_LEVELS as [RiskLevel, ...RiskLevel[]]).catch("professional"),
  evidenceRequirement: z
    .enum(EVIDENCE_REQUIREMENTS as [EvidenceRequirement, ...EvidenceRequirement[]])
    .catch("medium"),
  freshness: z.enum(FRESHNESS_LEVELS as [FreshnessRequirement, ...FreshnessRequirement[]]).catch("timeless"),
  inputType: z.enum(INPUT_TYPES as [ClassificationInputType, ...ClassificationInputType[]]).catch("text"),
  verificationMethod: z
    .enum(VERIFICATION_METHODS as [VerificationMethod, ...VerificationMethod[]])
    .catch("cross_model_consistency"),
  requestedCount: z.number().nullable().optional(),
  requiresClarification: z.boolean(),
  clarificationQuestion: z.string().nullable().optional(),
  rationale: z.string(),
});

/** Fills the new Milestone-1 metadata fields with safe, conservative defaults for the defensive "generic" fallback path — never blocks the pipeline waiting on a real classification. */
function genericFallback(reason: QueryClassificationFallbackReason, confidence = 0): QueryClassification {
  return {
    queryType: "generic",
    domain: "unknown",
    answerShape: "generic_sections",
    quantExpected: false,
    timeSensitivity: "low",
    userIntent: "get_answer",
    confidence,
    fallbackReason: reason,
    riskLevel: "professional",
    evidenceRequirement: "medium",
    freshness: "timeless",
    inputType: "text",
    verificationMethod: "cross_model_consistency",
    requestedCount: null,
    requiresClarification: false,
    rationale: `Fell back to generic: ${reason}.`,
  };
}

/** Simple LRU cache keyed by normalized query string. */
class LRUCache<V> {
  private map = new Map<string, V>();
  constructor(private maxEntries: number) {}

  get(key: string): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    // Refresh recency: delete + re-insert moves the key to the end.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }
}

const classificationCache = new LRUCache<QueryClassification>(CACHE_MAX_ENTRIES);

function normalizeQueryForCache(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

/**
 * Classify a query's epistemic structure. Never throws; always resolves to
 * a QueryClassification (falling back to "generic" on any failure mode).
 */
export async function classifyQuery(query: string): Promise<QueryClassification> {
  const startedAt = Date.now();
  const trimmedQuery = query.trim();
  const queryHash = hashQuery(trimmedQuery);

  if (!trimmedQuery) {
    return genericFallback("empty_query");
  }

  const cacheKey = normalizeQueryForCache(trimmedQuery);
  const cached = classificationCache.get(cacheKey);
  if (cached) {
    logger.debug("[adaptiveSchema] Classification cache hit", { queryHash, queryType: cached.queryType });
    return cached;
  }

  try {
    const result = await withTimeout(
      callGemini(trimmedQuery, null, GEMINI_API_KEY, {
        systemPromptOverride: CLASSIFIER_SYSTEM_PROMPT,
        maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
        // Classification is a short structured-JSON task with no benefit
        // from extended reasoning — disable thinking so the full output
        // budget goes to the actual answer, not invisible thought tokens.
        thinkingBudget: 0,
      }),
      CLASSIFIER_TIMEOUT_MS
    );

    const latencyMs = Date.now() - startedAt;

    if (result.status !== "ok" || !result.rawText) {
      logger.info("[adaptiveSchema] Classification failed, falling back to generic", {
        queryHash,
        latencyMs,
        reason: result.status,
      });
      const fallback = genericFallback("connector_error");
      classificationCache.set(cacheKey, fallback);
      return fallback;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripJsonFences(result.rawText));
    } catch {
      logger.info("[adaptiveSchema] Classification response was not valid JSON, falling back to generic", {
        queryHash,
        latencyMs,
      });
      const fallback = genericFallback("malformed_json");
      classificationCache.set(cacheKey, fallback);
      return fallback;
    }

    const parsed = ClassificationSchema.safeParse(parsedJson);
    if (!parsed.success) {
      logger.info("[adaptiveSchema] Classification response failed schema validation, falling back to generic", {
        queryHash,
        latencyMs,
        issues: parsed.error.issues.map((i) => i.path.join(".")),
      });
      const fallback = genericFallback("schema_invalid");
      classificationCache.set(cacheKey, fallback);
      return fallback;
    }

    // zod v4 types a .catch()'d field as optional on the inferred object type
    // (the runtime value is never actually undefined — catch always supplies
    // its default) — the `??` fallbacks below satisfy QueryClassification's
    // required fields without a blanket cast past real type errors elsewhere.
    const classification: QueryClassification = {
      ...parsed.data,
      timeSensitivity: parsed.data.timeSensitivity ?? "low",
      userIntent: parsed.data.userIntent ?? "get_answer",
      riskLevel: parsed.data.riskLevel ?? "professional",
      evidenceRequirement: parsed.data.evidenceRequirement ?? "medium",
      freshness: parsed.data.freshness ?? "timeless",
      inputType: parsed.data.inputType ?? "text",
      verificationMethod: parsed.data.verificationMethod ?? "cross_model_consistency",
      handoffTarget: HANDOFF_TARGET_BY_QUERY_TYPE[parsed.data.queryType],
    };

    if (classification.confidence < CONFIDENCE_THRESHOLD) {
      logger.info("[adaptiveSchema] Classification confidence below threshold, falling back to generic", {
        queryHash,
        latencyMs,
        attemptedQueryType: classification.queryType,
        confidence: classification.confidence,
      });
      const fallback = genericFallback("low_confidence", classification.confidence);
      classificationCache.set(cacheKey, fallback);
      return fallback;
    }

    logger.info("[adaptiveSchema] Classified query", {
      queryHash,
      queryType: classification.queryType,
      confidence: classification.confidence,
      latencyMs,
    });

    classificationCache.set(cacheKey, classification);
    return classification;
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    logger.warn("[adaptiveSchema] Classifier threw/timed out, falling back to generic", {
      queryHash,
      latencyMs,
      error: err?.message,
    });
    // Never cache transient failures — a later call might succeed.
    return genericFallback("timeout");
  }
}
