/**
 * Panel Execution API Route
 * 
 * Handles panel runs with authentication, plan limits, and usage tracking.
 * 
 * Flow:
 * 1. Verify user authentication
 * 2. Validate input (question, selectedModels)
 * 3. Check plan limits (runs/month, models/run) and atomically increment usage
 * 4. Execute panel if limits allow
 * 5. Return results with usage information
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { ModelId, ModelResult, RunPanelApiResponse } from "@/lib/types";
import { runPanel } from "@/lib/panel";
import { splitQuestionAndContext } from "@/lib/questionContext";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY } from "@/lib/env";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { checkAndIncrementUsageForRun } from "@/lib/stripe/usageCheck";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { createRun, completeRun, markRunError } from "@/lib/firestore/runs";
import { incrementUserTokenUsage } from "@/lib/firestore/userTokens";
import { normalizeTokens } from "@/lib/panel/normalizeTokens";
import { sanitizeModelText, truncateForSynthesis, MAX_CHARS_SYNTHESIS_PER_MODEL } from "@/lib/panel/sanitizeText";
import { PanelResultPublic } from "@/lib/panel/schemas";
import { normalizeModelResultPublic, assertPublicStatus } from "@/lib/panel/normalize";
import { logger } from "@/lib/logger";
import { ADAPTIVE_SCHEMAS_ENABLED } from "@/lib/env";
import { planAdaptiveRun, finalizeAdaptiveRun, AdaptivePromptPlan } from "@/lib/adaptiveSchema/orchestrate";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_MODELS = 2; // Minimum number of models required for a panel run

/**
 * API route to run the multi-LLM panel.
 * 
 * Temporary MVP version: ignores user plan / quotas and focuses on running models safely.
 * This route:
 * 1. Validates input (question and selectedModels)
 * 2. Calls the panel orchestration function
 * 3. Returns structured JSON responses (success or error)
 * 
 * All errors are caught and converted to JSON - this route never throws.
 */
