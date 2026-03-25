/**
 * Gemini Connector
 * 
 * Google Gemini connector: calls the Google Generative AI API (Gemini)
 * using the official @google/generative-ai SDK.
 * 
 * Implements function-based connector for Google Gemini.
 * Uses the Gemini 2.5 Flash model (stable) for fast, high-quality responses.
 * 
 * This connector uses the GEMINI_API_KEY environment variable from @/lib/env.
 * The canonical model ID used across the app is "gemini".
 * 
 * IMPORTANT: This connector will fail visibly (return error status) if the API key
 * is missing, rather than silently returning a mock response. This prevents silent
 * failures where Gemini appears selected but never returns results.
 */

import { ModelResult } from "@/lib/types";
import type { ConnectorCallOptions } from "./types";
import { buildPanelPrompt } from "@/lib/panelPrompt";
import { MODEL_LIMITS, getModelTimeout } from "@/lib/modelConfig";
import { getTotalTokensFromProviderResponse, modelIdToProviderKey, safeNum } from "@/lib/tokenExtraction";
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is a rate limit error (429 or quota-related)
 */
function isRateLimitError(error: any): boolean {
  if (error?.status === 429) return true;
  const message = error?.message?.toLowerCase() || "";
  return (
    message.includes("rate limit") ||
    message.includes("resource_exhausted") ||
    message.includes("quota") ||
    message.includes("too many requests")
  );
}

/**
 * Calculate retry delay with exponential backoff and jitter
 * 
 * @param attempt - Current attempt number (0-indexed)
 * @param retryAfterMs - Optional Retry-After header value in milliseconds
 * @returns Delay in milliseconds (capped at 6000ms)
 */
function calculateRetryDelay(attempt: number, retryAfterMs?: number | null): number {
  const baseDelayMs = 800;
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 250; // Random 0-250ms
  const calculatedDelay = exponentialDelay + jitter;
  
  // Use Retry-After header if present, but cap at 6 seconds
  const maxDelay = 6000;
  if (retryAfterMs && retryAfterMs > 0) {
    return Math.min(maxDelay, Math.max(calculatedDelay, retryAfterMs));
  }
  
  return Math.min(maxDelay, calculatedDelay);
}

/**
 * Call Gemini API using the official Google Generative AI SDK
 * 
 * Uses the official @google/generative-ai SDK for reliable API calls.
 * 
 * Retry strategy for rate limits (429):
 * - Max 3 attempts total (initial + 2 retries)
 * - Exponential backoff with jitter: baseDelay * 2^attempt + random(0-250ms)
 * - Max delay capped at 6 seconds
 * 
 * @param question - The user's question to ask Gemini
 * @param context - Optional context material
 * @param apiKey - Optional API key (for backward compatibility, but we use GEMINI_API_KEY from env)
 * @returns Promise<ModelResult> - Always returns a result, never throws
 */
