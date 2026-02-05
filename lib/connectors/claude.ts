import Anthropic from "@anthropic-ai/sdk";
import { ModelResult } from "@/lib/types";
import { buildPanelPrompt } from "@/lib/panelPrompt";
import { MODEL_LIMITS, getModelTimeout } from "@/lib/modelConfig";
import { getTotalTokensFromProviderResponse, modelIdToProviderKey, safeNum } from "@/lib/tokenExtraction";

/**
 * Create a timeout promise that rejects after the model's configured timeout
 * 
 * This is used with Promise.race to enforce a maximum request duration.
 * If the timeout fires, it rejects with an error that can be caught and
 * converted to a "timeout" status in the ModelResult.
 * 
 * @param timeoutMs - Timeout in milliseconds (from MODEL_TIMEOUTS)
 */
function createTimeout(timeoutMs: number) {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), timeoutMs)
  );
}

function mockResult(): ModelResult {
  return {
    modelId: "claude",
    status: "ok",
    rawText: "Mock response from claude (no API key configured)",
    latencyMs: 0,
  };
}

export async function callClaude(
  question: string,
  context?: string | null,
  apiKey?: string
): Promise<ModelResult> {
  const sanitizedQuestion = question?.trim() ?? "";
  const sanitizedContext = context?.trim() || null;
  const startTime = Date.now();

  if (!apiKey) {
    return mockResult();
  }

  try {
    const anthropic = new Anthropic({ apiKey });

    // Get token limits and timeout from centralized config
    const claudeLimits = MODEL_LIMITS.claude;
    const claudeTimeout = getModelTimeout("claude");
    
    const message = await Promise.race([
      anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        // Use centralized token limits to ensure consistent, deep responses without truncation
        max_tokens: claudeLimits.maxTokens,
        // Use the shared deep-research template with model-specific length guidance
        system: buildPanelPrompt("claude", sanitizedQuestion, sanitizedContext),
        messages: [{ role: "user", content: sanitizedQuestion }],
      }),
      createTimeout(claudeTimeout.hardTimeoutMs),
    ]);

    // Defensive error handling: ensure message structure is valid
    if (!message || typeof message !== "object") {
      throw new Error("Claude API returned invalid response structure");
    }
    
    // Defensive check: ensure content array exists
    if (!Array.isArray(message.content)) {
      throw new Error("Claude API returned invalid content structure");
    }

    const rawText = message.content
      .filter((block) => block && block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n")
      .trim() || null;
    const latencyMs = Date.now() - startTime;

    // Check for API truncation (stop_reason === "max_tokens" indicates response was cut due to token limit)
    // Anthropic uses "stop_reason" instead of "finish_reason" (OpenAI/Grok format)
    const stopReason = (message as any).stop_reason;
    if (stopReason === "max_tokens") {
      console.warn(
        "[Claude connector] Response truncated due to token limit (stop_reason=max_tokens). " +
        "Consider increasing max_tokens or tightening prompt instructions."
      );
      // Note: We still return the partial response, but log the truncation for debugging
    }

    // Log response length and stop_reason in development to help diagnose truncation issues
    if (process.env.NODE_ENV === "development" && rawText) {
      console.log(`[Claude connector] Response length: ${rawText.length} characters (stop_reason: ${stopReason || "unknown"})`);
    }

    // Extract token usage from Anthropic response
    // getTotalTokensFromProviderResponse always returns a TokenUsage object (never null)
    const providerKey = modelIdToProviderKey("claude");
    const tokenUsage = providerKey 
      ? getTotalTokensFromProviderResponse(providerKey, message)
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
        modelId: "claude",
        ok: rawText ? true : false,
        promptTokens: normalizedTokenUsage.promptTokens,
        completionTokens: normalizedTokenUsage.completionTokens,
        totalTokens: normalizedTokenUsage.totalTokens,
      });
    }

    // Log token usage for debugging
    if (normalizedTokenUsage.totalTokens > 0) {
      console.log(`[Claude connector] Token usage:`, normalizedTokenUsage);
    } else if (process.env.NODE_ENV !== "production") {
      console.warn(`[Claude connector] Token usage is 0 or unavailable`);
    }

    return {
      modelId: "claude",
      status: rawText ? "ok" : "error",
      rawText: rawText ?? "Claude did not return any content.",
      latencyMs,
      tokenUsage: normalizedTokenUsage, // Always include tokenUsage (never undefined)
      rawResponse: message, // Store raw response for token extraction and debugging
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    console.error("Claude API error:", {
      message: error?.message,
      status: error?.status,
      name: error?.name,
    });

    // CRITICAL: All error returns must include tokenUsage with 0 values
    const zeroTokenUsage = { totalTokens: 0, promptTokens: null, completionTokens: null };

    if (error?.message === "timeout" || error?.message?.includes("timeout")) {
      const claudeTimeout = getModelTimeout("claude");
      console.warn("[Claude connector] Request timed out", {
        hardTimeoutMs: claudeTimeout.hardTimeoutMs,
        latencyMs,
      });
      return {
        modelId: "claude",
        status: "timeout",
        rawText: null,
        errorMessage: `Claude request timed out after ${claudeTimeout.hardTimeoutMs / 1000} seconds.`,
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    if (error?.status === 429 || error?.message?.includes("rate limit")) {
      return {
        modelId: "claude",
        status: "refused",
        rawText: "Claude rate limit exceeded. Please retry shortly.",
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    if (error?.status === 401 || error?.message?.toLowerCase?.().includes("api key")) {
      return {
        modelId: "claude",
        status: "error",
        rawText: "Claude authentication error. Check your API key.",
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    return {
      modelId: "claude",
      status: "error",
      rawText: "Claude request failed. Please try again.",
      latencyMs,
      tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
    };
  }
}
