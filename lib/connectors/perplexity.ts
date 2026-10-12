/**
 * Perplexity Connector — Perplexity Agent API (`POST /v1/agent`).
 *
 * ConvergePanel's logical panel member `modelId: "perplexity"` is served by the
 * native `perplexity/sonar` model with an explicitly required `web_search` tool
 * (see lib/providers/perplexityAgentResponse.ts for the exact request contract
 * and the pure response parser). The retired Sonar Chat Completions transport
 * (`/chat/completions`) is no longer used.
 *
 * This connector uses the PERPLEXITY_API_KEY environment variable from @/lib/env.
 *
 * IMPORTANT: This connector never throws and will fail visibly (return an error
 * status) if the API key is missing, rather than silently returning a mock
 * response. HTTP 200 is NOT treated as success on its own: the Agent run
 * `status` decides (see `agentOutcome`).
 *
 * Error-message compatibility: HTTP failures keep the exact
 * `Perplexity API error: HTTP <status>[ - <message>]` form that
 * lib/panel.ts retry/fallback classification matches on.
 */

import { ModelResult } from "@/lib/types";
import type { ConnectorCallOptions } from "./types";
import { buildPanelPrompt } from "@/lib/panelPrompt";
import { MODEL_LIMITS, getModelTimeout } from "@/lib/modelConfig";
import { PERPLEXITY_API_KEY } from "@/lib/env";
import { getTotalTokensFromProviderResponse, modelIdToProviderKey, safeNum } from "@/lib/tokenExtraction";
import { logger } from "@/lib/logger";
import {
  PERPLEXITY_AGENT_ENDPOINT,
  agentOutcome,
  buildPerplexityAgentRequestBody,
  parsePerplexityAgentResponse,
} from "@/lib/providers/perplexityAgentResponse";

const TEMPERATURE = 0.2;
const NO_CONTENT_MESSAGE = "Perplexity did not return any content.";

/**
 * Call Perplexity (Agent API).
 *
 * @param question - The user's question (sent as the Agent `input`)
 * @param context - Optional supporting material (used only by the default panel prompt)
 * @param apiKey - Optional API key (for backward compatibility; PERPLEXITY_API_KEY from env is preferred)
 * @param opts - `systemPromptOverride` replaces the default panel prompt (sent as `instructions`)
 * @returns Promise<ModelResult> - Always returns a result, never throws
 */
