import OpenAI from "openai";
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
    modelId: "chatgpt",
    status: "ok",
    rawText: "Mock response from chatgpt (no API key configured)",
    latencyMs: 0,
  };
}

export async function callChatGPT(
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
    const client = new OpenAI({ apiKey });

    // Get token limits and timeout from centralized config
    const chatgptLimits = MODEL_LIMITS.chatgpt;
    const chatgptTimeout = getModelTimeout("chatgpt");
    
    const completion = await Promise.race([
      client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            // Use the shared deep-research template with model-specific length guidance
            content: buildPanelPrompt("chatgpt", sanitizedQuestion, sanitizedContext),
          },
          { role: "user", content: sanitizedQuestion },
        ],
        temperature: 0.7,
        // Use centralized token limits to ensure consistent, deep responses without truncation
        max_tokens: chatgptLimits.maxTokens,
      }),
      createTimeout(chatgptTimeout.hardTimeoutMs),
    ]);

    // Defensive error handling: ensure completion structure is valid
    if (!completion || typeof completion !== "object") {
      throw new Error("ChatGPT API returned invalid response structure");
    }
    
    // Defensive check: ensure choices array exists and has at least one item
    if (!Array.isArray(completion.choices) || completion.choices.length === 0) {
      throw new Error("ChatGPT API returned no choices in response");
    }

    const rawText =
      completion.choices?.[0]?.message?.content?.trim() || null;
    const latencyMs = Date.now() - startTime;

    // Extract token usage from OpenAI response
    // getTotalTokensFromProviderResponse always returns a TokenUsage object (never null)
    const providerKey = modelIdToProviderKey("chatgpt");
    const tokenUsage = providerKey 
      ? getTotalTokensFromProviderResponse(providerKey, completion)
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
        modelId: "chatgpt",
        ok: rawText ? true : false,
        promptTokens: normalizedTokenUsage.promptTokens,
        completionTokens: normalizedTokenUsage.completionTokens,
        totalTokens: normalizedTokenUsage.totalTokens,
      });
    }

    // Log token usage for debugging
    if (normalizedTokenUsage.totalTokens > 0) {
      console.log(`[ChatGPT connector] Token usage:`, normalizedTokenUsage);
    } else if (process.env.NODE_ENV !== "production") {
      console.warn(`[ChatGPT connector] Token usage is 0 or unavailable`);
    }

    // Attach canonical PanelModelId for consistent UI labels and colors.
    return {
      modelId: "chatgpt",
      status: rawText ? "ok" : "error",
      rawText: rawText ?? "ChatGPT did not return any content.",
      latencyMs,
      tokenUsage: normalizedTokenUsage, // Always include tokenUsage (never undefined)
      rawResponse: completion, // Store raw response for token extraction and debugging
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    console.error("ChatGPT API error:", {
      message: error?.message,
      status: error?.status,
      name: error?.name,
    });

    // CRITICAL: All error returns must include tokenUsage with 0 values
    const zeroTokenUsage = { totalTokens: 0, promptTokens: null, completionTokens: null };

    // Handle timeout errors - distinguish from other errors
    // Timeouts occur when the request takes longer than the configured timeout
    // This is common for deep research queries that require comprehensive answers
    if (error?.message === "timeout" || error?.message?.includes("timeout")) {
      const chatgptTimeout = getModelTimeout("chatgpt");
      console.warn("[ChatGPT connector] Request timed out", {
        hardTimeoutMs: chatgptTimeout.hardTimeoutMs,
        latencyMs,
      });
      return {
        modelId: "chatgpt",
        status: "timeout" as const,
        rawText: null,
        errorMessage: `ChatGPT request timed out after ${chatgptTimeout.hardTimeoutMs / 1000} seconds. This request took longer than ${chatgptTimeout.hardTimeoutMs / 1000} seconds and was cancelled to keep the panel responsive.`,
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    if (error?.status === 429 || error?.message?.includes("rate limit")) {
      return {
        modelId: "chatgpt",
        status: "refused",
        rawText: "ChatGPT rate limit exceeded. Please retry shortly.",
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    if (error?.status === 401 || error?.message?.toLowerCase?.().includes("api key")) {
      return {
        modelId: "chatgpt",
        status: "error",
        rawText: "ChatGPT authentication error. Check your API key.",
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
      };
    }

    return {
      modelId: "chatgpt",
      status: "error",
      rawText: "ChatGPT request failed. Please try again.",
      latencyMs,
      tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage
    };
  }
}
