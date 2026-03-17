/**
 * Grok Connector
 * 
 * Implements function-based connector for X.AI's Grok.
 * Uses X.AI's REST API (OpenAI-compatible format).
 * 
 * This connector uses the XAI_API_KEY environment variable.
 * The canonical model ID used across the app is "grok".
 * 
 * API Endpoint: https://api.x.ai/v1/chat/completions
 * This is the standard OpenAI-compatible endpoint for X.AI's Grok models.
 * 
 * Model Configuration:
 * - The model name is controlled by the GROK_MODEL environment variable
 * - Default: "grok-4-1-fast-reasoning" (fast, cost-efficient, reasoning-capable)
 *   This model offers excellent reasoning capabilities at $0.20/$0.50 pricing with 2M context,
 *   making it ideal for research-style panel questions that require structured analysis.
 * - Can be overridden in .env.local or hosting provider env settings
 * - Example: GROK_MODEL=grok-4-1-fast-non-reasoning (for non-reasoning variant)
 * 
 * IMPORTANT: This connector will fail visibly (return error status) if the API key
 * is missing or if the API call fails, rather than silently returning a mock response.
 * This prevents silent failures where Grok appears selected but never returns results.
 * 
 * Error Handling: All errors are caught and returned as ModelResult with status: "error",
 * ensuring that Grok always appears in the results (either as OK or Error), never silently
 * disappearing from the panel responses.
 */

import { ModelResult } from "@/lib/types";
import { buildPanelPrompt } from "@/lib/panelPrompt";
import { MODEL_LIMITS, getModelTimeout } from "@/lib/modelConfig";
import { GROK_MODEL, XAI_API_KEY } from "@/lib/env";
import { getTotalTokensFromProviderResponse, modelIdToProviderKey, safeNum } from "@/lib/tokenExtraction";

// Use the same unified system prompt as ChatGPT and Claude
// This shared instruction ensures a standardized sectioned format across all models:
// # Summary, # Key Claims, # Evidence and Reasoning, # Uncertainties and Disagreements, # Suggested Follow-Up Questions
// Having the same sections across models improves UX and simplifies the downstream analysis
// (agreement map, trust summary, etc.) by making claim extraction consistent.

