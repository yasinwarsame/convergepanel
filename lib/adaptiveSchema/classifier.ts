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
import { QueryClassification, QueryClassificationFallbackReason, QueryType, AnswerShape } from "./types";
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
const CLASSIFIER_MAX_OUTPUT_TOKENS = 300;
const CONFIDENCE_THRESHOLD = 0.6;
const CACHE_MAX_ENTRIES = 200;

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
];

const ClassificationSchema = z.object({
  queryType: z.enum(QUERY_TYPES as [QueryType, ...QueryType[]]),
  domain: z.string(),
  answerShape: z.enum(ANSWER_SHAPES as [AnswerShape, ...AnswerShape[]]),
  quantExpected: z.boolean(),
  timeSensitivity: z.enum(["low", "medium", "high"]),
  userIntent: z.enum([
    "understand_debate",
    "get_answer",
    "make_decision",
    "learn_process",
    "generate_content",
  ]),
  confidence: z.number().min(0).max(1),
});

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

    const classification = parsed.data;

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