export async function callGemini(
  question: string,
  context?: string | null,
  apiKey?: string,
  opts?: ConnectorCallOptions
): Promise<ModelResult> {
  const sanitizedQuestion = question?.trim() ?? "";
  const sanitizedContext = context?.trim() || null;
  const startTime = Date.now();

  if (process.env.NODE_ENV !== "production" && process.env.FORCE_GEMINI_FAIL === "1") {
    return { modelId: "gemini", status: "error", rawText: null, errorMessage: "Forced failure (dev)", latencyMs: 0 };
  }

  // Early guard: Check for API key from env or parameter
  const envKey = process.env.GEMINI_API_KEY;
  const effectiveApiKey = envKey || apiKey;
  const keyPresent = !!effectiveApiKey && effectiveApiKey.trim().length > 0;
  
  // Defensive logging (dev-only, never log key value)
  const runId = `gemini-${Date.now()}`;
  if (process.env.NODE_ENV !== "production") {
    console.log(`[Gemini connector] API key check:`, {
      runId,
      provider: "gemini",
      keyPresent: Boolean(process.env.GEMINI_API_KEY),
      hasEnvKey: !!envKey,
      hasParamKey: !!apiKey,
    });
  }

  // If no API key, return AUTH error immediately (do not throw)
  if (!keyPresent) {
    const latencyMs = Date.now() - startTime;
    console.error(`[Gemini connector] Missing API key:`, {
      runId,
      provider: "gemini",
      keyPresent: false,
    });
    return {
      modelId: "gemini",
      status: "error",
      rawText: "Gemini API key missing or invalid.",
      errorMessage: "Gemini API key missing or invalid.",
      latencyMs,
      tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage, even on error
      hasUsageMetadata: false, // No usage metadata on error
      wasTruncated: false, // Not truncated on auth error
    };
  }

  // Get token limits and timeout from centralized config
  const geminiLimits = MODEL_LIMITS.gemini;
  const geminiTimeout = getModelTimeout("gemini");
  const maxOutputTokensCap = 32768;
  const effectiveMaxOutput =
    typeof opts?.maxOutputTokens === "number" &&
    Number.isFinite(opts.maxOutputTokens) &&
    opts.maxOutputTokens > 0
      ? Math.min(Math.floor(opts.maxOutputTokens), maxOutputTokensCap)
      : geminiLimits.maxTokens;
  
  let systemInstruction: string;
  let userText: string;

  if (opts?.systemPromptOverride) {
    systemInstruction = opts.systemPromptOverride;
    userText = sanitizedQuestion;
  } else {
    // Build system instruction from the prompt template
    const systemInstructionTemplate = buildPanelPrompt("gemini", "", null);
    const separatorIndex = systemInstructionTemplate.indexOf("\n---\n");
    systemInstruction = separatorIndex > 0
      ? systemInstructionTemplate.substring(0, separatorIndex).trim()
      : systemInstructionTemplate.split("RESEARCH QUESTION:")[0].trim();

    userText =
      sanitizedContext && sanitizedContext.trim().length > 0
        ? `${sanitizedQuestion}\n\nContext:\n${sanitizedContext}`
        : sanitizedQuestion;
  }
  
  // Use stable model: gemini-2.0-flash (avoid experimental suffixes)
  const GEMINI_MODEL = "gemini-2.0-flash";
  
  // Defensive logging (dev-only, no API key value, no full prompt)
  if (process.env.NODE_ENV !== "production") {
    console.log(`[Gemini connector] Request details:`, {
      runId,
      provider: "gemini",
      model: GEMINI_MODEL,
      systemInstructionLength: systemInstruction.length,
      userTextLength: userText.length,
      maxOutputTokens: effectiveMaxOutput,
      keyPresent: true,
    });
  }

  const maxRetries = 2; // Total attempts = 3 (initial + 2 retries)

  // Retry loop for rate limit errors
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (process.env.NODE_ENV !== "production") {
        console.log(`[Gemini connector] Making API call to Gemini... (attempt ${attempt + 1}/${maxRetries + 1})`);
      }

      // Initialize the SDK
      const genAI = new GoogleGenerativeAI(effectiveApiKey);
      
      // Get the model with system instruction
      // systemInstruction can be set at model level or request level
      const model = genAI.getGenerativeModel({ 
        model: GEMINI_MODEL,
        systemInstruction: systemInstruction,
      });

      // Create timeout promise for timeout protection
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), geminiTimeout.hardTimeoutMs);
      });

      // Build requestContents before try block so it's accessible in catch block
      // contents must be an array of { role, parts: [{ text }] }
      const requestContents = [
        {
          role: "user",
          parts: [{ text: userText }],
        },
      ];
      
      // Defensive check: ensure requestContents is valid
      if (!requestContents || !Array.isArray(requestContents) || requestContents.length === 0) {
        const latencyMs = Date.now() - startTime;
          return {
            modelId: "gemini",
            status: "error",
            rawText: "Gemini request failed: invalid contents format.",
            errorMessage: "Invalid request contents format.",
            latencyMs,
            tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage, even on error
            hasUsageMetadata: false, // No usage metadata on error
            wasTruncated: false, // Not truncated on format error
          };
      }

      let result: any;
      try {
        
        // Defensive logging for request shape (dev-only, never log full text)
        if (process.env.NODE_ENV !== "production") {
          console.log(`[Gemini connector] Request shape:`, {
            runId,
            provider: "gemini",
            contentsType: typeof requestContents,
            isContentsArray: Array.isArray(requestContents),
            contentsLength: requestContents.length,
            hasSystemInstruction: !!systemInstruction,
            systemInstructionLength: systemInstruction.length,
          });
        }
        
        // Official SDK pattern: generateContent accepts a single object with contents and generationConfig
        // systemInstruction is set at model level (in getGenerativeModel call above)
        // Format: generateContent({ contents: [...], generationConfig: {...} })
        const generatePromise = model.generateContent({
          contents: requestContents,
          generationConfig: {
            maxOutputTokens: effectiveMaxOutput,
            temperature: 0.7,
          },
        });

        result = await Promise.race([generatePromise, timeoutPromise]);
      } catch (fetchError: any) {
        // Handle 400 Bad Request errors (invalid contents format)
        if (fetchError?.status === 400 || fetchError?.message?.includes("Invalid value at 'contents'")) {
          const latencyMs = Date.now() - startTime;
          // Log request shape for debugging (dev-only, never log full text)
          if (process.env.NODE_ENV !== "production") {
            console.error(`[Gemini connector] 400 Bad Request - Invalid contents:`, {
              runId,
              provider: "gemini",
              errorMessage: fetchError?.message,
              requestShape: {
                contentsType: typeof requestContents,
                isContentsArray: Array.isArray(requestContents),
                contentsLength: requestContents.length,
                firstItemRole: requestContents[0]?.role,
                firstItemPartsType: typeof requestContents[0]?.parts,
                isPartsArray: Array.isArray(requestContents[0]?.parts),
              },
            });
          }
          return {
            modelId: "gemini",
            status: "error",
            rawText: "Gemini API returned invalid request format. The panel ran with the other models.",
            errorMessage: "Gemini API returned 400 Bad Request: Invalid contents format.",
            latencyMs,
            tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage, even on error
            hasUsageMetadata: false, // No usage metadata on error
            wasTruncated: false, // Not truncated on 400 error
          };
        }
        
        // Handle timeout errors
        if (fetchError?.message === "timeout") {
          const latencyMs = Date.now() - startTime;
          if (process.env.NODE_ENV !== "production") {
            console.warn("[Gemini connector] Request timed out", {
              runId,
              provider: "gemini",
              hardTimeoutMs: geminiTimeout.hardTimeoutMs,
              latencyMs,
            });
          }
          return {
            modelId: "gemini",
            status: "timeout" as const,
            rawText: null,
            errorMessage: `Gemini request timed out after ${geminiTimeout.hardTimeoutMs / 1000} seconds. This request took longer than ${geminiTimeout.hardTimeoutMs / 1000} seconds and was cancelled to keep the panel responsive.`,
            latencyMs,
            tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage, even on error
            hasUsageMetadata: false, // No usage metadata on timeout
            wasTruncated: false, // Not truncated on timeout
          };
        }
        throw fetchError;
      }

      // Get response from result
      const response = result.response;
      
      // Extract text safely: response.text() is a method that returns a Promise<string>
      let text: string;
      try {
        // The SDK's response.text() returns a Promise<string>
        text = await response.text();
        text = text.trim();
      } catch (textError: any) {
        // If text() fails, try to extract from candidates directly
        const candidates = response.candidates;
        if (candidates && Array.isArray(candidates) && candidates.length > 0) {
          const parts = candidates[0]?.content?.parts || [];
          const textParts = parts
            .map((part: any) => part?.text)
            .filter((t: any) => t && typeof t === "string");
          text = textParts.join("").trim();
        } else {
          text = "";
        }
      }
      
      // Defensive logging for response
      if (process.env.NODE_ENV !== "production") {
        console.log(`[Gemini connector] Response received:`, {
          runId,
          provider: "gemini",
          textLength: text.length,
          hasText: text.length > 0,
        });
      }

      // Extract finish reason to detect truncation and safety issues
      const finishReason = response.candidates?.[0]?.finishReason;
      const safetyRatings = response.candidates?.[0]?.safetyRatings;
      
      // Check if response was truncated due to max output tokens
      // Gemini uses "MAX_OUTPUT_TOKENS" as finish reason when hitting the limit
      const wasTruncated = finishReason === "MAX_OUTPUT_TOKENS";
      
      // If empty, return provider error (do not silently return empty string)
      if (!text || text.length === 0) {
        const latencyMs = Date.now() - startTime;
        
        if (process.env.NODE_ENV !== "production") {
          console.error(`[Gemini connector] Empty response:`, {
            runId,
            provider: "gemini",
            finishReason,
            hasSafetyRatings: !!safetyRatings,
          });
        }
        
        // Safety refusal -> REFUSED only when explicitly indicated
        if (finishReason === "SAFETY") {
          return {
            modelId: "gemini",
            status: "refused",
            rawText: "Gemini filtered the response due to safety concerns. The panel ran with the other models.",
            errorMessage: "Gemini filtered the response due to safety concerns.",
            latencyMs,
            tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage
            hasUsageMetadata: false, // No usage metadata on refusal
            wasTruncated: false, // Not truncated if empty due to safety
          };
        }
        
        return {
          modelId: "gemini",
          status: "error",
          rawText: "Gemini returned an empty response. The panel ran with the other models.",
          errorMessage: finishReason === "RECITATION"
            ? "Gemini filtered the response due to recitation concerns."
            : "Gemini returned an empty response.",
          latencyMs,
          tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage, even on error
          hasUsageMetadata: false, // No usage metadata on error
          wasTruncated: false, // Not truncated if empty
        };
      }

      const latencyMs = Date.now() - startTime;
      
      // Defensive logging for successful responses
      if (process.env.NODE_ENV !== "production") {
        console.log(`[Gemini connector] Success:`, {
          runId,
          provider: "gemini",
          responseLength: text.length,
          finishReason,
          wasTruncated,
          maxOutputTokens: effectiveMaxOutput,
        });
      }
      
      // Log truncation detection (always log, not just dev)
      if (wasTruncated) {
        console.warn(`[Gemini connector] Response truncated due to max output tokens:`, {
          runId,
          provider: "gemini",
          responseLength: text.length,
          finishReason,
          maxOutputTokens: effectiveMaxOutput,
          suggestion: "Consider increasing GEMINI_MAX_OUTPUT_TOKENS env var or maxTokens in modelConfig",
        });
      }

      // Extract token usage from response
      // CRITICAL: Wrap token extraction in try/catch to ensure it never throws
      // This prevents Gemini token extraction failures from crashing the entire run
      let hasUsageMetadata = false;
      let normalizedTokenUsage = {
        totalTokens: 0,
        promptTokens: null as number | null,
        completionTokens: null as number | null,
      };
      
      try {
        // The SDK response structure: result.response.usageMetadata
        // CRITICAL: Check if usageMetadata exists for debugging/audit purposes
        hasUsageMetadata = !!(result?.response?.usageMetadata && typeof result.response.usageMetadata === "object");
        
        // Extract token usage from Gemini response
        // getTotalTokensFromProviderResponse always returns a TokenUsage object (never null)
        const providerKey = modelIdToProviderKey("gemini");
        const tokenUsage = (providerKey && result?.response)
          ? getTotalTokensFromProviderResponse(providerKey, result.response)
          : { totalTokens: 0, promptTokens: null, completionTokens: null };

        // CRITICAL: Ensure tokenUsage has numeric defaults using safeNum
        // Always return numbers (never undefined/null for totalTokens)
        // If usageMetadata is missing, all values will be 0
        normalizedTokenUsage = {
          totalTokens: safeNum(tokenUsage.totalTokens), // Always a number (0 if missing)
          promptTokens: tokenUsage.promptTokens !== null ? safeNum(tokenUsage.promptTokens) : null,
          completionTokens: tokenUsage.completionTokens !== null ? safeNum(tokenUsage.completionTokens) : null,
        };
      } catch (tokenError: any) {
        // CRITICAL: Never let token extraction throw - log and use defaults
        console.error(`[Gemini connector] Token extraction failed for run ${runId}:`, {
          error: tokenError?.message,
          stack: tokenError?.stack,
        });
        // Use defaults (all zeros) - token extraction failure should not prevent run completion
        hasUsageMetadata = false;
        normalizedTokenUsage = {
          totalTokens: 0,
          promptTokens: null,
          completionTokens: null,
        };
      }

      // Dev-only instrumentation: log token usage per model
      const isDebugMode = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_DEBUG_TOKENS === "true";
      if (isDebugMode) {
        console.log(`[TOKENS:model]`, {
          modelId: "gemini",
          ok: true,
          promptTokens: normalizedTokenUsage.promptTokens,
          completionTokens: normalizedTokenUsage.completionTokens,
          totalTokens: normalizedTokenUsage.totalTokens,
          hasUsageMetadata, // Debug flag to track if Gemini provided usageMetadata
        });
      }

      // Log token usage for debugging
      if (process.env.NODE_ENV !== "production") {
        if (normalizedTokenUsage.totalTokens > 0) {
          console.log(`[Gemini connector] Token usage extracted:`, {
            runId,
            provider: "gemini",
            totalTokens: normalizedTokenUsage.totalTokens,
            promptTokens: normalizedTokenUsage.promptTokens,
            completionTokens: normalizedTokenUsage.completionTokens,
          });
        } else {
          console.warn(`[Gemini connector] Token usage is 0 or unavailable:`, {
            runId,
            provider: "gemini",
            hasResponse: !!result,
            hasResponseResponse: !!result?.response,
            hasUsageMetadata: !!result?.response?.usageMetadata,
            usageMetadataKeys: result?.response?.usageMetadata ? Object.keys(result.response.usageMetadata) : [],
            responseKeys: result?.response ? Object.keys(result.response) : [],
            tokenUsage: normalizedTokenUsage,
          });
        }
      }

      return {
        modelId: "gemini",
        status: "ok",
        rawText: text,
        latencyMs,
        tokenUsage: normalizedTokenUsage, // Always include tokenUsage (never undefined)
        rawResponse: result, // Store raw response for token extraction and debugging
        hasUsageMetadata, // Persist flag for debugging/audit
        wasTruncated, // Flag indicating if response hit max output tokens
      };
    } catch (error: any) {
      // Handle SDK errors
      const isRateLimit = isRateLimitError(error);
      
      // If rate limit and we have retries left, wait and retry
      if (isRateLimit && attempt < maxRetries) {
        const delayMs = calculateRetryDelay(attempt, null);
        if (process.env.NODE_ENV !== "production") {
          console.log(`[Gemini connector] Rate limit error caught. Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries + 1})`, {
            runId,
            provider: "gemini",
          });
        }
        await sleep(delayMs);
        continue; // Retry the request
      }

      const latencyMs = Date.now() - startTime;
      
      if (process.env.NODE_ENV !== "production") {
        console.error("[Gemini connector] API error:", {
          runId,
          provider: "gemini",
          message: error?.message,
          status: error?.status,
          name: error?.name,
          attempt: attempt + 1,
        });
      }

      // CRITICAL: All error returns must include tokenUsage with 0 values
      // This ensures aggregation never fails due to missing tokenUsage
      const zeroTokenUsage = {
        totalTokens: 0,
        promptTokens: null,
        completionTokens: null,
      };

      // Handle timeout errors
      if (error?.message === "timeout" || error?.message?.includes("timeout") || error?.name === "AbortError") {
        const geminiTimeout = getModelTimeout("gemini");
        if (process.env.NODE_ENV !== "production") {
          console.warn("[Gemini connector] Request timed out", {
            runId,
            provider: "gemini",
            hardTimeoutMs: geminiTimeout.hardTimeoutMs,
            latencyMs,
          });
        }
        return {
          modelId: "gemini",
          status: "timeout" as const,
          rawText: null,
          errorMessage: `Gemini request timed out after ${geminiTimeout.hardTimeoutMs / 1000} seconds. This request took longer than ${geminiTimeout.hardTimeoutMs / 1000} seconds and was cancelled to keep the panel responsive.`,
          latencyMs,
          tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage, even on error
          hasUsageMetadata: false, // No usage metadata on timeout
          wasTruncated: false, // Not truncated on timeout
        };
      }

      // 401/403 -> AUTH_ERROR (not rate limit)
      if (error?.status === 401 || error?.status === 403 || error?.message?.toLowerCase?.().includes("api key")) {
        if (process.env.NODE_ENV !== "production") {
          console.error(`[Gemini connector] Authentication error:`, {
            runId,
            provider: "gemini",
            errorStatus: error?.status,
            errorMessage: error?.message,
            keyPresent: true, // Key was present but invalid
          });
        }
        return {
          modelId: "gemini",
          status: "error",
          rawText: "Gemini API key missing or invalid.",
          errorMessage: "Gemini API key missing or invalid.",
          latencyMs,
          tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage, even on error
          hasUsageMetadata: false, // No usage metadata on auth error
          wasTruncated: false, // Not truncated on auth error
        };
      }

      // 429 or RESOURCE_EXHAUSTED -> RATE_LIMIT (status: "error", not "refused")
      // UI status chip should NOT show "REFUSED" for rate limit errors
      if (isRateLimit) {
        if (process.env.NODE_ENV !== "production") {
          console.error(`[Gemini connector] Rate limit exhausted:`, {
            runId,
            provider: "gemini",
            errorStatus: error?.status,
            attempts: maxRetries + 1,
          });
        }
        return {
          modelId: "gemini",
          status: "error", // Use "error" for rate limits (not "refused")
          rawText: "Gemini is temporarily rate-limited. The panel ran with the other models.",
          errorMessage: "Gemini rate limit exceeded. Please retry shortly.",
          latencyMs,
          tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage, even on error
          hasUsageMetadata: false, // No usage metadata on rate limit
          wasTruncated: false, // Not truncated on rate limit
        };
      }

      // Other errors -> PROVIDER_ERROR
      return {
        modelId: "gemini",
        status: "error",
        rawText: "Gemini request failed. Please try again.",
        errorMessage: error?.message || "Unknown error",
        latencyMs,
        tokenUsage: zeroTokenUsage, // CRITICAL: Always include tokenUsage, even on error
        hasUsageMetadata: false, // No usage metadata on error
        wasTruncated: false, // Not truncated on provider error
      };
    }
  }

  // This should never be reached, but TypeScript requires it
  return {
    modelId: "gemini",
    status: "error",
    rawText: "Gemini request failed after all retries.",
    errorMessage: "Unexpected error in retry loop",
    latencyMs: Date.now() - startTime,
    tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null }, // CRITICAL: Always include tokenUsage
    hasUsageMetadata: false, // No usage metadata on error
    wasTruncated: false, // Not truncated on retry loop error
  };
}