/**
 * Helper function to make a fetch request with AbortController timeout
 * 
 * This wraps the fetch call with a configurable timeout using AbortController.
 * The timeout is set per-model via MODEL_TIMEOUTS in modelConfig.ts.
 * If the timeout is hit, it throws an error with a clear message.
 * 
 * @param url - The API endpoint URL
 * @param options - Fetch options (method, headers, body, etc.)
 * @param timeoutMs - Timeout in milliseconds (from MODEL_TIMEOUTS)
 * @returns Promise<Response> - The fetch response, or throws on timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    // If the request was aborted due to timeout, provide a clear, single message.
    // This ensures we throw a clean error message that won't be duplicated in the UI.
    if (error.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`Grok request timed out after ${timeoutMs / 1000} seconds.`);
    }
    // Otherwise, re-throw the original error
    throw error;
  }
}

export async function callGrok(
  question: string,
  context?: string | null,
  apiKey?: string
): Promise<ModelResult> {
  const sanitizedQuestion = question?.trim() ?? "";
  const sanitizedContext = context?.trim() || null;
    const startTime = Date.now();

  if (process.env.NODE_ENV !== "production" && process.env.FORCE_XAI_FAIL === "1") {
    return { modelId: "grok", status: "error", rawText: null, errorMessage: "Forced failure (dev)", latencyMs: 0 };
  }

  // TEMPORARY DEBUG LOG: Check if API key is present
  // This helps diagnose why Grok might not be working
  // TODO: Remove this debug log after confirming Grok works correctly
  console.log("[Grok connector] XAI_API_KEY present?", !!apiKey);
  if (apiKey) {
    console.log("[Grok connector] API key length:", apiKey.length, "characters");
  } else {
    console.warn("[Grok connector] XAI_API_KEY is missing or undefined");
  }

  // Fail visibly if API key is missing - return error result instead of throwing
  // Never throw from here; return a structured error so the UI can render it safely.
  // This ensures users know why Grok isn't working and the error is displayed cleanly
  if (!apiKey || apiKey.trim().length === 0) {
    console.error("[Grok connector] Missing XAI_API_KEY - returning error result");
    return {
      modelId: "grok",
      status: "error" as const,
      rawText: null,
      errorMessage: "Grok (XAI) is not available: missing XAI_API_KEY.",
      latencyMs: 0,
    };
  }

    try {
      /**
       * Make API call using fetch (X.AI uses OpenAI-compatible format)
     * 
     * X.AI API endpoint: https://api.x.ai/v1/chat/completions
     * This is the standard OpenAI-compatible endpoint for X.AI's Grok models.
     * 
     * Model: Uses GROK_MODEL env var (defaults to "grok-4-1-fast-reasoning" for fast, cost-efficient reasoning).
     * 
     * Configuration:
     * - max_tokens: 2000 - Allows long, deep-research style answers so Grok can finish all 6 sections
     *   (summary, key claims, evidence, uncertainties, biases, follow-up questions).
     * - temperature: 0.3 - Lower temperature for more consistent, focused responses.
     * - stream: false - Disable streaming to get the complete response at once.
     * - timeout: 30 seconds - Using AbortController to avoid the UX feeling "hung" if Grok is slow.
       * 
       * Note: If X.AI releases an official SDK, replace this with SDK calls
       * for better error handling and type safety.
       */
    const XAI_API_URL = "https://api.x.ai/v1/chat/completions";
    // Using "grok-4-1-fast-reasoning" by default: fast, cost-efficient, and optimized for reasoning.
    // Can be overridden via GROK_MODEL env variable.
    // This model offers excellent reasoning capabilities at $0.20/$0.50 pricing with 2M context,
    // making it ideal for research-style panel questions that require structured analysis.
    const modelName = GROK_MODEL;
    
    console.log(`[Grok connector] Making API call with model: "${modelName}"...`);
    const modelStartTime = Date.now();
    
    // Get token limits from centralized config
    const grokLimits = MODEL_LIMITS.grok;
    const grokTimeout = getModelTimeout("grok");
    
    // Make the API call with AbortController timeout (60 seconds for Grok)
    // Grok is slower than other models and needs more time for structured deep-research answers.
    // The timeout is set per-model via MODEL_TIMEOUTS in modelConfig.ts.
    const response = await fetchWithTimeout(
      XAI_API_URL,
      {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        body: JSON.stringify({
          model: modelName, // Use configurable model from GROK_MODEL env var
          messages: [
            {
              role: "system",
              // Use the shared deep-research template with model-specific length guidance
              content: buildPanelPrompt("grok", sanitizedQuestion, sanitizedContext),
            },
            { role: "user", content: sanitizedQuestion },
          ],
          stream: false, // Disable streaming - we want the complete response
          // Use centralized token limits to ensure consistent, deep responses without truncation
          // Deep research answers need space for all sections:
          // Summary, Key Claims, Evidence, Uncertainties, Biases, Follow-Up Questions
          max_tokens: grokLimits.maxTokens,
          temperature: 0.3, // Lower temperature for more consistent, focused responses
        }),
      },
      grokTimeout.hardTimeoutMs
    );
    
    const modelLatency = Date.now() - modelStartTime;
    console.log(`[Grok connector] API call took ${modelLatency}ms`);
    console.log(`[Grok connector] API response status:`, response.status, response.statusText);

      // Check HTTP status
      if (!response.ok) {
      // Try to get error details from response body
      let errorDetails = `HTTP ${response.status}`;
      let errorData: any = null;
      
      try {
        // Clone the response so we can read it without consuming it
        const clonedResponse = response.clone();
        errorData = await clonedResponse.json();
        if (errorData.error?.message) {
          errorDetails = `${errorDetails}: ${errorData.error.message}`;
        } else if (errorData.message) {
          errorDetails = `${errorDetails}: ${errorData.message}`;
        }
        console.error("[Grok connector] API error response:", errorData);
      } catch (e) {
        // If we can't parse as JSON, try text
        try {
          const clonedResponse = response.clone();
          const errorText = await clonedResponse.text();
          console.error("[Grok connector] API error response (text):", errorText);
          if (errorText) {
            errorDetails = `${errorDetails}: ${errorText.substring(0, 200)}`;
          }
        } catch (textError) {
          // If we can't read the response at all, just use the status
          console.error("[Grok connector] Could not read error response");
        }
      }
      
      // Throw error with HTTP status details
      // The error message will be captured by runPanel and set as errorMessage
      throw new Error(`Grok API error: HTTP ${response.status}${errorDetails !== `HTTP ${response.status}` ? ` - ${errorDetails}` : ""}`);
      }

      // Parse response (OpenAI-compatible format)
      // Add defensive error handling for JSON parsing failures
      let data: any;
      try {
        data = await response.json();
      } catch (jsonError: any) {
        // If JSON parsing fails, log the error and return a structured error result
        console.error("[Grok connector] Failed to parse JSON response:", jsonError);
        throw new Error(`Grok API returned invalid JSON. Please try again.`);
      }
      
      // Defensive check: ensure data structure is valid
      if (!data || typeof data !== "object") {
        console.error("[Grok connector] Invalid response structure:", data);
        throw new Error(`Grok API returned invalid response format.`);
      }
      
      const choice = data?.choices?.[0];
      // We rely on max_tokens to control length instead of manually chopping the string.
      // No truncation is applied here - the full response is preserved for display and analysis.
      // Do not aggressively truncate Grok output; its deep-research answers need space
      // for all sections (summary, key claims, evidence, uncertainties, biases, follow-ups).
      const rawText = choice?.message?.content?.trim() || null;
      
      // Debug: see how long Grok responses are for deep research panels.
      if (process.env.NODE_ENV === "development") {
        console.log("[Grok] content length:", rawText?.length || 0, "chars");
        if (data.usage) {
          console.log("[Grok] usage:", data.usage);
        }
      }
      
      // Check for API truncation (finish_reason === "length" indicates response was cut due to token limit)
      // This log is to help diagnose future truncation and can be removed later if not needed
      // Don't break anything if finish_reason is missing; just log when present
      const finishReason = choice?.finish_reason;
      if (finishReason === "length") {
        console.warn(
          "[Grok connector] Response truncated due to token limit (finish_reason=length). " +
          "Consider increasing max_tokens or tightening prompt instructions."
        );
      }
      
      // Check if response is empty - throw error if so
      if (!rawText || rawText.length === 0) {
        throw new Error("Grok API returned an empty response.");
      }
      
      // Quick sanity logging for Grok - log final answer length to monitor response health
      // This helps us verify that Grok is completing responses within the timeout
      console.log("[Grok connector] Final answer length:", rawText.length, "chars");
      
      // Optional: if Grok's API has finish_reason (like OpenAI), log when it's "length" (truncation)
      // Don't break anything if finish_reason is missing; just log when present
      if (finishReason === "length") {
        console.warn("[Grok connector] Response truncated due to token limit.");
      }
      
      // Success! Return the result
      const latencyMs = Date.now() - startTime;
      // Log finish_reason if available to help diagnose truncation issues
      if (finishReason) {
        console.log(`[Grok connector] Success. Response length: ${rawText.length} characters (finish_reason: ${finishReason})`);
      } else {
        console.log(`[Grok connector] Success. Response length: ${rawText.length} characters`);
      }
      
      // Extract token usage from X.AI/Grok response (OpenAI-compatible format)
      // getTotalTokensFromProviderResponse always returns a TokenUsage object (never null)
      const providerKey = modelIdToProviderKey("grok");
      const tokenUsage = providerKey 
        ? getTotalTokensFromProviderResponse(providerKey, data)
        : { totalTokens: 0, promptTokens: null, completionTokens: null };

      // Ensure tokenUsage has numeric defaults using safeNum
      const normalizedTokenUsage = {
        totalTokens: safeNum(tokenUsage.totalTokens),
        promptTokens: tokenUsage.promptTokens !== null ? safeNum(tokenUsage.promptTokens) : null,
        completionTokens: tokenUsage.completionTokens !== null ? safeNum(tokenUsage.completionTokens) : null,
      };

      // Dev-only instrumentation: log token usage per model
      const isDebugMode = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEBUG_TOKENS === "true";
      if (isDebugMode) {
        console.log(`[TOKENS:model]`, {
          modelId: "grok",
          ok: true,
          promptTokens: normalizedTokenUsage.promptTokens,
          completionTokens: normalizedTokenUsage.completionTokens,
          totalTokens: normalizedTokenUsage.totalTokens,
        });
      }

      // Log token usage for debugging
      if (normalizedTokenUsage.totalTokens > 0) {
        console.log(`[Grok connector] Token usage:`, normalizedTokenUsage);
      } else if (process.env.NODE_ENV !== "production") {
        console.warn(`[Grok connector] Token usage is 0 or unavailable`);
      }
      
      return {
        modelId: "grok",
        status: "ok",
        rawText,
        latencyMs,
        tokenUsage: normalizedTokenUsage, // Always include tokenUsage (never undefined)
        rawResponse: data, // Store raw response for token extraction and debugging
      };
    } catch (error: any) {
      // Log error for debugging
      // This helps diagnose issues when Grok fails
      console.error("[Grok connector] Error:", error);
      
      // Never throw from here; return a structured error so the UI can render it safely.
      // runPanel will catch this and convert it to a ModelResult with errorMessage,
      // ensuring Grok errors are displayed cleanly without breaking the page.
      const latencyMs = Date.now() - startTime;
      const message = String(error?.message || error || "Grok request failed. Please try again.");
      
      // Check if this is a timeout error
      const isTimeout = 
        error?.name === "AbortError" ||
        message.includes("timed out") ||
        message.includes("timeout");
      
      // Log timeout specifically for debugging
      if (isTimeout) {
        const grokTimeout = getModelTimeout("grok");
        console.warn("[Grok connector] Request timed out", {
          hardTimeoutMs: grokTimeout.hardTimeoutMs,
          latencyMs,
        });
      }
      
      // CRITICAL: All error returns must include tokenUsage with 0 values
      const zeroTokenUsage = { totalTokens: 0, promptTokens: null, completionTokens: null };
      
      // Return error result instead of throwing to prevent page crashes
      const status: "timeout" | "error" = isTimeout ? "timeout" : "error";
      return {
        modelId: "grok",
        status,
        rawText: null,
        errorMessage: message, // Clear error message for UI display
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }
}