export async function callPerplexity(
  question: string,
  context?: string | null,
  apiKey?: string,
  opts?: ConnectorCallOptions
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
    logger.debug("[Perplexity connector] Making Agent API call to Perplexity");

    // Token limit and hard timeout from centralized config (single source of truth)
    const perplexityLimits = MODEL_LIMITS.perplexity;
    const perplexityTimeout = getModelTimeout("perplexity");

    const systemContent = opts?.systemPromptOverride
      ? opts.systemPromptOverride
      : buildPanelPrompt("perplexity", sanitizedQuestion, sanitizedContext);

    const requestBody = buildPerplexityAgentRequestBody({
      instructions: systemContent,
      input: sanitizedQuestion,
      maxOutputTokens: perplexityLimits.maxTokens,
      temperature: TEMPERATURE,
    });

    // AbortController distinguishes a client-side timeout (AbortError) from HTTP/JSON errors
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), perplexityTimeout.hardTimeoutMs);

    let response: Response;

    try {
      response = await fetch(PERPLEXITY_AGENT_ENDPOINT, {
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

      // Never throw from here; return a structured error so the UI can render it safely.
      if (!response.ok) {
        const latencyMs = Date.now() - startTime;
        const errorJson = await response.json().catch(() => null);
        logger.error("[Perplexity connector] Perplexity API error", { status: response.status, error: errorJson });

        // Perplexity returns: { error: { message, type, code, param? } }
        const errorMessage =
          `Perplexity API error: HTTP ${response.status}` +
          (errorJson?.error?.message ? ` - ${errorJson.error.message}` : "");

        return {
          modelId: "perplexity",
          status: "error" as const,
          rawText: null,
          errorMessage,
          latencyMs,
        };
      }

      const json = await response.json();
      const latencyMs = Date.now() - startTime;
      const parsed = parsePerplexityAgentResponse(json);
      const outcome = agentOutcome(parsed);

      // Token usage from the Agent `usage` block (input_tokens / output_tokens)
      const providerKey = modelIdToProviderKey("perplexity");
      const tokenUsage = providerKey
        ? getTotalTokensFromProviderResponse(providerKey, json)
        : { totalTokens: 0, promptTokens: null, completionTokens: null };
      const normalizedTokenUsage = {
        totalTokens: safeNum(tokenUsage.totalTokens),
        promptTokens: tokenUsage.promptTokens !== null ? safeNum(tokenUsage.promptTokens) : null,
        completionTokens: tokenUsage.completionTokens !== null ? safeNum(tokenUsage.completionTokens) : null,
      };

      // Provider-reported cost and search usage: diagnostics only (null = not reported; never a fabricated 0)
      logger.info("[Perplexity connector] Agent run", {
        shape: parsed.shape,
        status: parsed.status,
        incompleteReason: parsed.incompleteReason,
        model: parsed.model,
        outcome: outcome.kind,
        latencyMs,
        inputTokens: parsed.usage?.inputTokens ?? null,
        outputTokens: parsed.usage?.outputTokens ?? null,
        totalTokens: parsed.usage?.totalTokens ?? null,
        costTotal: parsed.diagnostics.costTotal,
        costCurrency: parsed.diagnostics.costCurrency,
        toolCallsCost: parsed.diagnostics.toolCallsCost,
        searchInvocations: parsed.diagnostics.searchInvocations,
        searchResultItems: parsed.diagnostics.searchResultItems,
        searchResultEntries: parsed.diagnostics.searchResultEntries,
        messageItems: parsed.diagnostics.messageItems,
      });

      if (outcome.kind === "error") {
        logger.warn("[Perplexity connector] Agent run did not produce a usable answer", { status: parsed.status, shape: parsed.shape });
        return {
          modelId: "perplexity",
          status: "error",
          // Same visible fallback text as before the migration for an empty answer.
          rawText: outcome.errorMessage === NO_CONTENT_MESSAGE ? NO_CONTENT_MESSAGE : null,
          errorMessage: outcome.errorMessage,
          latencyMs,
          tokenUsage: normalizedTokenUsage,
          rawResponse: json, // untouched provider JSON (diagnostics / token extraction)
        };
      }

      const result: ModelResult = {
        modelId: "perplexity",
        status: "ok",
        rawText: outcome.text,
        latencyMs,
        tokenUsage: normalizedTokenUsage, // Always include tokenUsage (never undefined)
        rawResponse: json, // untouched provider JSON (token extraction, diagnostics)
      };

      // finishReason is reconstructed from the Agent status, not from HTTP 200:
      // "stop" = completed run; "length" = incomplete run stopped by max_output_tokens.
      (result as any).finishReason = outcome.finishReason;

      if (outcome.kind === "truncated") {
        logger.warn("[Perplexity connector] Response was truncated by max_output_tokens", {
          responseLength: outcome.text.length,
        });
        (result as any).wasTruncated = true;
        result.errorMessage = "Response was truncated due to token limit. Consider increasing max_tokens for longer responses.";
      }

      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);

      // Explicitly check for AbortError (client-side timeout)
      if (err.name === "AbortError" || controller.signal.aborted) {
        const latencyMs = Date.now() - startTime;
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

      logger.error("[Perplexity connector] Request failed", { error: err?.message });

      // Re-throw to be caught by outer catch block for other error types
      throw new Error(err?.message || "Perplexity request failed. Please try again.");
    }
  } catch (error: any) {
    // Never throw from here; return a structured error so the UI can render it safely.
    const latencyMs = Date.now() - startTime;

    logger.error("[Perplexity connector] Request failed", { error: error?.message });

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
        tokenUsage: zeroTokenUsage,
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
        tokenUsage: zeroTokenUsage,
      };
    }

    return {
      modelId: "perplexity",
      status: "error" as const,
      rawText: null,
      errorMessage,
      latencyMs,
      tokenUsage: zeroTokenUsage,
    };
  }
}
