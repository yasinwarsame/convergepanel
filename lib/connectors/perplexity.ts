/**
 * Perplexity Connector
 * 
 * Perplexity connector: calls the /chat/completions endpoint with OpenAI-style messages
 * and logs the full error body if the API returns a non-2xx status for easier debugging.
 * 
 * Implements function-based connector for Perplexity AI.
 * Perplexity is optimized for research and provides citations.
 * Uses the Sonar model with online search capabilities.
 * 
 * This connector uses the PERPLEXITY_API_KEY environment variable from @/lib/env.
 * The canonical model ID used across the app is "perplexity".
 * 
 * IMPORTANT: This connector will fail visibly (return error status) if the API key
 * is missing, rather than silently returning a mock response. This prevents silent
 * failures where Perplexity appears selected but never returns results.
 */

import { ModelResult } from "@/lib/types";
import { buildPanelPrompt } from "@/lib/panelPrompt";
import { MODEL_LIMITS, getModelTimeout } from "@/lib/modelConfig";
import { PERPLEXITY_API_KEY } from "@/lib/env";
import { getTotalTokensFromProviderResponse, modelIdToProviderKey, safeNum } from "@/lib/tokenExtraction";
import { logger } from "@/lib/logger";

/**
 * Call Perplexity API
 * 
 * Perplexity expects a messages array in OpenAI-style format:
 * - messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userQuestion }]
 * 
 * @param question - The user's question to ask Perplexity
 * @param apiKey - Optional API key (for backward compatibility, but we use PERPLEXITY_API_KEY from env)
 * @returns Promise<ModelResult> - Always returns a result, never throws
 */