export async function POST(req: NextRequest) {
  // Top-level try/catch ensures this route ALWAYS returns JSON, never throws
  // This prevents Next.js from showing error pages and allows the client to handle errors gracefully
  try {
    // ============================================
    // AUTHENTICATION
    // ============================================
    
    // Verify authentication (try session cookie first, then Bearer token)
    // Wrap in try/catch to return 401 instead of 500 for auth failures
    let uid: string;
    try {
      const auth = await verifySessionCookie(req);
      
      if (auth) {
        uid = auth.uid;
      } else {
        // Fallback to Bearer token
        const authHeader = req.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return NextResponse.json(
            {
              ok: false,
              errorCode: "unauthorized",
              message: "Please sign in to run a panel.",
            },
            { status: 401 }
          );
        }
        const token = authHeader.split("Bearer ")[1];
        const decodedToken = await verifyIdToken(token);
        uid = decodedToken.uid;
      }
    } catch (authError: any) {
      // Auth-specific errors should return 401, not 500
      logger.error("[run-panel] Authentication error", {
        error: authError?.message,
        code: authError?.code,
        cause: authError?.cause?.message,
      });
      
      // Check if this is a token verification error (including INVALID_ID_TOKEN)
      const isTokenError = 
        authError?.message === "INVALID_ID_TOKEN" ||
        authError?.message?.includes("ID token") ||
        authError?.message?.includes("aud") ||
        authError?.message?.includes("audience") ||
        authError?.message?.includes("expired") ||
        authError?.code === "auth/argument-error" ||
        authError?.code === "auth/id-token-expired" ||
        authError?.code === "auth/id-token-revoked";
      
      return NextResponse.json(
        {
          ok: false,
          errorCode: isTokenError ? "auth_error" : "unauthorized",
          message: isTokenError 
            ? "Authentication failed. Please sign in again."
            : "Please sign in to run a panel.",
        },
        { status: 401 }
      );
    }

    // ============================================
    // RATE LIMITING (Security Hardening)
    // ============================================
    const { checkRateLimit } = await import("@/lib/security/rateLimit");
    const rateLimitResult = await checkRateLimit({
      maxRequests: 30, // 30 requests per minute per user
      windowSeconds: 60,
      identifier: `run-panel:${uid}`,
    });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "rate_limit_exceeded",
          message: "Too many panel runs. Please wait before trying again.",
          details: {
            retryAfter: rateLimitResult.retryAfter,
            resetAt: rateLimitResult.resetAt.toISOString(),
          },
        },
        { 
          status: 429,
          headers: {
            "Retry-After": String(rateLimitResult.retryAfter || 60),
            "X-RateLimit-Limit": "30",
            "X-RateLimit-Remaining": String(rateLimitResult.remaining),
            "X-RateLimit-Reset": String(Math.floor(rateLimitResult.resetAt.getTime() / 1000)),
          },
        }
      );
    }

    // ============================================
    // INPUT VALIDATION
    // ============================================
    
    // Parse request body - if this fails, it will be caught by the outer try/catch
    let body: any;
    try {
      body = await req.json();
    } catch (parseError: any) {
      // Request body is not valid JSON - return structured error instead of throwing
      const response: RunPanelApiResponse = {
        ok: false,
        errorCode: "invalid_request",
        message: "Invalid request format. Please try again.",
      };
      return NextResponse.json(response, { status: 400 });
    }

    // ============================================
    // REQUEST SIZE VALIDATION (Security Hardening)
    // ============================================
    const { validateRunPanelRequest, validateRequestBodySize, MAX_REQUEST_BODY_SIZE } = await import("@/lib/security/requestValidation");
    try {
      const bodyString = JSON.stringify(body);
      const sizeValidation = validateRequestBodySize(bodyString, MAX_REQUEST_BODY_SIZE);
      if (!sizeValidation.valid) {
        return NextResponse.json(
          {
            ok: false,
            errorCode: "request_too_large",
            message: sizeValidation.message || "Request body is too large",
            details: sizeValidation.details,
          },
          { status: 413 }
        );
      }
    } catch (sizeError: any) {
      // Non-fatal: continue if size check fails
      logger.warn("[run-panel] Could not validate request size", { error: sizeError?.message });
    }

    // Enhanced input validation with size checks
    const inputValidation = validateRunPanelRequest(body);
    if (!inputValidation.valid) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: inputValidation.errorCode || "validation_failed",
          message: inputValidation.message || "Invalid request",
          details: inputValidation.details,
        },
        { status: 400 }
      );
    }
    
    const { question, selectedModels } = body ?? {};

    // Basic input validation: require a non-empty question.
    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "invalid_question",
          message: "Please enter a question before running the panel.",
        },
        { status: 400 }
      );
    }

    // Split textarea input into primary QUESTION and optional CONTEXT.
    // Anything after a line starting with "Context:" is treated as supporting material.
    const { question: parsedQuestion, context } = splitQuestionAndContext(question);
    const trimmedQuestion = parsedQuestion.trim();

    // Validate selected models
    if (!Array.isArray(selectedModels) || selectedModels.length < MIN_MODELS) {
      return NextResponse.json(
        {
          ok: false,
          errorCode: "not_enough_models",
          message: "Select at least two models before running the panel.",
        },
        { status: 400 }
      );
    }

    const requestedModelCount = selectedModels.length;

    // ============================================
    // ADAPTIVE RESULT SCHEMA — CLASSIFICATION (flag-gated, never blocks the run)
    // ============================================
    let adaptivePlan: AdaptivePromptPlan | null = null;
    if (ADAPTIVE_SCHEMAS_ENABLED) {
      try {
        adaptivePlan = await planAdaptiveRun(trimmedQuestion, selectedModels as ModelId[], context);
      } catch (adaptiveError: any) {
        // classifyQuery/buildModelPrompt never throw by contract, but guard defensively:
        // a classification failure must never block the legacy run.
        logger.warn("[run-panel] Adaptive planning failed, continuing with legacy prompt", {
          error: adaptiveError?.message,
        });
        adaptivePlan = null;
      }
    }

    // ============================================
    // SUBSCRIPTION VALIDATION (for paid plans)
    // ============================================
    
    // Validate subscription status with Stripe for paid plans
    // This ensures Firestore stays in sync even if webhooks fail
    // Defensive: if validation fails, log but don't block the user
    try {
      await validateUserSubscription(uid);
    } catch (validationError: any) {
      // Log but don't block - validation is best-effort
      logger.warn("[run-panel] Subscription validation failed (non-blocking)", {
        uid,
        error: validationError?.message,
      });
      // Continue with panel run - existing Firestore data will be used
    }

    // ============================================
    // PLAN LIMIT ENFORCEMENT
    // ============================================
    
    // Check plan limits and atomically increment usage if allowed
    // This function checks both model limit and run limit, and increments usage in a single atomic operation
    const usage = await checkAndIncrementUsageForRun(uid, requestedModelCount);

    if (!usage.allowed) {
      if (usage.reason === "MODEL_LIMIT") {
        // Plan-aware error messages
        let message: string;
        if (usage.maxModelsPerRun === 2) {
          message = "Free tier allows up to 2 models per run. Upgrade to run 3 or 5 models.";
        } else if (usage.maxModelsPerRun === 3) {
          message = "Your plan allows up to 3 models per run. Upgrade to run 5 models.";
        } else {
          message = `Your plan allows up to ${usage.maxModelsPerRun} models per run.`;
        }
        
        return NextResponse.json(
          {
            ok: false,
            errorCode: "PLAN_MODEL_LIMIT_REACHED",
            message,
            maxModelsPerRun: usage.maxModelsPerRun,
          },
          { status: 403 }
        );
      }

      if (usage.reason === "RUN_LIMIT") {
        // Standardized error format for RUN_LIMIT_REACHED
        // Returns 429 (Too Many Requests) for rate/usage cap
        return NextResponse.json(
          {
            ok: false,
            error: "RUN_LIMIT_REACHED",
            errorCode: "RUN_LIMIT_REACHED", // Keep for backward compatibility
            message: "You've reached your monthly run limit.",
            runsUsed: usage.runsThisMonth,
            runsLimit: usage.maxRunsPerMonth,
            resetsAt: usage.resetsAt.toISOString(),
            plan: usage.plan.toUpperCase().replace("-", "_"), // Convert "lite" to "LITE", "full" to "FULL"
          },
          { status: 429 }
        );
      }
    }

    // If we reach here, the run is allowed and runsThisMonth has been atomically incremented.

    // ============================================
    // CREATE RUN RECORD
    // ============================================
    
    // Generate unique run ID
    const runId = `run-${randomUUID()}`;
    
    // Create run document in Firestore (status: "running")
    try {
      await createRun(runId, uid, trimmedQuestion, selectedModels);
    } catch (runError: any) {
      // Log but don't fail - run creation is for tracking, not critical for execution
      logger.error("[run-panel] Failed to create run record", { error: runError });
    }

    // ============================================
    // RUN PANEL
    // ============================================
    
    // Build API keys object from environment variables
    // Import from centralized env module instead of accessing process.env directly
    const apiKeys = {
      chatgpt: OPENAI_API_KEY,
      claude: ANTHROPIC_API_KEY,
      grok: XAI_API_KEY,
      perplexity: PERPLEXITY_API_KEY,
      gemini: GEMINI_API_KEY,
    };

    // Call the existing panel orchestration logic.
    // IMPORTANT: runPanel uses Promise.allSettled, so it should never throw.
    // However, we ensure token finalization ALWAYS runs even if something unexpected happens.
    // runPanel handles per-model errors internally, so partial failures are OK.
    let results: ModelResult[] = [];
    try {
      results = await runPanel(
        trimmedQuestion,
        selectedModels as ModelId[],
        apiKeys,
        context,
        adaptivePlan?.promptOverrides
      );
    } catch (panelError: any) {
      // CRITICAL: Even if runPanel throws (shouldn't happen with Promise.allSettled),
      // we still need to finalize tokens for any results we got before the error
      // Create error results for all selected models that don't have results yet
      logger.error("[run-panel] runPanel threw unexpectedly", { error: panelError });
      
      // If we have no results yet, create error results for all models
      // This ensures completeRun can still process token accounting
      if (!results || results.length === 0) {
        results = selectedModels.map(modelId => ({
          modelId,
          status: "error" as const,
          rawText: null,
          errorMessage: panelError?.message || "Panel execution failed",
          latencyMs: 0,
          tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
        }));
      } else {
        // If we have some results, ensure all selected models are represented
        const resultModelIds = new Set(results.map(r => r.modelId));
        const missingModels = selectedModels.filter(id => !resultModelIds.has(id));
        missingModels.forEach(modelId => {
          results.push({
            modelId,
            status: "error" as const,
            rawText: null,
            errorMessage: panelError?.message || "Panel execution failed",
            latencyMs: 0,
            tokenUsage: { totalTokens: 0, promptTokens: null, completionTokens: null },
          });
        });
      }
      
      // Mark run as error
      try {
        await markRunError(runId, panelError?.message || "Panel execution failed");
      } catch (markError: any) {
        logger.error("[run-panel] Failed to mark run as error", { error: markError });
      }
      
      // DO NOT re-throw - we still want to finalize tokens and return results
      // The outer catch will handle any errors in finalization
    }

    // ============================================
    // SAVE TOKEN USAGE
    // CRITICAL: This block ALWAYS runs, even if runPanel threw
    // ============================================
    
    /**
     * Helper to extract total tokens from a model result robustly
     * Tries multiple extraction methods to handle different provider response formats
     */
    const getTotalTokens = (result: any): number => {
      // Method 1: Use tokenUsage.totalTokens if present
      if (result.tokenUsage?.totalTokens !== undefined && typeof result.tokenUsage.totalTokens === "number") {
        return result.tokenUsage.totalTokens;
      }
      
      // Method 2: Try OpenAI-like format
      if (result.rawResponse?.usage?.total_tokens !== undefined && typeof result.rawResponse.usage.total_tokens === "number") {
        return result.rawResponse.usage.total_tokens;
      }
      
      // Method 3: Try Gemini format
      if (result.rawResponse?.response?.usageMetadata?.totalTokenCount !== undefined && typeof result.rawResponse.response.usageMetadata.totalTokenCount === "number") {
        return result.rawResponse.response.usageMetadata.totalTokenCount;
      }
      
      // Method 4: Try direct usageMetadata (if passed directly)
      if (result.rawResponse?.usageMetadata?.totalTokenCount !== undefined && typeof result.rawResponse.usageMetadata.totalTokenCount === "number") {
        return result.rawResponse.usageMetadata.totalTokenCount;
      }
      
      return 0;
    };
    
    let totalTokens = 0;
    let panelResultsPublic: PanelResultPublic[] = []; // Declare outside try block for response
    let panelGovernanceStatus: "approved" | "needs_review" | "blocked" | undefined;
    try {
      // CRITICAL: Convert results to public format and compute token usage BEFORE calling completeRun
      // This ensures token usage is computed once and passed in (no recomputation in completeRun)
      const computedPanelResultsPublic = results.map((result) => {
      // Determine canonical text - sanitize rawText (this is the FULL text for UI display)
      // CRITICAL: This is the full, untruncated text for UI display - never truncated here
      // We keep fullText (for UI) and synthesisText (truncated for synthesis) separate
      const canonicalText = sanitizeModelText(result.rawText);
      
      // Compute synthesis truncation metadata (for flag only, text is NOT returned)
      // The truncated text is computed separately in synthesize-panel API when needed
      // This flag is just for UI reference/display purposes
      const { wasTruncated: wasTruncatedForSynthesis } = truncateForSynthesis(canonicalText, MAX_CHARS_SYNTHESIS_PER_MODEL);
      
      // Diagnostics: Log text lengths (dev-only, no content)
      // Special diagnostics for Perplexity to track response completeness
      const isDebugMode = process.env.NODE_ENV !== "production" || process.env.DEBUG_LOGS !== "false";
      if (isDebugMode) {
        const logData: any = {
          provider: result.modelId,
          fullTextLength: canonicalText.length,
          synthesisTextLength: wasTruncatedForSynthesis ? MAX_CHARS_SYNTHESIS_PER_MODEL : canonicalText.length,
          wasTruncatedForSynthesis,
          wasStorageCapped: false, // Storage capping happens in completeRun, not here
        };
        
        // For Perplexity: log additional diagnostics
        if (result.modelId === "perplexity") {
          logData.finishReason = (result as any)?.finishReason || null;
          logData.wasTruncatedByAPI = (result as any)?.wasTruncated || false;
          logData.hasAllSections = canonicalText.includes("# Summary") && 
                                    canonicalText.includes("# Key Claims") &&
                                    (canonicalText.includes("# Evidence") || canonicalText.includes("# Evidence and Reasoning")) &&
                                    (canonicalText.includes("# Uncertainties") || canonicalText.includes("# Uncertainties and Disagreements"));
        }
        
        logger.debug(`[run-panel] Text processing for ${result.modelId}`, logData);
      }
        
        // Normalize tokens - pass rawResponse and fallback tokenUsage if available
        const tokenUsageNormalized = normalizeTokens(
          result.modelId,
          result.rawResponse || result,
          result.tokenUsage ? {
            promptTokens: result.tokenUsage.promptTokens ?? undefined,
            completionTokens: result.tokenUsage.completionTokens ?? undefined,
            totalTokens: result.tokenUsage.totalTokens,
          } : undefined
        );
        
        const raw: Record<string, unknown> = {
          modelId: result.modelId,
          status: result.status,
          rawTextFull: canonicalText,
          latencyMs: result.latencyMs,
          tokenUsage: tokenUsageNormalized,
          wasTruncatedForSynthesis,
          wasTruncated: result.wasTruncated || (result as any)?.finishReason === "length",
          requestedModel: result.requestedModel,
          provider: result.provider,
          actualModel: result.actualModel,
          substitutedFrom: result.substitutedFrom,
          substitutionReason: result.substitutionReason,
        };

        if ((result as any)?.finishReason) {
          raw.finishReason = (result as any).finishReason;
        }

        if (result.errorMessage) {
          raw.error = { message: result.errorMessage };
        }

        const publicResult = normalizeModelResultPublic(raw as any) as unknown as PanelResultPublic;
        assertPublicStatus(publicResult.status, `run-panel:${publicResult.modelId}`);
        return publicResult;
      });
      
      // Assign to outer variable for use in response
      panelResultsPublic = computedPanelResultsPublic;

      // Compute token usage for completeRun from normalized results
      // Include substituted results since they contain valid text
      const okResults = computedPanelResultsPublic.filter(r => (r.status === "ok" || r.status === "substituted") && r.tokenUsage);
      const tokenUsageByModel = okResults.map(r => ({
        modelId: r.modelId,
        tokenUsage: r.tokenUsage,
      }));

      const tokenTotals = tokenUsageByModel.reduce(
        (acc, r) => {
          acc.promptTokens += r.tokenUsage.promptTokens || 0;
          acc.completionTokens += r.tokenUsage.completionTokens || 0;
          acc.totalTokens += r.tokenUsage.totalTokens || 0;
          acc.reasoningTokens = (acc.reasoningTokens || 0) + (r.tokenUsage.reasoningTokens || 0);
          return acc;
        },
        { promptTokens: 0, completionTokens: 0, totalTokens: 0, reasoningTokens: 0 as number | undefined }
      );

      // Remove reasoningTokens if 0 for cleanliness
      if (!tokenTotals.reasoningTokens) {
        delete (tokenTotals as any).reasoningTokens;
      }

      // Complete run with pre-computed token usage
      const { totalTokens: runTotalTokens, tokensByProvider } = await completeRun({
        runId,
        userId: uid,
        results,
        question: trimmedQuestion,
        selectedModels,
        tokenUsageByModel,
        tokenTotals,
      });

      // Org governance for research runs runs after synthesis (see /api/synthesize-panel)
      // so consensus score and evidence quality are available.

      // Use tokenTotals.totalTokens (from passed-in data)
      const { safeNum } = await import("@/lib/tokenExtraction");
      totalTokens = safeNum(tokenTotals.totalTokens);
      
      // Final NaN check before Firestore increment
      if (!Number.isFinite(totalTokens) || totalTokens < 0) {
        logger.error(`[run-panel] CRITICAL: totalTokens is invalid for run`, {
          runId,
          totalTokens,
          runTotalTokens,
          tokensByProvider,
          resultsCount: results.length,
        });
        totalTokens = 0; // Set to 0 to prevent NaN in Firestore increment
      }

      // Log token summary (debug level - verbose details)
      logger.debug(`[run-panel] Token extraction complete for run`, {
        runId,
        totalTokens,
        tokensByProvider,
        resultsCount: results.length,
        successfulResults: results.filter(r => r.status === "ok" || r.status === "substituted").length,
        resultsWithTokenUsage: results.filter(r => (r.status === "ok" || r.status === "substituted") && r.tokenUsage).length,
        rawTotalTokens: runTotalTokens,
        tokenBreakdown: results
          .filter(r => (r.status === "ok" || r.status === "substituted") && r.tokenUsage)
          .map(r => ({
            modelId: r.modelId,
            totalTokens: r.tokenUsage?.totalTokens ?? 0,
            promptTokens: r.tokenUsage?.promptTokens,
            completionTokens: r.tokenUsage?.completionTokens,
          })),
      });

      // Increment user's token counter
      // Always call incrementUserTokenUsage, even if totalTokens is 0, to ensure field exists
      // The function handles 0 tokens gracefully (initializes field if missing)
      
      // CRITICAL: Log detailed info before increment, especially when Gemini is included
      const hasGemini = selectedModels.includes("gemini");
      const geminiResult = results.find(r => r.modelId === "gemini");
      const geminiTokens = geminiResult?.tokenUsage?.totalTokens ?? 0;
      
      const succeededResults = results.filter(r => r.status === "ok" || r.status === "substituted");
      const hasSuccessfulModels = succeededResults.length > 0;
      const succeededModelIds = succeededResults.map(r => r.modelId);
      
      // Debug: detailed token increment preparation (verbose logging)
      logger.debug(`[run-panel] About to call incrementUserTokenUsage`, {
        runId,
        totalTokens,
        isFinite: Number.isFinite(totalTokens),
        selectedModels,
        hasGemini: selectedModels.includes("gemini"),
        geminiTokens: results.find(r => r.modelId === "gemini")?.tokenUsage?.totalTokens ?? 0,
        tokensByProvider,
        resultsCount: results.length,
        successfulResults: succeededResults.length,
        tokenBreakdown: results
          .filter(r => r.status === "ok" || r.status === "substituted")
          .map(r => ({
            modelId: r.modelId,
            totalTokens: r.tokenUsage?.totalTokens ?? 0,
            hasTokenUsage: !!r.tokenUsage,
          })),
        willIncrement: hasSuccessfulModels && totalTokens >= 0,
      });
      
      // CRITICAL: Call Firestore increment BEFORE returning the response and await it
      // Only increment if we have at least one successful model
      if (succeededModelIds.length > 0 && totalTokens >= 0) {
        try {
          // Production: log token increment (high-value info)
          logger.info(`[run-panel] Incrementing token usage`, {
            runId,
            totalTokens,
            succeededModels: succeededModelIds.length,
            totalModels: results.length,
          });
          
          const tokenResult = await incrementUserTokenUsage(uid, totalTokens);
          
          // Debug: Verify the update by reading back from Firestore (verbose)
          logger.debug(`[run-panel] Token usage update verified`, {
            runId,
            tokensAdded: totalTokens,
            tokensUsedCurrentPeriod: tokenResult.tokensUsedCurrentPeriod,
            periodStart: tokenResult.periodStart.toISOString(),
            tokensByProvider,
          });
        } catch (incrementError: any) {
          // CRITICAL: Log increment error with full context
          // This error is being caught and not re-thrown, so the increment silently fails
          logger.error(`[run-panel] incrementUserTokenUsage FAILED`, {
            runId,
            error: incrementError?.message,
            totalTokens,
            isFinite: Number.isFinite(totalTokens),
            isNaN: Number.isNaN(totalTokens),
            errorName: incrementError?.name,
            errorCode: incrementError?.code,
          });
          // Don't throw - token tracking is for analytics, not critical for execution
          // But log it prominently so we can debug
          // NOTE: The increment did NOT happen - tokensUsedCurrentPeriod was NOT updated
        }
      } else {
        // No successful models or totalTokens < 0 - log and skip increment
        logger.debug(`[run-panel] Skipping token increment`, {
          runId,
          succeededModelIds: succeededModelIds.length,
          totalTokens,
        });
      }
    } catch (tokenError: any) {
      // Log but don't fail - token tracking is for analytics, not critical for execution
      logger.error("[run-panel] Failed to save token usage", {
        error: tokenError?.message,
        runId,
      });
    }

    // CRITICAL: Convert results to public format (strip rawResponse, normalize tokens)
    // This is the fallback if token tracking failed - still need to return results
    // Only compute if not already computed in try block
    if (panelResultsPublic.length === 0) {
      panelResultsPublic = results.map((result) => {
      // Determine canonical text - sanitize rawText (this is the FULL text for UI display)
      const canonicalText = sanitizeModelText(result.rawText);
      
      // Compute synthesis truncation (for internal use, not returned to client)
      // This is only used if synthesize-panel is called, and it truncates internally
      const { wasTruncated: wasTruncatedForSynthesis } = truncateForSynthesis(canonicalText, MAX_CHARS_SYNTHESIS_PER_MODEL);
      
      // Normalize tokens - pass rawResponse and fallback tokenUsage if available
      const tokenUsageNormalized = normalizeTokens(
        result.modelId,
        result.rawResponse || result,
        result.tokenUsage ? {
          promptTokens: result.tokenUsage.promptTokens ?? undefined,
          completionTokens: result.tokenUsage.completionTokens ?? undefined,
          totalTokens: result.tokenUsage.totalTokens,
        } : undefined
      );
      
      const raw2: Record<string, unknown> = {
        modelId: result.modelId,
        status: result.status,
        rawTextFull: canonicalText,
        latencyMs: result.latencyMs,
        tokenUsage: tokenUsageNormalized,
        wasTruncatedForSynthesis,
        wasTruncated: result.wasTruncated,
        requestedModel: result.requestedModel,
        provider: result.provider,
        actualModel: result.actualModel,
        substitutedFrom: result.substitutedFrom,
        substitutionReason: result.substitutionReason,
      };

      if (result.errorMessage) {
        raw2.error = { message: result.errorMessage };
      }

      const publicResult = normalizeModelResultPublic(raw2 as any) as unknown as PanelResultPublic;
      assertPublicStatus(publicResult.status, `run-panel-fallback:${publicResult.modelId}`);

      // Server-only debug: log compact debug summary if flag is set
      const debugRawResponse = process.env.PANEL_DEBUG_RAW === "true" ||
                                req.headers.get("x-debug-raw") === "1";
      if (debugRawResponse) {
        const rawResponse = result.rawResponse;
        logger.debug(`[run-panel] rawResponse for ${result.modelId}`, {
          modelId: result.modelId,
          usage: rawResponse?.usage || rawResponse?.response?.usageMetadata,
          contentPreview: canonicalText.substring(0, 200),
          fullTextLength: canonicalText.length,
        });
        // Never persist or return rawResponse
      }
      
      return publicResult;
      });
    }

    // On success, return a consistent JSON payload with usage information.
    // CRITICAL: Return public results only (no rawResponse)
    // Normalize results to include both rawTextFull and rawText for backward compatibility
    const normalizedResults = panelResultsPublic.map((r) => {
      const textFull = r.rawTextFull || (r as any).rawText || "";
      return {
        ...r,
        rawTextFull: textFull, // Always include rawTextFull
        rawText: (r as any).rawText || textFull, // Include rawText as alias for backward compatibility
      };
    });

    logger.debug("[run-panel] Public results count", { count: normalizedResults.length });

    // ============================================
    // ADAPTIVE RESULT SCHEMA — VALIDATION + CLAIM ALIGNMENT (flag-gated)
    // ============================================
    let adaptivePayload: {
      classification: AdaptivePromptPlan["classification"];
      schemaId: string;
      results: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["adaptiveResults"];
      alignedClaims?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["alignedClaims"];
      gate?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["gate"];
      synthesisReport?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["synthesisReport"];
      trustSummary?: Awaited<ReturnType<typeof finalizeAdaptiveRun>>["trustSummary"];
    } | null = null;

    if (adaptivePlan) {
      try {
        const adaptiveOutput = await finalizeAdaptiveRun(adaptivePlan.schema, results, trimmedQuestion);
        adaptivePayload = {
          classification: adaptivePlan.classification,
          schemaId: adaptiveOutput.schemaId,
          results: adaptiveOutput.adaptiveResults,
          alignedClaims: adaptiveOutput.alignedClaims,
          gate: adaptiveOutput.gate,
          synthesisReport: adaptiveOutput.synthesisReport,
          trustSummary: adaptiveOutput.trustSummary,
        };
      } catch (adaptiveFinalizeError: any) {
        // Validation/alignment never throw by contract, but guard defensively:
        // a failure here must never take down an otherwise-successful run.
        logger.warn("[run-panel] Adaptive finalize failed, falling back to legacy results only", {
          error: adaptiveFinalizeError?.message,
        });
        adaptivePayload = null;
      }
    }

    return NextResponse.json(
      {
        ok: true,
        results: normalizedResults, // Normalized: includes both rawTextFull and rawText
        runId, // Include runId so client can pass it to synthesis API
        ...(panelGovernanceStatus ? { governanceStatus: panelGovernanceStatus } : {}),
        ...(adaptivePayload ? { adaptive: adaptivePayload } : {}),
        usage: {
          runsThisMonth: usage.runsThisMonth,
          maxRunsPerMonth: usage.maxRunsPerMonth,
          maxModelsPerRun: usage.maxModelsPerRun,
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    // Log the error on the server for debugging.
    logger.error("[/api/run-panel] Unexpected error", {
      error: err?.message,
      stack: err?.stack,
    });

    // Build a safe, generic response for the client
    const baseResponse: any = {
      ok: false,
      errorCode: "internal_error",
      message: "Server error. Please try again. If this keeps happening, contact support.",
    };

    // In development, include extra details to make debugging easier.
    // devDetails should NOT include sensitive data (API keys, tokens, etc.)
    if (process.env.NODE_ENV !== "production") {
      const errorMessage = err?.message || String(err) || "Unknown error";
      const errorStack = err?.stack || "No stack trace available";
      
      baseResponse.devDetails = `${errorMessage}\n\nStack: ${errorStack}`;
      
      // Debug level logging with full error details (dev-only)
      logger.debug("[/api/run-panel] DEV ERROR DETAILS", {
        message: errorMessage,
        stack: errorStack,
      });
    }

    // Always return JSON, never let Next.js send an HTML error page.
    return NextResponse.json(baseResponse, { status: 500 });
  }
}
