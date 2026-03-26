/**
 * Model Configuration - Centralized Token Limits
 * 
 * This is the single source of truth for token limits across all models.
 * All model connectors (ChatGPT, Claude, Grok, Perplexity) import and use
 * these values to ensure consistent, deep, research-grade responses.
 * 
 * IMPORTANT: If you need to change token limits, update ONLY this file.
 * All models will automatically use the updated values.
 * 
 * Token Limits Explained:
 * - maxTokens: Upper hard cap passed to the API. This prevents responses from
 *   exceeding the model's context window and ensures we get complete responses.
 * - softMaxTokens: What we *aim* for in prompt instructions. This is the target
 *   length we communicate to the model in the prompt template.
 * 
 * Current Settings (2200/1800):
 * - These values are chosen to allow full structured answers without truncation.
 * - Deep research responses need space for all sections:
 *   Summary, Key Claims, Evidence and Reasoning, Uncertainties and Disagreements,
 *   Potential Biases and Blind Spots, Gaps and Open Questions, Methodology / Sources,
 *   Alternative Perspectives, Implications and Next Steps, Suggested Follow-Up Questions
 * - 2200 tokens is approximately 1,600-1,800 words, which is sufficient for deep,
 *   research-grade answers that fill every section meaningfully.
 */

import { PanelModelId } from "./panelModels";

export type ModelId = PanelModelId;

export interface ModelLimits {
  /** Upper hard cap passed to the API - prevents responses from exceeding context window */
  maxTokens: number;
  /** What we *aim* for in prompt instructions - target length communicated to the model */
  softMaxTokens: number;
}

/**
 * Per-model timeout configuration
 * 
 * Each model has a hard timeout limit. If a request exceeds this limit,
 * it will be canceled and marked as "timeout" status.
 * 
 * Timeouts are set based on each model's typical response time:
 * - ChatGPT: 60s (can be slower for deep research queries)
 * - Claude: 30s (generally fast)
 * - Grok: 60s (slower model, needs more time for structured answers)
 * - Perplexity: 60s (web search adds latency)
 */
export interface ModelTimeoutConfig {
  /** Hard timeout in milliseconds - request will be canceled after this duration */
  hardTimeoutMs: number;
}

/**
 * Centralized token limits for all panel models
 * 
 * These values ensure consistent, deep, research-grade responses across all models.
 * All connectors import MODEL_LIMITS and use the appropriate maxTokens value.
 */
export const MODEL_LIMITS: Record<ModelId, ModelLimits> = {
  chatgpt: {
    maxTokens: 2200,
    softMaxTokens: 1800,
  },
  claude: {
    // Increased maxTokens to 4000 to ensure Claude can return full deep-research answers,
    // including long "Suggested Follow-Up Questions" sections, without being cut off.
    // Claude-3-haiku supports up to 200k context, so 4000 output tokens is well within limits.
    maxTokens: 4000,
    softMaxTokens: 1800,
  },
  grok: {
    maxTokens: 2200,
    softMaxTokens: 1800,
  },
  perplexity: {
    // Increased maxTokens to 6000 for Perplexity Pro to support long research responses
    // Perplexity Pro can generate comprehensive responses with multiple sections:
    // SUMMARY, KEY CLAIMS, EVIDENCE, UNCERTAINTIES, BIASES, METRICS, METHODOLOGY, ALTERNATIVE PERSPECTIVES
    // 6000 tokens (~4500-5000 words) ensures all sections are included without truncation
    maxTokens: 6000,
    softMaxTokens: 1800,
  },
  gemini: {
    // Default maxTokens 8192 (configurable via GEMINI_MAX_OUTPUT_TOKENS env var)
    // Large enough for long research answers and claim-verification JSON without truncation
    // Research-style long answers need space for all sections:
    // Summary, Key Claims, Evidence, Uncertainties, Biases, Gaps, Methodology, etc.
    // Default: 4096 tokens (~3000-3200 words), env override supported
    maxTokens: (() => {
      const envValue = process.env.GEMINI_MAX_OUTPUT_TOKENS;
      if (envValue) {
        const parsed = parseInt(envValue, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          // Cap at 8192 (reasonable upper limit for Gemini 2.0 Flash)
          return Math.min(parsed, 8192);
        }
      }
      return 8192; // Default: 8192 — avoids truncation on large JSON (e.g. claim verification) when no per-call override
    })(),
    softMaxTokens: 1800,
  },
};

/**
 * Centralized timeout configuration for all panel models
 * 
 * These values ensure consistent timeout handling across all connectors.
 * All connectors import MODEL_TIMEOUTS and use the appropriate hardTimeoutMs value.
 */
export const MODEL_TIMEOUTS: Record<ModelId, ModelTimeoutConfig> = {
  chatgpt: {
    hardTimeoutMs: 60_000, // 60 seconds for deep research queries
  },
  claude: {
    hardTimeoutMs: 30_000, // 30 seconds (generally fast)
  },
  grok: {
    hardTimeoutMs: 60_000, // 60 seconds (slower model, needs more time)
  },
  perplexity: {
    hardTimeoutMs: 90_000, // 90 seconds (web search + long responses need more time)
  },
  gemini: {
    hardTimeoutMs: 60_000, // 60 seconds (similar to other models)
  },
};

/**
 * Get token limits for a specific model
 * 
 * @param modelId - The model ID (chatgpt, claude, grok, perplexity)
 * @returns ModelLimits for the specified model, or defaults if modelId is invalid
 */
export function getModelLimits(modelId: ModelId): ModelLimits {
  return MODEL_LIMITS[modelId] || MODEL_LIMITS.chatgpt;
}

/**
 * Get timeout configuration for a specific model
 * 
 * @param modelId - The model ID (chatgpt, claude, grok, perplexity)
 * @returns ModelTimeoutConfig for the specified model, or defaults if modelId is invalid
 */
export function getModelTimeout(modelId: ModelId): ModelTimeoutConfig {
  return MODEL_TIMEOUTS[modelId] || MODEL_TIMEOUTS.chatgpt;
}