export async function callPerplexity(
  question: string,
  context?: string | null,
  apiKey?: string
): Promise<ModelResult> {
  const sanitizedQuestion = question?.trim() ?? "";
  const sanitizedContext = context?.trim() || null;
  const startTime = Date.now();

  if (process.env.NODE_ENV !== "production" && process.env.FORCE_PERPLEXITY_FAIL === "1") {
    return { modelId: "perplexity", status: "error", rawText: null, errorMessage: "Forced failure (dev)", latencyMs: 0 };
  }

  // Use API key from env helper (preferred) or fallback to parameter (for backward compatibility)
  const effectiveApiKey = PERPLEXITY_API_KEY || apiKey;

  // Validate API key
  if (!effectiveApiKey || effectiveApiKey.trim().length === 0) {
    logger.error("[Perplexity connector] Missing PERPLEXITY_API_KEY - returning error result instead of mock");
    return {
      modelId: "perplexity",
      status: "error",
      rawText: "Perplexity is not available: missing PERPLEXITY_API_KEY. Please configure PERPLEXITY_API_KEY in your .env.local file.",
      errorMessage: "Perplexity is not available: missing PERPLEXITY_API_KEY.",
      latencyMs: Date.now() - startTime,
    };
  }

  try {
    /**
     * Make API call to Perplexity
     * 
     * Uses OpenAI-compatible chat completions endpoint.
     * The "online" model variant enables real-time web search.
     * 
     * Perplexity expects a messages array in OpenAI-style format:
     * - messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userQuestion }]
     */
    logger.debug("[Perplexity connector] Making API call to Perplexity");
    
    // Get token limits and timeout from centralized config
    const perplexityLimits = MODEL_LIMITS.perplexity;
    const perplexityTimeout = getModelTimeout("perplexity");
    
    // Build messages array in OpenAI-style format
    // Perplexity requires messages array, not just a prompt string
    const messages = [
      // Use the shared deep-research template with model-specific length guidance
      { role: "system" as const, content: buildPanelPrompt("perplexity", sanitizedQuestion, sanitizedContext) },
      { role: "user" as const, content: sanitizedQuestion },
    ];
    
    // Use AbortController for timeout handling
    // This allows us to distinguish between timeout (AbortError) and HTTP/JSON errors
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), perplexityTimeout.hardTimeoutMs);
    
    const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
    const requestBody = {
      // Perplexity valid models: "sonar", "sonar-pro", "sonar-deep-research", etc.
      // Using "sonar" as the default general-purpose model.
      model: "sonar", // Valid Perplexity model
      messages, // OpenAI-style messages array
      // Use centralized token limits to ensure consistent, deep responses without truncation
      max_tokens: perplexityLimits.maxTokens,
      temperature: 0.2,
    };
    
    let response: Response;
    
    try {
      response = await fetch(PERPLEXITY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${effectiveApiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      logger.debug("[Perplexity connector] API response status", { status: response.status, statusText: response.statusText });

      // Check HTTP status and extract detailed error information
      // Never throw from here; return a structured error so the UI can render it safely.
      if (!response.ok) {
        const latencyMs = Date.now() - startTime;
        
        // Try to parse error JSON for detailed error message
        const errorJson = await response.json().catch(() => null);
        logger.error("[Perplexity connector] Perplexity API error", { status: response.status, error: errorJson });
        
        // Extract error message from Perplexity's response structure
        // Perplexity typically returns: { error: { message: "...", type: "...", code: ... } }
        const errorMessage = 
          `Perplexity API error: HTTP ${response.status}` +
          (errorJson?.error?.message ? ` - ${errorJson.error.message}` : "");
        
        // Return error result with the real Perplexity error message
        return {
          modelId: "perplexity",
          status: "error" as const,
          rawText: null,
          errorMessage, // Real error message from Perplexity API
          latencyMs,
        };
      }

      // Parse response (OpenAI-compatible format)
      // This normalizes Perplexity output to our internal answer format, matching other models
      const json = await response.json();
      
      // Defensive check: ensure data structure is valid
      if (!json || typeof json !== "object") {
        const latencyMs = Date.now() - startTime;
        logger.error("[Perplexity connector] Invalid response structure", { json });
        
        return {
          modelId: "perplexity",
          status: "error" as const,
          rawText: null,
          errorMessage: "Perplexity API returned invalid response format.",
          latencyMs,
        };
      }
      
      // Extract response text and metadata
      const choice = json.choices?.[0];
      const rawText = choice?.message?.content?.trim() || null;
      const finishReason = choice?.finish_reason || json.choices?.[0]?.finish_reason || null;
      const stopReason = choice?.stop_reason || null;
      const latencyMs = Date.now() - startTime;

      // Log response diagnostics (debug level - verbose)
      logger.debug("[Perplexity connector] Response diagnostics", {
        provider: "perplexity",
        responseTextLength: rawText?.length || 0,
        finishReason: finishReason || null,
        stopReason: stopReason || null,
        hasContent: !!rawText,
        streamingUsed: false, // Perplexity uses non-streaming by default
        readingCompleted: !!rawText,
        latencyMs,
      });
      
      // Warn if response was truncated by token limit
      if (finishReason === "length" || finishReason === "stop") {
        logger.warn("[Perplexity connector] Response may be truncated", {
          finishReason,
          stopReason,
          responseLength: rawText?.length || 0,
        });
      }

      // Extract token usage from Perplexity response (OpenAI-compatible format)
      // getTotalTokensFromProviderResponse always returns a TokenUsage object (never null)
      const providerKey = modelIdToProviderKey("perplexity");
      const tokenUsage = providerKey 
        ? getTotalTokensFromProviderResponse(providerKey, json)
        : { totalTokens: 0, promptTokens: null, completionTokens: null };

      // Ensure tokenUsage has numeric defaults using safeNum
      const normalizedTokenUsage = {
        totalTokens: safeNum(tokenUsage.totalTokens),
        promptTokens: tokenUsage.promptTokens !== null ? safeNum(tokenUsage.promptTokens) : null,
        completionTokens: tokenUsage.completionTokens !== null ? safeNum(tokenUsage.completionTokens) : null,
      };

      // Log token usage (debug level - verbose)
      logger.debug(`[Perplexity connector] Token usage`, {
        modelId: "perplexity",
        ok: rawText ? true : false,
        promptTokens: normalizedTokenUsage.promptTokens,
        completionTokens: normalizedTokenUsage.completionTokens,
        totalTokens: normalizedTokenUsage.totalTokens,
      });
      
      if (normalizedTokenUsage.totalTokens === 0) {
        logger.warn(`[Perplexity connector] Token usage is 0 or unavailable`);
      }

      // Build result object
      const result: ModelResult = {
        modelId: "perplexity",
        status: rawText ? "ok" : "error",
        rawText: rawText ?? "Perplexity did not return any content.",
        latencyMs,
        tokenUsage: normalizedTokenUsage, // Always include tokenUsage (never undefined)
        rawResponse: json, // Store raw response for token extraction and debugging
      };
      
      // Include finish_reason in response if available (for diagnostics)
      if (finishReason) {
        (result as any).finishReason = finishReason;
      }
      
      // Warn if response was truncated due to token limit
      if (finishReason === "length") {
        (result as any).wasTruncated = true;
        // Only set errorMessage if not already present (don't overwrite other errors)
        if (!result.errorMessage) {
          result.errorMessage = "Response was truncated due to token limit. Consider increasing max_tokens for longer responses.";
        }
      }
      
      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);
      
      // Explicitly check for AbortError (timeout)
      if (err.name === "AbortError" || controller.signal.aborted) {
        // Explicit timeout error - return friendly message for UI
        const latencyMs = Date.now() - startTime;
        const perplexityTimeout = getModelTimeout("perplexity");
        logger.warn("[Perplexity connector] Request timed out", {
          hardTimeoutMs: perplexityTimeout.hardTimeoutMs,
          latencyMs,
        });
        return {
          modelId: "perplexity",
          status: "timeout" as const,
          rawText: null,
          errorMessage: `Perplexity request timed out after ${perplexityTimeout.hardTimeoutMs / 1000} seconds.`,
          latencyMs,
        };
      }
      
      // Log other errors for diagnosis
      logger.error("[Perplexity connector] Request failed", { error: err?.message });
      
      // Re-throw to be caught by outer catch block for other error types
      throw new Error(err?.message || "Perplexity request failed. Please try again.");
    }
  } catch (error: any) {
    // Never throw from here; return a structured error so the UI can render it safely.
    // This catch block handles errors that were re-thrown from the inner try/catch
    const latencyMs = Date.now() - startTime;
    
    // Log error for diagnosis
    logger.error("[Perplexity connector] Request failed", { error: error?.message });
    
    // Extract error message - use the message from the thrown error
    const errorMessage = error?.message || "Perplexity request failed. Please try again.";
    
    // CRITICAL: All error returns must include tokenUsage with 0 values
    const zeroTokenUsage = { totalTokens: 0, promptTokens: null, completionTokens: null };

    // Handle rate limiting
    if (error?.status === 429 || error?.message?.includes("rate limit") || error?.message?.includes("quota")) {
      return {
        modelId: "perplexity",
        status: "refused" as const,
        rawText: null,
        errorMessage: `429 rate limit / quota exceeded: ${error?.message?.slice(0, 200) ?? "unknown"}`,
        latencyMs,
        tokenUsage: zeroTokenUsage,
      };
    }

    // Handle authentication errors
    if (error?.status === 401 || error?.message?.toLowerCase?.().includes("api key") || error?.message?.toLowerCase?.().includes("unauthorized")) {
      return {
        modelId: "perplexity",
        status: "error" as const,
        rawText: null,
        errorMessage: "Perplexity authentication error. Check your API key.",
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    // Handle network errors
    if (error?.message?.includes("fetch") || error?.message?.includes("network") || error?.message?.includes("ECONNREFUSED") || error?.message?.includes("Failed to fetch")) {
      return {
        modelId: "perplexity",
        status: "error" as const,
        rawText: null,
        errorMessage: "Perplexity network error. Please check your connection.",
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    // Return error result with the error message (which may be from inner catch or generic)
    return {
      modelId: "perplexity",
      status: "error" as const,
      rawText: null,
      errorMessage, // Error message flows through to UI
      latencyMs,
      tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
    };
  }
}


