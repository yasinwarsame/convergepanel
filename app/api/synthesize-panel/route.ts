/**
 * Panel Synthesis API Route
 * 
 * Generates a unified synthesis report using GPT-5.1 with cluster-based input.
 * Uses compact cluster data instead of full raw text for faster, more reliable synthesis.
 * Returns strict JSON matching StructuredSynthesis schema.
 * 
 * Request:
 *   POST /api/synthesize-panel
 *   Body: {
 *     runId: string,
 *     question: string,
 *     results: Array<{ modelId: string, text: string }>,
 *     agreementClusters?: Array<...>,  // Optional: cluster data for compact input
 *   }
 * 
 * Response (success):
 *   {
 *     ok: true,
 *     report: StructuredSynthesis,
 *     schemaVersion: 1,
 *     synthesizedBy: "gpt-5.1",
 *     cached?: boolean  // true if returned from Firestore cache
 *   }
 * 
 * Response (error):
 *   {
 *     errorCode: string,     // e.g., "BAD_REQUEST", "NO_CONTENT", "TIMEOUT"
 *     message: string,        // User-friendly error message
 *     requestId: string,      // Unique request ID for correlation
 *     details?: any          // Optional structured details
 *   }
 * 
 * Error Codes:
 *   - BAD_REQUEST (400): Invalid request body (missing runId, question, or results)
 *   - UNAUTHORIZED (401): Not authenticated
 *   - NO_CONTENT (502): OpenAI returned no usable content
 *   - TIMEOUT (504): Request timed out (server-side 5-minute limit)
 *   - CLIENT_ABORT (499): Client cancelled the request
 *   - VALIDATION_FAILED (500): Generated report failed schema validation
 *   - INTERNAL_ERROR (500): Unexpected server error
 * 
 * Caching:
 *   - Checks Firestore runs/{runId}.synthesizedStructuredReport before generating
 *   - Stores generated report in Firestore for future requests
 *   - Cache key: runId + schemaVersion (currently v1)
 * 
 * Timeout:
 *   - Server-side: 300 seconds (5 minutes) - configured via maxDuration
 *   - Client should use 300000ms (5 minutes) timeout to match
 *   - LLM call may be slower for large inputs - retry logic handles partial responses
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { OPENAI_API_KEY, ANTHROPIC_API_KEY } from "@/lib/env";
import { StructuredSynthesisSchema, StructuredSynthesis } from "@/lib/synthesis/structuredSchema";
import { buildSynthesisInput } from "@/lib/synthesis/buildSynthesisInput";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import { generateRequestId, getRequestId } from "@/lib/utils/requestId";
import { createErrorResponse, ERROR_CODES } from "@/lib/api/errorResponse";
import { extractOpenAIText, isPartialResponse } from "@/lib/openai/extractResponse";
import { extractModelText } from "@/lib/openai/extractModelText";
import { getTokenParams } from "@/lib/openai/tokenParams";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { checkRateLimit } from "@/lib/security/rateLimit";
import { validateSynthesisRequest, validateRequestBodySize, MAX_REQUEST_BODY_SIZE } from "@/lib/security/requestValidation";
import { sanitizeModelText, truncateForSynthesis, MAX_CHARS_SYNTHESIS_PER_MODEL } from "@/lib/panel/sanitizeText";
import { compressModelResponse, compressClusters, computeInputHash } from "@/lib/synthesis/compressInput";
import { buildEvidencePack } from "@/lib/synthesis/buildEvidencePack";
import { logger, redact } from "@/lib/logger";

// Configure runtime and max duration for Next.js API route
export const runtime = "nodejs";
// Timeout: 5 minutes (300 seconds) for GPT-5.1 synthesis
// This is sufficient for most synthesis requests. If synthesis consistently times out,
// consider: 1) reducing input size, 2) using more compact cluster data, 3) increasing token limits
export const maxDuration = 300;

// Server-side singleflight deduplication: prevent concurrent synthesis requests for the same runId
// This avoids duplicate expensive LLM calls when multiple clients request synthesis simultaneously
const inFlightSynthesis = new Map<string, Promise<NextResponse>>();

// Performance limits for prompt optimization
// ADJUSTMENT GUIDE (for tuning synthesis speed vs quality):
// - MAX_TOTAL_PROMPT_CHARS: Increase to 80k-100k for longer panels (increases latency, may hit token limits)
//   Current: 60k chars ensures typical synthesis completes in 3-8s after warm cache
// - MAX_CHARS_PER_MODEL_SUMMARY: Increase to 2000-3000 for more detailed summaries (increases prompt size)
//   Current: 1200 chars per model (sufficient for synthesis, reduces LLM processing time)
// - MAX_CLAIMS_PER_MODEL: Increase to 20-30 for more comprehensive claim extraction (increases prompt size)
//   Current: 12 claims per model (balances completeness with speed)
// - MAX_TOP_CLUSTERS: Increase to 50 for larger panels (increases prompt size, may slow LLM processing)
//   Current: 10 clusters (evidence pack uses 30 max, this is for fallback path)
// - Evidence pack limits: max 30 clusters OR 15k chars (adjust in buildEvidencePack call if needed)
// All caps are designed to keep typical synthesis under 15s worst-case; increase caps cautiously as they directly impact LLM latency
const MAX_TOTAL_PROMPT_CHARS = 60000; // 60k chars hard cap
const MAX_CHARS_PER_MODEL_SUMMARY = 1200; // Per-model summary limit
const MAX_CLAIMS_PER_MODEL = 12; // Max claims extracted per model
const MAX_TOP_CLUSTERS = 10; // Top N clusters to keep

/**
 * Deduplicate synthesis requests by runId
 * If a request is already in progress for a runId, return the existing promise
 */
function getOrCreateSynthesisPromise(
  runId: string,
  createFn: () => Promise<NextResponse>
): Promise<NextResponse> {
  const existing = inFlightSynthesis.get(runId);
  if (existing) {
    logger.debug(`[synthesize-panel] Deduplicating request for runId: ${runId}`, { runId });
    return existing;
  }
  
  const promise = createFn().finally(() => {
    // Clean up after completion (success or failure)
    inFlightSynthesis.delete(runId);
  });
  
  inFlightSynthesis.set(runId, promise);
  return promise;
}

const SYNTHESIS_PROMPT = `You are a research synthesis expert. You will receive cluster-based analysis data from multiple AI models responding to the same research question. Your task is to produce a structured JSON synthesis report that synthesizes insights from all models.

CRITICAL RULES:
- Use the real model IDs (e.g., "chatgpt", "claude", "grok", "perplexity", "gemini") in your output
- Reference models by their actual IDs when attributing claims or insights
- Focus on synthesizing the content and ideas from all models
- Identify areas of consensus and disagreement across the models
- Output MUST be valid JSON only - no HTML tags, no markdown headings, no text outside the JSON object

OUTPUT FORMAT - STRICT JSON ONLY:
You MUST output valid JSON that matches this exact schema. Do NOT output HTML tags, markdown headings, or any text outside the JSON object.

{
  "executiveSummary": "A 2-5 paragraph executive summary integrating key insights from all models. Use plain text (no HTML tags, no markdown headings). Address the main answer to the research question, overall confidence level, and major areas of agreement or disagreement.",
  "keyFindings": [
    {
      "claim": "Specific claim or finding where multiple models agree",
      "confidence": "High" | "Medium" | "Low" | "Mixed",
      "evidenceRefs": ["Optional: Supporting evidence references"],
      "modelsSupporting": ["chatgpt", "claude"] // Array of model IDs
    }
  ],
  "disagreements": [
    {
      "topic": "Short label for the contested point",
      "positionsByModel": {
        "chatgpt": "What ChatGPT says about the topic",
        "claude": "What Claude says (different perspective)"
      },
      "whyTheyDiffer": "1-2 sentence explanation of why this is contested and what differs"
    }
  ],
  "biasAndBlindSpots": [
    {
      "biasType": "Short label for the bias type (e.g., 'Western-centric framing', 'Institutional status quo bias')",
      "description": "Plain-language explanation of the bias/blind spot and how it may affect conclusions",
      "modelsImplicated": ["gemini", "perplexity"],
      "evidence": [
        {
          "modelId": "gemini",
          "excerpt": "Direct quote from model response (max 240 chars, remove newlines)",
          "rationale": "Why this excerpt suggests the bias - what patterns or indicators are present"
        }
      ],
      "likelyCauses": [
        "Plausible reason 1 (e.g., 'training data skew toward Western media')",
        "Plausible reason 2"
      ],
      "impact": "How this bias could distort conclusions or what perspectives get overlooked",
      "mitigationSteps": [
        "Practical step 1 (e.g., 'add counter-sources from non-Western perspectives')",
        "Practical step 2 (e.g., 'ask follow-up questions explicitly about alternative viewpoints')"
      ]
    }
  ],
  "openQuestions": [
    "Open question 1 that remains unanswered",
    "Open question 2 that needs further investigation"
  ],
  "methodology": "Brief description of the synthesis approach (1-2 sentences). Explain: multi-model panel, cluster agreement/disagreement analysis, confidence assessment, etc."
}

HARD REQUIREMENTS:
- Output MUST be valid JSON (no HTML tags, no markdown headings)
- Output MUST start with { and end with }
- executiveSummary: 2-5 paragraphs, plain text only (no HTML, no markdown)
- keyFindings: 3-7 top items only, ranked by confidence (highest first), deduplicated
- disagreements: 2-6 top items only, each must have at least 2 positions in positionsByModel
- biasAndBlindSpots: 0-6 items maximum, be cautious and evidence-based
  - Only attribute a bias to a model if there is a concrete indicator in that model's response
  - Provide direct excerpts (max 240 chars, remove newlines) as evidence from each implicated model
  - Use cautious language: "likely", "suggests", "may indicate" rather than definitive claims
  - Include plausible likelyCauses and actionable mitigationSteps
  - If uncertain, do not attribute; instead list as 'open question' or 'possible blind spot across models'
- openQuestions: 2-5 questions maximum
- Do NOT duplicate content across sections
- Be specific and concrete, not vague
- Maintain academic rigor while being accessible
- Do not invent or extrapolate beyond what the cluster data provides`;

/**
 * Claude fallback for synthesis generation.
 * Called when the primary OpenAI call fails. Uses the same prompt and
 * returns the raw text response for downstream JSON parsing/validation.
 */
const CLAUDE_SYNTHESIS_MODEL = "claude-sonnet-4-20250514";

async function callClaudeFallback(
  fullPrompt: string,
  requestId: string,
  signal?: AbortSignal,
): Promise<{ text: string | null; model: string }> {
  if (!ANTHROPIC_API_KEY) {
    logger.warn(`[${requestId}] [synthesize-panel] Claude fallback skipped: no ANTHROPIC_API_KEY`, { requestId });
    return { text: null, model: CLAUDE_SYNTHESIS_MODEL };
  }

  logger.info(`[${requestId}] [synthesize-panel] Attempting Claude fallback synthesis`, { requestId, model: CLAUDE_SYNTHESIS_MODEL });
  const fallbackStart = Date.now();

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const message = await anthropic.messages.create({
    model: CLAUDE_SYNTHESIS_MODEL,
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content: fullPrompt,
      },
    ],
    system: "You are a research synthesis expert. You MUST output valid JSON only, no HTML tags, no markdown headings. Your response must be a valid JSON object matching the provided schema. Start your response IMMEDIATELY with { - do not include any preamble, explanation, or reasoning before the JSON object.",
    temperature: 0.3,
  });

  const textBlock = message.content.find((b) => b.type === "text");
  const text = textBlock?.text ?? null;

  logger.info(`[${requestId}] [synthesize-panel] Claude fallback completed`, {
    requestId,
    model: CLAUDE_SYNTHESIS_MODEL,
    elapsed: Date.now() - fallbackStart,
    hasContent: !!text,
    contentLength: text?.length ?? 0,
    stopReason: message.stop_reason,
  });

  return { text, model: CLAUDE_SYNTHESIS_MODEL };
}

/**
 * GET /api/synthesize-panel?runId=...&mode=cache
 * 
 * Cache-first endpoint: returns cached synthesis if available, otherwise 404.
 * Used by UI to check cache before generating.
 */
export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const requestId = getRequestId(req);
  const searchParams = req.nextUrl.searchParams;
  const runId = searchParams.get("runId");
  
  if (!runId) {
    return NextResponse.json(
      createErrorResponse(
        ERROR_CODES.BAD_REQUEST,
        "runId query parameter is required",
        requestId
      ),
      { status: 400 }
    );
  }

  // Authenticate user (same as POST)
  let uid: string;
  try {
    const auth = await verifySessionCookie(req);
    if (auth) {
      uid = auth.uid;
    } else {
      const authHeader = req.headers.get("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return NextResponse.json(
          createErrorResponse(
            ERROR_CODES.UNAUTHORIZED,
            "Please sign in to view synthesis reports.",
            requestId
          ),
          { status: 401 }
        );
      }
      const token = authHeader.split("Bearer ")[1];
      const decodedToken = await verifyIdToken(token);
      uid = decodedToken.uid;
    }
  } catch (authError: any) {
    return NextResponse.json(
      createErrorResponse(
        ERROR_CODES.UNAUTHORIZED,
        "Authentication failed. Please sign in again.",
        requestId
      ),
      { status: 401 }
    );
  }

  // Verify ownership
  if (adminDb) {
    try {
      const runDoc = await adminDb.collection("runs").doc(runId).get();
      if (runDoc.exists) {
        const runData = runDoc.data();
        const runUserId = runData?.userId;
        if (runUserId !== undefined && runUserId !== uid) {
          return NextResponse.json(
            createErrorResponse(
              ERROR_CODES.FORBIDDEN,
              "You don't have access to this run.",
              requestId
            ),
            { status: 403 }
          );
        }
      }
    } catch (ownershipError: any) {
      // Continue - ownership check is best effort
    }
  }

  // Check cache
  if (adminDb) {
    try {
      const runDoc = await adminDb.collection("runs").doc(runId).get();
      if (runDoc.exists) {
        const data = runDoc.data();
        if (data?.synthesizedStructuredReport && data?.schemaVersion === 1) {
          logger.info(`[${requestId}] [synthesize-panel GET] Cache hit`, {
            elapsed: Date.now() - startTime,
            runId,
            requestId,
          });
          return NextResponse.json({
            ok: true,
            report: data.synthesizedStructuredReport,
            schemaVersion: 1,
            synthesizedBy: data.synthesizedBy || "gpt-5.1",
            cached: true,
          });
        }
      }
    } catch (cacheError: any) {
      logger.warn(`[${requestId}] [synthesize-panel GET] Cache check failed`, { 
        requestId,
        error: cacheError?.message 
      });
    }
  }

  // Cache miss - return 404 so client can generate
  return NextResponse.json(
    createErrorResponse(
      "NOT_FOUND",
      "No cached synthesis found for this run.",
      requestId
    ),
    { status: 404 }
  );
}

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  // Generate request ID for tracing (used in all logs and error responses)
  const requestId = getRequestId(req);
  
  logger.debug(`[${requestId}] [synthesize-panel] Handler entry`, { requestId });
  
  // Check if client has already aborted
  if (req.signal?.aborted) {
    logger.warn(`[${requestId}] [synthesize-panel] Request already aborted by client`, {
      requestId,
      elapsed: Date.now() - startTime,
    });
    return NextResponse.json(
      createErrorResponse(
        ERROR_CODES.CLIENT_ABORT,
        "Request cancelled by client",
        requestId
      ),
      { status: 499 }
    );
  }

  // ============================================
  // AUTHENTICATION (Standardized with run-panel)
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
        // Diagnostics for 401: log what auth methods were attempted
        const hasSessionCookie = !!req.cookies.get("__session")?.value;
        const hasAuthHeader = !!authHeader;
        logger.warn(`[${requestId}] [synthesize-panel] Authentication failed - no valid credentials`, {
          requestId,
          hasSessionCookie,
          hasAuthHeader,
          authHeaderPrefix: authHeader ? authHeader.substring(0, 10) : null,
        });
        
        return NextResponse.json(
          createErrorResponse(
            ERROR_CODES.UNAUTHORIZED,
            "Please sign in to generate synthesis reports.",
            requestId
          ),
          { status: 401 }
        );
      }
      const token = authHeader.split("Bearer ")[1];
      const decodedToken = await verifyIdToken(token);
      uid = decodedToken.uid;
    }
  } catch (authError: any) {
    // Auth-specific errors should return 401, not 500
    // Diagnostics for 401: log what auth methods were attempted
    const hasSessionCookie = !!req.cookies.get("__session")?.value;
    const authHeader = req.headers.get("authorization");
    const hasAuthHeader = !!authHeader?.startsWith("Bearer ");
    
    logger.error(`[${requestId}] [synthesize-panel] Authentication error`, {
      requestId,
      error: authError?.message,
      code: authError?.code,
      cause: authError?.cause?.message,
      hasSessionCookie,
      hasAuthHeader,
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
      createErrorResponse(
        isTokenError ? "AUTH_ERROR" : ERROR_CODES.UNAUTHORIZED,
        isTokenError 
          ? "Authentication failed. Please sign in again."
          : "Please sign in to generate synthesis reports.",
        requestId
      ),
      { status: 401 }
    );
  }

  // Parse request body once (can only be read once) and get runId for deduplication
  let body: any;
  let runId: string | undefined;
  try {
    body = await req.json();
    runId = body?.runId;
  } catch (parseError: any) {
    // If body parsing fails, return error immediately (can't continue without body)
    logger.error(`[${requestId}] [synthesize-panel] Failed to parse request body`, {
      requestId,
      error: parseError?.message,
    });
    return NextResponse.json(
      createErrorResponse(
        ERROR_CODES.BAD_REQUEST,
        "Invalid request body",
        requestId,
        { details: parseError?.message }
      ),
      { status: 400 }
    );
  }

  // ============================================
  // REQUEST SIZE VALIDATION (Security Hardening)
  // ============================================
  try {
    const bodyString = JSON.stringify(body);
    const sizeValidation = validateRequestBodySize(bodyString, MAX_REQUEST_BODY_SIZE);
    if (!sizeValidation.valid) {
      return NextResponse.json(
        createErrorResponse(
          "REQUEST_TOO_LARGE",
          sizeValidation.message || "Request body is too large",
          requestId,
          sizeValidation.details
        ),
        { status: 413 }
      );
    }
  } catch (sizeError: any) {
    // Non-fatal: continue if size check fails
    logger.warn(`[${requestId}] [synthesize-panel] Could not validate request size`, {
      requestId,
      error: sizeError?.message,
    });
  }

  // ============================================
  // RATE LIMITING (Security Hardening)
  // ============================================
  const rateLimitResult = await checkRateLimit({
    maxRequests: 20, // 20 requests per minute per user
    windowSeconds: 60,
    identifier: `synthesize-panel:${uid}`,
  });

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      createErrorResponse(
        "RATE_LIMIT_EXCEEDED",
        "Too many synthesis requests. Please wait before trying again.",
        requestId,
        {
          retryAfter: rateLimitResult.retryAfter,
          resetAt: rateLimitResult.resetAt.toISOString(),
        }
      ),
      { 
        status: 429,
        headers: {
          "Retry-After": String(rateLimitResult.retryAfter || 60),
          "X-RateLimit-Limit": "20",
          "X-RateLimit-Remaining": String(rateLimitResult.remaining),
          "X-RateLimit-Reset": String(Math.floor(rateLimitResult.resetAt.getTime() / 1000)),
        },
      }
    );
  }

  // If we have a runId and a request is already in flight, check cache then await existing promise and clone response
  if (runId) {
    const existing = inFlightSynthesis.get(runId);
    if (existing) {
      logger.debug(`[${requestId}] [synthesize-panel] Request already in progress for runId: ${runId}, checking cache then awaiting existing promise`, { requestId, runId });
      // Check cache first before waiting on in-flight request
      try {
        if (adminDb) {
          const runDoc = await adminDb.collection("runs").doc(runId).get();
          if (runDoc.exists) {
            const data = runDoc.data();
            if (data?.synthesizedStructuredReport && data?.schemaVersion === 1) {
              logger.info(`[${requestId}] [synthesize-panel] Cache hit (while waiting for in-flight)`, {
                requestId,
                runId,
              });
              return NextResponse.json({
                ok: true,
                report: data.synthesizedStructuredReport,
                schemaVersion: 1,
                synthesizedBy: data.synthesizedBy || "gpt-5.1",
                cached: true,
              });
            }
          }
        }
      } catch (cacheError: any) {
        // Continue to wait on in-flight request if cache check fails
        logger.warn(`[${requestId}] [synthesize-panel] Cache check failed, waiting on in-flight request`, {
          requestId,
          error: cacheError?.message,
        });
      }
      // CRITICAL FIX: Await the existing promise and clone the response BEFORE reading
      // This prevents "ReadableStream is locked" errors when multiple requests share the same promise
      // Each request needs its own NextResponse instance with its own stream
      try {
        const existingResponse = await existing;
        
        // Clone the response BEFORE reading to avoid stream lock
        // This creates a new ReadableStream that can be consumed independently
        const clonedResponse = existingResponse.clone();
        
        // Read the JSON data from the cloned response
        const responseData = await clonedResponse.json();
        
        // Create a NEW NextResponse with the same data for this request
        // This ensures each concurrent request gets its own response stream
        return NextResponse.json(responseData, {
          status: existingResponse.status,
          headers: existingResponse.headers,
        });
      } catch (cloneError: any) {
        // If cloning/reading fails (e.g., stream already consumed), log and continue to create new request
        logger.warn(`[${requestId}] [synthesize-panel] Failed to clone/read existing response, creating new request`, {
          requestId,
          error: cloneError?.message,
        });
        // Continue to create new request below (fall through)
      }
    }
  }

  // Wrap the entire handler in getOrCreateSynthesisPromise for deduplication
  // Body is already parsed above and will be reused
  return getOrCreateSynthesisPromise(runId || requestId, async () => {
    // Body is already parsed above - reuse it (Next.js request body can only be read once)

    // Define timing variables at handler scope (safe for all code paths)
    // Detailed timing instrumentation for performance analysis (dev-only)
    const timing = {
      requestStart: Date.now(),
      parseStart: Date.now(),
      parseEnd: 0,
      validationStart: 0,
      validationEnd: 0,
      cacheCheckStart: 0,
      cacheCheckEnd: 0,
      firestoreReadStart: 0,
      firestoreReadEnd: 0,
      preprocessingStart: 0,
      preprocessingEnd: 0,
      llmStart: 0,
      llmEnd: 0,
      serializationStart: 0,
      serializationEnd: 0,
    };
    
    let llmStartTime: number | null = null;
    let llmElapsedMs: number | null = null;
    
    // Mark parse end
    timing.parseEnd = Date.now();
    
    // Dev-only timing flag (gated logging to avoid production noise)
    const isDebugTiming = process.env.NODE_ENV !== "production" || process.env.DEBUG_LOGS === "true";

    // Log request details (info level for production)
    logger.info(`[${requestId}] [synthesize-panel] Request parsed`, {
      requestId,
      phase: "parse",
      elapsedMs: timing.parseEnd - timing.parseStart,
      questionLength: body.question?.length || 0,
      resultsCount: Array.isArray(body.results || body.responses) ? (body.results || body.responses).length : 0,
    });

  try {
    // Use runId from outer scope (already parsed above, before ownership check)
    // This ensures we use the same runId throughout the handler

    // ============================================
    // OWNERSHIP VERIFICATION (Security Hardening)
    // ============================================
    // Verify the user owns the run they're trying to synthesize
    // Use runId from body (already parsed above)
    if (runId && adminDb) {
      try {
        const runDoc = await adminDb.collection("runs").doc(runId).get();
        if (runDoc.exists) {
          const runData = runDoc.data();
          const runUserId = runData?.userId;
          
          // Backward compatibility: if no userId exists in run doc, allow access for now
          // (old runs may not have userId field)
          // But log it for monitoring
          if (runUserId !== undefined && runUserId !== uid) {
            logger.warn(`[${requestId}] [synthesize-panel] Ownership check failed`, {
              requestId,
              runId,
              runUserId: redact({ uid: runUserId }).uid,
              requestUserId: redact({ uid }).uid,
            });
            return NextResponse.json(
              createErrorResponse(
                ERROR_CODES.FORBIDDEN,
                "You don't have access to this run.",
                requestId
              ),
              { status: 403 }
            );
          }
          
          if (!runUserId) {
            // Log missing userId for monitoring (old runs)
            logger.debug(`[${requestId}] [synthesize-panel] Run has no userId field (old run), allowing access`, { requestId, runId });
          }
        }
        // If run doesn't exist, continue - will be caught by validation below
      } catch (ownershipError: any) {
        // Non-fatal: log but continue (Firestore error shouldn't block synthesis)
        logger.warn(`[${requestId}] [synthesize-panel] Could not verify run ownership`, {
          requestId,
          error: ownershipError?.message,
        });
      }
    }

    // ============================================
    // INPUT VALIDATION (Enhanced with size checks)
    // ============================================
    const inputValidation = validateSynthesisRequest(body);
    if (!inputValidation.valid) {
      return NextResponse.json(
        createErrorResponse(
          inputValidation.errorCode || ERROR_CODES.VALIDATION_FAILED,
          inputValidation.message || "Invalid synthesis request",
          requestId,
          inputValidation.details
        ),
        { status: 400 }
      );
    }

    // Verify API key is available
    if (!OPENAI_API_KEY) {
      logger.error(`[${requestId}] [synthesize-panel] OpenAI API key not configured`, { requestId });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.INTERNAL_ERROR,
          "OpenAI API key not configured",
          requestId
        ),
        { status: 500 }
      );
    }
    
    // Check client abort again after parsing
    if (req.signal?.aborted) {
      logger.warn(`[${requestId}] [synthesize-panel] Request aborted after parsing`, {
        requestId,
        elapsed: Date.now() - startTime,
      });
      return NextResponse.json(
        { 
          ok: false,
          error: {
            code: "CLIENT_ABORT",
            message: "Request cancelled by client",
          },
        },
        { status: 499 }
      );
    }

    // Extract and validate request payload (runId already extracted above)
    const question = body.question;
    const results = body.results || body.responses || []; // Support both names for backward compatibility

    // Build validation details for helpful error messages
    const validationDetails: any = {
      hasRunId: !!runId && typeof runId === "string" && runId.trim().length > 0,
      hasQuestion: !!question && typeof question === "string" && question.trim().length > 0,
      resultsCount: Array.isArray(results) ? results.length : 0,
      validResultsCount: 0,
      uniqueModelIdsCount: 0,
      receivedKeys: Object.keys(body || {}),
    };

    // Validate runId
    if (!validationDetails.hasRunId) {
      logger.warn(`[${requestId}] [synthesize-panel] Validation failed: missing or invalid runId`, {
        requestId,
        ...redact(validationDetails),
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.BAD_REQUEST,
          "Invalid synthesis request: runId is required and must be a non-empty string",
          requestId,
          validationDetails
        ),
        { status: 400 }
      );
    }

    // Validate question
    if (!validationDetails.hasQuestion) {
      logger.warn(`[${requestId}] [synthesize-panel] Validation failed: missing or invalid question`, {
        requestId,
        ...redact(validationDetails),
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.BAD_REQUEST,
          "Invalid synthesis request: question is required and must be a non-empty string",
          requestId,
          validationDetails
        ),
        { status: 400 }
      );
    }

    // Validate results array
    if (!Array.isArray(results)) {
      logger.warn(`[${requestId}] [synthesize-panel] Validation failed: results is not an array`, {
        requestId,
        ...redact(validationDetails),
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.BAD_REQUEST,
          "Invalid synthesis request: results must be an array",
          requestId,
          validationDetails
        ),
        { status: 400 }
      );
    }

    // Validate each result and count valid ones
    const validResults: Array<{ modelId: string; text: string }> = [];
    const seenModelIds = new Set<string>();

    // IMPORTANT: Keep fullText and synthesisText separate
    // - fullText: Original unmodified text (used for UI display, never truncated)
    // - synthesisText: Truncated copy used ONLY for synthesis prompts (cost control)
    // This ensures Panel Response always shows complete output while synthesis uses truncated copy
    for (const result of results) {
      if (
        result &&
        typeof result === "object" &&
        typeof result.modelId === "string" &&
        result.modelId.trim().length > 0
      ) {
        // Extract full text from result (supports both rawTextFull and text field)
        const fullText = (result as any).rawTextFull || result.text || "";
        
        if (typeof fullText === "string" && fullText.trim().length > 0) {
          // Sanitize the full text first
          const sanitizedFullText = sanitizeModelText(fullText.trim());
          
          // Create truncated copy for synthesis (does NOT mutate original)
          const { text: synthesisText, wasTruncated: wasTruncatedForSynthesis } = truncateForSynthesis(
            sanitizedFullText,
            MAX_CHARS_SYNTHESIS_PER_MODEL
          );
          
          // Diagnostics: Log text lengths (debug level, no content)
          logger.debug(`[${requestId}] [synthesize-panel] Text processing`, {
            requestId,
            provider: result.modelId.trim(),
            fullTextLength: sanitizedFullText.length,
            synthesisTextLength: synthesisText.length,
            wasTruncatedForSynthesis,
            truncatedBy: sanitizedFullText.length - synthesisText.length,
          });
          
          // Store truncated text for synthesis (only field needed for synthesis)
          validResults.push({
            modelId: result.modelId.trim(),
            text: synthesisText, // Use truncated text for synthesis
          });
          seenModelIds.add(result.modelId.trim());
        }
      }
    }

    validationDetails.validResultsCount = validResults.length;
    validationDetails.uniqueModelIdsCount = seenModelIds.size;

    // Validate we have at least 2 valid results with unique model IDs
    if (validResults.length < 2) {
      logger.warn(`[${requestId}] [synthesize-panel] Validation failed: insufficient valid results`, {
        requestId,
        ...redact(validationDetails),
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.BAD_REQUEST,
          "Invalid synthesis request: at least 2 valid results are required",
          requestId,
          validationDetails
        ),
        { status: 400 }
      );
    }

    if (seenModelIds.size < 2) {
      logger.warn(`[${requestId}] [synthesize-panel] Validation failed: insufficient unique model IDs`, {
        requestId,
        ...redact(validationDetails),
      });
        return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.BAD_REQUEST,
          "Invalid synthesis request: at least 2 unique model IDs are required",
          requestId,
          validationDetails
        ),
          { status: 400 }
        );
    }

    // Extract model IDs and prepare for cluster-based input (if clusters provided)
    // Otherwise, we'll use the simple results format
    const modelIds = Array.from(seenModelIds);
    const agreementClusters = body.agreementClusters || [];
    const clusters = body.clusters || [];

    // Compute input hash for cache validation (before building prompt)
    const inputHash = runId ? computeInputHash(
      question,
      validResults,
      agreementClusters,
      clusters
    ) : null;
    
    // Parse forceRegenerate flag (from body or query params) - admin/dev only
    const forceRegenerate = body?.forceRegenerate === true || 
                           req.nextUrl.searchParams.get("forceRegenerate") === "true";
    const isAdminOrDev = process.env.NEXT_PUBLIC_DEBUG === "true" || process.env.NODE_ENV !== "production";
    const shouldForceRegenerate = forceRegenerate && isAdminOrDev;
    
    // Validate cache with input hash (skip if forceRegenerate is true for admin/dev)
    if (runId && adminDb && inputHash && !shouldForceRegenerate) {
      try {
        const runDoc = await adminDb.collection("runs").doc(runId).get();
        if (runDoc.exists) {
          const data = runDoc.data();
          const cachedHash = data?.synthesisInputHash;
          if (data?.synthesizedStructuredReport && data?.schemaVersion === 1 && cachedHash === inputHash) {
            // Cache hit with matching input hash - return immediately
            logger.info(`[${requestId}] [synthesize-panel] Cache hit - returning cached synthesis`, {
              requestId,
              elapsed: Date.now() - startTime,
              runId,
              inputHash,
              generatedAt: data.synthesizedAt,
            });
            return NextResponse.json({
              ok: true,
              report: data.synthesizedStructuredReport,
              schemaVersion: 1,
              synthesizedBy: data.synthesizedBy || "gpt-5.1",
              cached: true,
            });
          } else if (cachedHash && cachedHash !== inputHash) {
            // Input changed - cache invalid, will regenerate
            logger.debug(`[${requestId}] [synthesize-panel] Cache invalid (input hash changed)`, {
              requestId,
              runId,
              oldHash: cachedHash,
              newHash: inputHash,
            });
          }
        }
      } catch (cacheError: any) {
        // Continue - cache check failure shouldn't block generation
        logger.warn(`[${requestId}] [synthesize-panel] Cache validation failed`, {
          requestId,
          error: cacheError?.message,
        });
      }
    }

    // Mark preprocessing start
    timing.preprocessingStart = Date.now();
    
    // Build synthesis input: use compact evidence pack when clusters available (BIGGEST SPEED WIN)
    // CRITICAL: Use evidence pack to dramatically reduce prompt size (typically 80-95% reduction)
    // - Evidence pack: cluster summaries + minimal model evidence snippets (for bias detection only)
    // - Hard caps: max 30 clusters OR 15k chars, whichever comes first
    // - Keeps "most important" clusters first (largest consensus weight)
    let synthesisInput: string;
    let inputSizeChars: number;
    let evidencePack: ReturnType<typeof buildEvidencePack> | null = null;
    
    if (agreementClusters.length > 0) {
      // Build compact evidence pack from clusters (OPTIMIZATION: replaces full model responses)
      // This is the key speed optimization - reduces prompt from ~50k chars to ~15k chars
      const modelResponsesMap = new Map<string, string>();
      validResults.forEach(r => modelResponsesMap.set(r.modelId, r.text));
      
      evidencePack = buildEvidencePack(agreementClusters, modelResponsesMap, 30, 15000);
      
      // Use evidence pack cluster summaries for main synthesis input
      synthesisInput = evidencePack.clusterSummaries;
      inputSizeChars = evidencePack.totalChars;
      
      // Log evidence pack compression stats (debug level - verbose)
      const originalSize = validResults.reduce((sum, r) => sum + r.text.length, 0);
      logger.debug(`[${requestId}] [synthesize-panel] Evidence pack built`, {
        requestId,
        phase: "preprocessing",
        originalSizeChars: originalSize,
        compressedSizeChars: inputSizeChars,
        compressionRatio: (1 - inputSizeChars / originalSize).toFixed(2),
        clusterCount: agreementClusters.length,
        clustersUsed: evidencePack.clusterSummaries.split("\n\n").length,
      });
    } else {
      // Fallback: compress model responses to summaries + claims
      // This is much more compact than full text (typically 80-90% reduction)
      const compressedResults = validResults.map((r) => {
        const compressed = compressModelResponse(
          r.text,
          MAX_CHARS_PER_MODEL_SUMMARY,
          MAX_CLAIMS_PER_MODEL
        );
        
        let modelText = `<ModelResponse modelId="${r.modelId}">\n\n`;
        modelText += `## Summary\n${compressed.summary}\n\n`;
        if (compressed.claims.length > 0) {
          modelText += `## Key Claims\n${compressed.claims.map(c => `- ${c}`).join("\n")}\n\n`;
        }
        if (compressed.citations && compressed.citations.length > 0) {
          modelText += `## Citations\n${compressed.citations.slice(0, 5).join("\n")}\n\n`;
        }
        modelText += `</ModelResponse>`;
        
        return modelText;
      });
      
      synthesisInput = compressedResults.join("\n\n---\n\n");
      inputSizeChars = synthesisInput.length;
      
      // Apply hard cap if still too large
      if (inputSizeChars > MAX_TOTAL_PROMPT_CHARS) {
        const compressionRatio = MAX_TOTAL_PROMPT_CHARS / inputSizeChars;
        const reducedMaxChars = Math.floor(MAX_CHARS_PER_MODEL_SUMMARY * compressionRatio);
        
        const cappedResults = validResults.map((r) => {
          const compressed = compressModelResponse(
            r.text,
            reducedMaxChars,
            Math.max(5, Math.floor(MAX_CLAIMS_PER_MODEL * compressionRatio))
          );
          
          let modelText = `<ModelResponse modelId="${r.modelId}">\n\n`;
          modelText += `## Summary\n${compressed.summary}\n\n`;
          if (compressed.claims.length > 0) {
            modelText += `## Key Claims\n${compressed.claims.map(c => `- ${c}`).join("\n")}\n\n`;
          }
          modelText += `</ModelResponse>`;
          
          return modelText;
        });
        
        synthesisInput = cappedResults.join("\n\n---\n\n");
        inputSizeChars = synthesisInput.length;
        
        logger.warn(`[${requestId}] [synthesize-panel] Prompt exceeded ${MAX_TOTAL_PROMPT_CHARS} chars, applied compression`, {
          requestId,
          originalSize: inputSizeChars / compressionRatio,
          compressedSize: inputSizeChars,
          compressionRatio,
        });
      }
    }

    // Build the full prompt: use evidence pack model evidence if available, otherwise compress model responses
    // OPTIMIZATION: Evidence pack already includes minimal model evidence for bias detection
    // This reduces bias detection section from ~20k chars to ~5k chars (75% reduction)
    let modelResponsesText: string;
    if (evidencePack && evidencePack.modelEvidence) {
      // Use compact evidence pack model evidence (already extracted snippets)
      modelResponsesText = evidencePack.modelEvidence;
    } else {
      // Fallback: compress model responses to summaries + claims (for when clusters not available)
      modelResponsesText = validResults
        .map((r) => {
          const compressed = compressModelResponse(
            r.text,
            MAX_CHARS_PER_MODEL_SUMMARY,
            MAX_CLAIMS_PER_MODEL
          );
          
          let modelText = `<ModelResponse modelId="${r.modelId}">\n\n`;
          modelText += `## Summary\n${compressed.summary}\n\n`;
          if (compressed.claims.length > 0) {
            modelText += `## Key Claims\n${compressed.claims.map(c => `- ${c}`).join("\n")}\n\n`;
          }
          if (compressed.citations && compressed.citations.length > 0) {
            modelText += `## Citations\n${compressed.citations.slice(0, 5).join("\n")}\n\n`;
          }
          modelText += `</ModelResponse>`;
          
          return modelText;
        })
        .join("\n\n---\n\n");
    }
    
    // Calculate total prompt size and apply hard cap if needed
    let promptSizeChars = synthesisInput.length + modelResponsesText.length + 2000; // Add buffer for prompt template
    
    // Mark preprocessing end
    timing.preprocessingEnd = Date.now();
    
    // Performance diagnostics: log detailed timing breakdown (debug level)
    logger.debug(`[${requestId}] [synthesize-panel] Performance timing breakdown`, {
      requestId,
      phase: "preprocessing_complete",
      parseMs: timing.parseEnd - timing.parseStart,
      preprocessingMs: timing.preprocessingEnd - timing.preprocessingStart,
      totalElapsedMs: Date.now() - timing.requestStart,
      questionLength: question.length,
      modelIds,
      validResultsCount: validResults.length,
      usingClusters: agreementClusters.length > 0,
      clusterCount: agreementClusters.length,
      inputSizeChars: inputSizeChars || 0,
      promptSizeChars,
      modelEvidenceSizeChars: modelResponsesText.length,
      usingEvidencePack: !!evidencePack,
      inputHash: inputHash || "none",
    });
    
    // Production: minimal logging (info level)
    logger.info(`[${requestId}] [synthesize-panel] Synthesis input prepared`, {
      requestId,
      elapsed: Date.now() - startTime,
      inputSizeChars: inputSizeChars || 0,
      promptSizeChars,
    });
    
    // Check client abort before LLM call
    if (req.signal?.aborted) {
      logger.warn(`[${requestId}] [synthesize-panel] Request aborted before LLM call`, {
        requestId,
        elapsed: Date.now() - startTime,
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.CLIENT_ABORT,
          "Request cancelled by client",
          requestId
        ),
        { status: 499 }
      );
    }
    if (promptSizeChars > MAX_TOTAL_PROMPT_CHARS) {
      // Further reduce per-model summary size
      const compressionRatio = MAX_TOTAL_PROMPT_CHARS / promptSizeChars;
      const reducedMaxChars = Math.floor(MAX_CHARS_PER_MODEL_SUMMARY * compressionRatio);
      
      const cappedModelResponses = validResults.map((r) => {
        const compressed = compressModelResponse(
          r.text,
          reducedMaxChars,
          Math.max(5, Math.floor(MAX_CLAIMS_PER_MODEL * compressionRatio))
        );
        
        let modelText = `<ModelResponse modelId="${r.modelId}">\n\n`;
        modelText += `## Summary\n${compressed.summary}\n\n`;
        if (compressed.claims.length > 0) {
          modelText += `## Key Claims\n${compressed.claims.map(c => `- ${c}`).join("\n")}\n\n`;
        }
        modelText += `</ModelResponse>`;
        
        return modelText;
      });
      
      const cappedText = cappedModelResponses.join("\n\n---\n\n");
      logger.warn(`[${requestId}] [synthesize-panel] Prompt exceeded ${MAX_TOTAL_PROMPT_CHARS} chars, applied compression`, {
        requestId,
        originalSize: promptSizeChars,
        compressedSize: synthesisInput.length + cappedText.length + 2000,
        compressionRatio,
      });
    }

    // Build full prompt: use evidence pack format when available (more compact)
    let fullPrompt: string;
    if (agreementClusters.length > 0 && evidencePack) {
      // Evidence pack format (OPTIMIZED: compact cluster summaries + minimal model evidence)
      fullPrompt = `${SYNTHESIS_PROMPT}

## Research Question

${question.trim()}

## Cluster Analysis Data (Evidence Pack)

${evidencePack.clusterSummaries}

## Model Evidence Snippets (for bias detection only)

Each model response snippet is wrapped in <ModelResponse modelId="..."> tags. Use these tags to reliably cite excerpts when attributing biases.

${evidencePack.modelEvidence || "No model evidence snippets available."}

---

BIAS DETECTION REQUIREMENTS:
- Bias detection must be evidence-based: only attribute a bias to a model if there is a concrete indicator in that model's response
- Provide a short excerpt (max 240 chars, remove newlines) as evidence from each implicated model
- Excerpts must be direct quotes from the <ModelResponse> sections above - use the modelId tags to locate them precisely
- Use cautious language: "likely", "suggests", "may indicate" rather than definitive claims
- Include plausible likelyCauses (e.g., "training data skew", "geographic perspective bias") and actionable mitigationSteps
- If uncertain, do not attribute; instead list as 'open question' or 'possible blind spot across models'
- If no model-specific bias signals are confidently attributable, return an empty biasAndBlindSpots array []

CRITICAL: Output ONLY valid JSON matching the schema above. Do NOT output any text before or after the JSON object. Do NOT use HTML tags. Start your response IMMEDIATELY with { and end with }.
- Use the real model IDs from the cluster data (e.g., "chatgpt", "claude", "grok", "perplexity", "gemini") in all model references
- Do NOT use anonymous labels like "Alpha", "Beta", "Gamma", "Delta"
- Ensure all arrays exist (use empty arrays [] if a section has no items)
- Rank keyFindings by confidence (High first, then Medium, then Low, then Mixed)

COMPACT MODE: Keep responses concise to ensure complete output:
- executiveSummary: 2-3 paragraphs maximum
- keyFindings: 3-5 items only (top priority)
- disagreements: 2-4 items only
- biasAndBlindSpots: 0-3 items only
- openQuestions: 2-3 questions only
- methodology: 1-2 sentences only

IMMEDIATE OUTPUT: Begin your response with the opening brace { immediately. Do not include any preamble, explanation, or reasoning before the JSON object.`;
    } else {
      // Direct results input
      const resultsText = validResults
        .map((r) => `## ${r.modelId}\n\n${r.text}`)
      .join("\n\n---\n\n");

      fullPrompt = `${SYNTHESIS_PROMPT}

## Research Question

${question.trim()}

## Model Responses

Each model response is wrapped in <ModelResponse modelId="..."> tags. Use these tags to reliably cite excerpts when attributing biases.

${resultsText}

---

BIAS DETECTION REQUIREMENTS:
- Bias detection must be evidence-based: only attribute a bias to a model if there is a concrete indicator in that model's response
- Provide a short excerpt (max 240 chars, remove newlines) as evidence from each implicated model
- Excerpts must be direct quotes from the <ModelResponse> sections above - use the modelId tags to locate them precisely
- Use cautious language: "likely", "suggests", "may indicate" rather than definitive claims
- Include plausible likelyCauses (e.g., "training data skew", "geographic perspective bias") and actionable mitigationSteps
- If uncertain, do not attribute; instead list as 'open question' or 'possible blind spot across models'
- If no model-specific bias signals are confidently attributable, return an empty biasAndBlindSpots array []

CRITICAL: Output ONLY valid JSON matching the schema above. Do NOT output any text before or after the JSON object. Do NOT use HTML tags. Start your response IMMEDIATELY with { and end with }.
- Use the real model IDs from the responses above (e.g., "chatgpt", "claude", "grok", "perplexity", "gemini") in all model references
- Do NOT use anonymous labels like "Alpha", "Beta", "Gamma", "Delta"
- Ensure all arrays exist (use empty arrays [] if a section has no items)
- Rank keyFindings by confidence (High first, then Medium, then Low, then Mixed)

COMPACT MODE: Keep responses concise to ensure complete output:
- executiveSummary: 2-3 paragraphs maximum
- keyFindings: 3-5 items only (top priority)
- disagreements: 2-4 items only
- biasAndBlindSpots: 0-3 items only
- openQuestions: 2-3 questions only
- methodology: 1-2 sentences only

IMMEDIATE OUTPUT: Begin your response with the opening brace { immediately. Do not include any preamble, explanation, or reasoning before the JSON object.`;
    }

    // Create server-side timeout controller
    // Timeout: 300 seconds (5 minutes) - matches maxDuration export
    // This prevents LLM calls from hanging indefinitely and exhausting server resources
    const serverTimeoutController = new AbortController();
    const serverTimeoutId = setTimeout(() => {
      logger.warn(`[${requestId}] [synthesize-panel] Server timeout (300s) triggering abort`, {
        requestId,
        elapsed: Date.now() - startTime,
      });
      serverTimeoutController.abort("Server timeout after 300 seconds");
    }, 300000);
    
    // Combine client abort signal with server timeout signal
    // Use manual combination (AbortSignal.any may not be available in all Node.js versions)
    const combinedController = new AbortController();
    
    // Listen to client abort
    if (req.signal) {
      req.signal.addEventListener("abort", () => {
        logger.warn(`[${requestId}] [synthesize-panel] Client abort signal received`, {
          requestId,
          elapsed: Date.now() - startTime,
        });
        combinedController.abort("Client aborted");
        clearTimeout(serverTimeoutId);
      });
    }
    
    // Listen to server timeout
    serverTimeoutController.signal.addEventListener("abort", () => {
      combinedController.abort("Server timeout after 300 seconds");
    });
    
    const combinedSignal = combinedController.signal;
    
    logger.info(`[${requestId}] [synthesize-panel] Starting LLM call`, {
      requestId,
      elapsed: Date.now() - startTime,
      clientAborted: req.signal?.aborted || false,
    });
    
    // Create a Promise that rejects when signal aborts
    const createAbortPromise = (signal: AbortSignal): Promise<never> => {
      return new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error(signal.reason || "Request aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new Error(signal.reason || "Request aborted"));
        });
      });
    };
    
    // Model: GPT-5.1 for intelligent synthesis (quality over speed)
    // OPTIMIZATION NOTE: For faster synthesis (3-5s target), consider gpt-4o-mini:
    //   - Faster response time (~50% of gpt-5.1)
    //   - Lower quality but acceptable for structured synthesis
    //   - To switch: const model = process.env.SYNTHESIS_MODEL || "gpt-5.1";
    // Token limit: 8000 tokens (sufficient for compact evidence pack input)
    // Compact prompt mode (evidence pack) reduces reasoning overhead and ensures output starts immediately
    const model = "gpt-5.1";
    const tokenParams = getTokenParams(model, 8000);
    
    // CRITICAL: Ensure we use the correct parameter - GPT-5.1 requires max_completion_tokens
    // Double-check that tokenParams contains the right key (defensive programming)
    const finalTokenParams: { max_tokens?: number; max_completion_tokens?: number } = {};
    if (model.toLowerCase().startsWith("gpt-5") || model.toLowerCase().startsWith("o1") || model.toLowerCase().startsWith("o3") || model.toLowerCase().startsWith("o4")) {
      // GPT-5.x and reasoning models require max_completion_tokens
      finalTokenParams.max_completion_tokens = tokenParams.max_completion_tokens || 8000;
      // Explicitly ensure max_tokens is NOT present (prevent conflicts)
      delete (finalTokenParams as any).max_tokens;
    } else {
      // Other models use max_tokens
      finalTokenParams.max_tokens = tokenParams.max_tokens || 8000;
      // Explicitly ensure max_completion_tokens is NOT present (prevent conflicts)
      delete (finalTokenParams as any).max_completion_tokens;
    }
    
    logger.debug(`[${requestId}] [synthesize-panel] Using token params`, {
      requestId,
      model,
      tokenParam: Object.keys(finalTokenParams)[0],
      tokenValue: Object.values(finalTokenParams)[0],
    });
    
    // Track LLM call start time for performance diagnostics
    timing.llmStart = Date.now();
    llmStartTime = Date.now();
    
    let completion;
    let synthesisProvider: "openai" | "anthropic" = "openai";
    try {
      // Call OpenAI API with timeout using Promise.race (SDK may not support signal directly)
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

      const llmPromise = client.chat.completions.create({
        model,
      messages: [
        {
          role: "system",
            content: "You are a research synthesis expert. You MUST output valid JSON only, no HTML tags, no markdown headings. Your response must be a valid JSON object matching the provided schema. Start your response IMMEDIATELY with { - do not include any preamble, explanation, or reasoning before the JSON object. Focus on emitting output quickly rather than extensive internal reasoning.",
        },
        {
          role: "user",
          content: fullPrompt,
        },
      ],
      temperature: 0.3, // Lower temperature for more consistent synthesis
        ...finalTokenParams, // Use correct parameter based on model (explicitly set to prevent conflicts)
        response_format: { type: "json_object" }, // Force JSON output
      });
      
      // Race between LLM call and abort signal
      completion = await Promise.race([
        llmPromise,
        createAbortPromise(combinedSignal),
      ]);
      
      clearTimeout(serverTimeoutId);
      
      // Performance diagnostics: track LLM call duration
      timing.llmEnd = Date.now();
      if (llmStartTime !== null) {
        llmElapsedMs = Date.now() - llmStartTime;
      }
      
      // High-value production log: LLM call completed (info level)
      const initialFinishReason = completion?.choices?.[0]?.finish_reason || null;
      logger.info(`[${requestId}] [synthesize-panel] LLM call completed`, {
        requestId,
        phase: "llm_complete",
        llmElapsedMs: llmElapsedMs || 0,
        totalElapsedMs: Date.now() - startTime,
        finishReason: initialFinishReason,
        model,
      });
      
      // Detailed logging of OpenAI response structure (debug level - verbose)
      const choice = completion?.choices?.[0];
      const message = choice?.message;
      logger.debug(`[${requestId}] [synthesize-panel] LLM response details`, {
        requestId,
        hasCompletion: !!completion,
        responseKeys: completion ? Object.keys(completion) : [],
        choicesLength: completion?.choices?.length,
        finishReason: initialFinishReason,
        messageKeys: message ? Object.keys(message) : [],
        hasContent: !!message?.content,
        contentType: typeof message?.content,
        hasParsed: !!(message as any)?.parsed,
        hasRefusal: !!message?.refusal,
        hasToolCalls: !!message?.tool_calls,
        toolCallsLength: message?.tool_calls?.length || 0,
      });
    } catch (llmError: any) {
      clearTimeout(serverTimeoutId);
      
      // Check if it was a timeout or abort — no fallback for these
      const wasTimeout = serverTimeoutController.signal.aborted;
      const wasClientAbort = req.signal?.aborted;
      const wasCombinedAbort = combinedController.signal.aborted;
      
      if (wasTimeout || wasClientAbort || wasCombinedAbort || llmError?.message?.includes("timeout") || llmError?.message?.includes("aborted")) {
        logger.error(`[${requestId}] [synthesize-panel] LLM call timed out or aborted`, {
          requestId,
          elapsed: Date.now() - startTime,
          wasTimeout,
          wasClientAbort,
          wasCombinedAbort,
          error: llmError?.message || llmError,
        });
        return NextResponse.json(
          createErrorResponse(
            wasTimeout ? ERROR_CODES.TIMEOUT : ERROR_CODES.CLIENT_ABORT,
            wasTimeout ? "Synthesis timed out on server" : "Request cancelled by client",
            requestId,
            {
              elapsed: Date.now() - startTime,
              wasTimeout,
              wasClientAbort,
            }
          ),
          { status: wasTimeout ? 504 : 499 }
        );
      }
      
      // OpenAI failed (API error or other) — attempt Claude fallback before returning error
      logger.warn(`[${requestId}] [synthesize-panel] OpenAI failed, attempting Claude fallback`, {
        requestId,
        openaiError: llmError?.message || String(llmError),
        openaiStatus: llmError?.status,
      });
      
      try {
        const fallback = await callClaudeFallback(fullPrompt, requestId, combinedSignal);
        if (fallback.text && fallback.text.length > 0) {
          // Claude succeeded — build a synthetic completion-like object
          // so the downstream text-extraction path works without changes
          synthesisProvider = "anthropic";
          completion = {
            choices: [
              {
                message: { content: fallback.text, role: "assistant" as const, refusal: null },
                finish_reason: "stop",
                index: 0,
              },
            ],
          } as any;
          
          timing.llmEnd = Date.now();
          if (llmStartTime !== null) {
            llmElapsedMs = Date.now() - llmStartTime;
          }
          
          logger.info(`[${requestId}] [synthesize-panel] Claude fallback produced content, continuing`, {
            requestId,
            contentLength: fallback.text.length,
            model: fallback.model,
          });
          // Fall through to normal text-extraction + validation flow
        } else {
          // Claude also returned nothing — return the original OpenAI error
          logger.error(`[${requestId}] [synthesize-panel] Claude fallback returned no content`, { requestId });
          const isOpenAIError = llmError?.status && llmError.status >= 400 && llmError.status < 500;
          return NextResponse.json(
            createErrorResponse(
              isOpenAIError ? ERROR_CODES.OPENAI_API_ERROR : ERROR_CODES.INTERNAL_ERROR,
              "Both OpenAI and Claude failed to generate synthesis",
              requestId,
              {
                openaiError: llmError?.message,
                openaiStatus: llmError?.status,
                claudeFallback: "returned_empty",
              }
            ),
            { status: 502 }
          );
        }
      } catch (fallbackError: any) {
        // Claude fallback also failed — return original OpenAI error with fallback context
        logger.error(`[${requestId}] [synthesize-panel] Claude fallback also failed`, {
          requestId,
          openaiError: llmError?.message,
          claudeError: fallbackError?.message || String(fallbackError),
        });
        const isOpenAIError = llmError?.status && llmError.status >= 400 && llmError.status < 500;
        return NextResponse.json(
          createErrorResponse(
            isOpenAIError ? ERROR_CODES.OPENAI_API_ERROR : ERROR_CODES.INTERNAL_ERROR,
            "Both OpenAI and Claude failed to generate synthesis",
            requestId,
            {
              openaiError: llmError?.message,
              openaiStatus: llmError?.status,
              claudeError: fallbackError?.message,
            }
          ),
          { status: 502 }
        );
      }
    }
    
    // Check client abort after LLM call
    if (req.signal?.aborted) {
      logger.warn(`[${requestId}] [synthesize-panel] Request aborted after LLM call`, {
        requestId,
        elapsed: Date.now() - startTime,
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.CLIENT_ABORT,
          "Request cancelled by client",
          requestId
        ),
        { status: 499 }
      );
    }

    // Extract text content using robust unified extractor
    // This handles all known OpenAI response formats (Chat Completions, Responses API, structured outputs)
    // Try new robust extractor first, fallback to legacy extractor for compatibility
    let synthesizedText: string | null = extractModelText(completion);
    if (!synthesizedText || synthesizedText.length === 0) {
      // Fallback to legacy extractor if new one returns null
      synthesizedText = extractOpenAIText(completion);
    }
    
    let finishReason = completion?.choices?.[0]?.finish_reason;
    const hitLengthLimit = isPartialResponse(completion);

    // Performance diagnostics: log final response metrics
    const totalElapsed = Date.now() - startTime;
    
    // High-value production log: Performance diagnostics (info level)
    logger.info(`[${requestId}] [synthesize-panel] Performance diagnostics`, {
      requestId,
      cacheHit: false,
      inputSizeChars: inputSizeChars || 0,
      llmElapsedMs: llmElapsedMs,
      totalElapsedMs: totalElapsed,
      finishReason: finishReason || null,
      hasContent: !!synthesizedText,
      contentLength: synthesizedText?.length || 0,
    });

    // Handle finishReason='length' (model hit token limit) or empty output
    // Strategy:
    // 1. If we have partial content, try to parse it (might be valid JSON)
    // 2. If partial content is valid, return it with partial flag (better than nothing)
    // 3. If no partial content or completely empty, retry with same compact prompt but higher token limit
    let isPartialContent = false;
    
    if (hitLengthLimit && synthesizedText && synthesizedText.length > 0) {
      // Try to parse partial content - might be valid JSON even if truncated
      try {
        const partialJson = extractJsonObject(synthesizedText);
        const parsedPartial = JSON.parse(partialJson);
        // Basic validation: check if it has expected top-level keys
        if (parsedPartial && typeof parsedPartial === 'object' && 
            (parsedPartial.executiveSummary || parsedPartial.keyFindings || parsedPartial.disagreements)) {
          logger.warn(`[${requestId}] [synthesize-panel] Response hit token limit but partial content is parseable`, {
            requestId,
            finishReason,
            contentLength: synthesizedText.length,
            hasExecutiveSummary: !!parsedPartial.executiveSummary,
            keyFindingsCount: Array.isArray(parsedPartial.keyFindings) ? parsedPartial.keyFindings.length : 0,
          });
          // Mark as partial but continue - we'll validate it below
          isPartialContent = true;
        }
      } catch {
        // Partial content is not valid JSON - will retry below if no content
      }
    }
    
    // Only retry if we got completely empty output (not partial)
    // This can happen if finishReason='length' and model hit token limit before emitting any output
    if (!req.signal?.aborted && (!synthesizedText || synthesizedText.length === 0)) {
      const isLengthLimit = finishReason === 'length' || hitLengthLimit;
      
      logger.warn(`[${requestId}] [synthesize-panel] Empty output received, retrying with compressed prompt`, {
        requestId,
        finishReason,
        isLengthLimit,
        hasContent: !!synthesizedText,
        hitLengthLimit,
      });
      
      try {
        // Compress prompt further by reducing model response text per model (3000 chars for retry)
        const RETRY_MAX_CHARS_PER_MODEL = 3000; // More aggressive compression for retry
        const compressedModelResponses = validResults
          .map((r) => {
            const compressedText = r.text.length > RETRY_MAX_CHARS_PER_MODEL
              ? r.text.substring(0, RETRY_MAX_CHARS_PER_MODEL) + "\n\n[Text truncated for prompt size...]"
              : r.text;
            return `<ModelResponse modelId="${r.modelId}">\n\n${compressedText}\n\n</ModelResponse>`;
          })
          .join("\n\n---\n\n");
        
        // Build compressed prompt (use same structure but with more aggressive truncation)
        const compressedPrompt = agreementClusters.length > 0
          ? `${SYNTHESIS_PROMPT}

## Research Question

${question.trim()}

## Cluster Analysis Data

${synthesisInput}

## Full Model Responses (for bias detection and evidence extraction) - Compressed

Each model response is wrapped in <ModelResponse modelId="..."> tags. Use these tags to reliably cite excerpts when attributing biases.

${compressedModelResponses}

---

BIAS DETECTION REQUIREMENTS:
- Bias detection must be evidence-based: only attribute a bias to a model if there is a concrete indicator in that model's response
- Provide a short excerpt (max 240 chars, remove newlines) as evidence from each implicated model
- Excerpts must be direct quotes from the <ModelResponse> sections above - use the modelId tags to locate them precisely
- Use cautious language: "likely", "suggests", "may indicate" rather than definitive claims
- Include plausible likelyCauses (e.g., "training data skew", "geographic perspective bias") and actionable mitigationSteps
- If uncertain, do not attribute; instead list as 'open question' or 'possible blind spot across models'
- If no model-specific bias signals are confidently attributable, return an empty biasAndBlindSpots array []

CRITICAL: Output ONLY valid JSON matching the schema above. Do NOT output any text before or after the JSON object. Do NOT use HTML tags. Start your response IMMEDIATELY with { and end with }.

COMPACT MODE: Keep responses concise to ensure complete output:
- executiveSummary: 2-3 paragraphs maximum
- keyFindings: 3-5 items only (top priority)
- disagreements: 2-4 items only
- biasAndBlindSpots: 0-3 items only
- openQuestions: 2-3 questions only
- methodology: 1-2 sentences only

IMMEDIATE OUTPUT: Begin your response with the opening brace { immediately. Do not include any preamble, explanation, or reasoning before the JSON object.`
          : `${SYNTHESIS_PROMPT}

## Research Question

${question.trim()}

## Model Responses (Compressed)

Each model response is wrapped in <ModelResponse modelId="..."> tags.

${compressedModelResponses}

---

BIAS DETECTION REQUIREMENTS:
- Bias detection must be evidence-based: only attribute a bias to a model if there is a concrete indicator in that model's response
- Provide a short excerpt (max 240 chars, remove newlines) as evidence from each implicated model
- Excerpts must be direct quotes from the <ModelResponse> sections above - use the modelId tags to locate them precisely
- Use cautious language: "likely", "suggests", "may indicate" rather than definitive claims
- Include plausible likelyCauses (e.g., "training data skew", "geographic perspective bias") and actionable mitigationSteps
- If uncertain, do not attribute; instead list as 'open question' or 'possible blind spot across models'
- If no model-specific bias signals are confidently attributable, return an empty biasAndBlindSpots array []

CRITICAL: Output ONLY valid JSON matching the schema above. Do NOT output any text before or after the JSON object. Do NOT use HTML tags. Start your response IMMEDIATELY with { and end with }.

COMPACT MODE: Keep responses concise to ensure complete output:
- executiveSummary: 2-3 paragraphs maximum
- keyFindings: 3-5 items only (top priority)
- disagreements: 2-4 items only
- biasAndBlindSpots: 0-3 items only
- openQuestions: 2-3 questions only
- methodology: 1-2 sentences only

IMMEDIATE OUTPUT: Begin your response with the opening brace { immediately. Do not include any preamble, explanation, or reasoning before the JSON object.`;
        
        // Retry with compressed prompt and same token limit (8000)
        const retryTokenParams = getTokenParams(model, 8000);
        
        // Ensure correct parameter (same as initial call)
        const retryFinalTokenParams: { max_tokens?: number; max_completion_tokens?: number } = {};
        if (model.toLowerCase().startsWith("gpt-5") || model.toLowerCase().startsWith("o1") || model.toLowerCase().startsWith("o3") || model.toLowerCase().startsWith("o4")) {
          retryFinalTokenParams.max_completion_tokens = retryTokenParams.max_completion_tokens || 8000;
          delete (retryFinalTokenParams as any).max_tokens;
        } else {
          retryFinalTokenParams.max_tokens = retryTokenParams.max_tokens || 8000;
          delete (retryFinalTokenParams as any).max_completion_tokens;
        }
        
        const retryClient = new OpenAI({ apiKey: OPENAI_API_KEY });
        const retryCompletion = await retryClient.chat.completions.create({
          model,
          messages: [
            {
              role: "system",
              content: "You are a research synthesis expert. You MUST output valid JSON only, no HTML tags, no markdown headings. Your response must be a valid JSON object matching the provided schema. Start your response IMMEDIATELY with { - do not include any preamble, explanation, or reasoning before the JSON object.",
            },
            {
              role: "user",
              content: compressedPrompt, // Use compressed prompt (3000 chars per model)
            },
          ],
          temperature: 0.2, // Lower temperature for more consistent output
          ...retryFinalTokenParams, // Use correct parameter (explicitly set to prevent conflicts)
          response_format: { type: "json_object" },
        });
        
        // Use robust extractor for retry as well
        let retryText: string | null = extractModelText(retryCompletion);
        if (!retryText || retryText.length === 0) {
          retryText = extractOpenAIText(retryCompletion);
        }
        const retryFinishReason = retryCompletion?.choices?.[0]?.finish_reason;
        
        logger.debug(`[${requestId}] [synthesize-panel] Retry completed`, {
          requestId,
          hasContent: !!retryText,
          contentLength: retryText?.length || 0,
          finishReason: retryFinishReason,
        });
        
        if (retryText && retryText.length > 0) {
          synthesizedText = retryText;
          finishReason = retryFinishReason;
          logger.info(`[${requestId}] [synthesize-panel] Retry succeeded, using retry content`, { requestId });
        } else {
          logger.error(`[${requestId}] [synthesize-panel] Retry also returned no content`, {
            requestId,
            finishReason: retryFinishReason,
          });
        }
      } catch (retryError: any) {
        logger.error(`[${requestId}] [synthesize-panel] Retry failed`, {
          requestId,
          error: retryError?.message || retryError,
          status: retryError?.status,
        });
        // Continue to error handling below if retry fails
      }
    }

    // Final check — if OpenAI returned no content after retry, try Claude before giving up
    if (!synthesizedText || synthesizedText.length === 0) {
      logger.warn(`[${requestId}] [synthesize-panel] No content from OpenAI after retry, attempting Claude fallback`, {
        requestId,
        originalFinishReason: finishReason,
      });

      try {
        const fallback = await callClaudeFallback(fullPrompt, requestId, combinedSignal);
        if (fallback.text && fallback.text.length > 0) {
          synthesizedText = fallback.text;
          synthesisProvider = "anthropic";
          finishReason = "stop";
          logger.info(`[${requestId}] [synthesize-panel] Claude fallback succeeded after OpenAI empty output`, {
            requestId,
            contentLength: fallback.text.length,
            model: fallback.model,
          });
        }
      } catch (fallbackError: any) {
        logger.error(`[${requestId}] [synthesize-panel] Claude fallback failed after OpenAI empty output`, {
          requestId,
          error: fallbackError?.message || String(fallbackError),
        });
      }
    }

    // Still no content after all attempts (OpenAI + retry + Claude) — return error
    if (!synthesizedText || synthesizedText.length === 0) {
      logger.error(`[${requestId}] [synthesize-panel] No content from any provider`, {
        requestId,
        originalFinishReason: finishReason,
        responseStructure: {
          hasChoices: !!completion?.choices,
          choicesLength: completion?.choices?.length,
          hasMessage: !!completion?.choices?.[0]?.message,
          hasContent: !!completion?.choices?.[0]?.message?.content,
          hasParsed: !!(completion?.choices?.[0]?.message as any)?.parsed,
          hasToolCalls: !!completion?.choices?.[0]?.message?.tool_calls,
          finishReason,
        },
      });
      const finalFinishReason = finishReason;
      const isLengthLimitFinal = finalFinishReason === 'length' || hitLengthLimit;
      
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.EMPTY_MODEL_OUTPUT,
          isLengthLimitFinal
            ? "Model response was truncated. Try again with a shorter question or fewer models."
            : "Model returned no text content.",
          requestId,
          {
            finishReason: finalFinishReason,
            model,
            diagnostics: {
              hitLengthLimit: isLengthLimitFinal,
              hasChoices: !!completion?.choices,
              hasMessage: !!completion?.choices?.[0]?.message,
              messageKeys: completion?.choices?.[0]?.message ? Object.keys(completion?.choices?.[0]?.message) : [],
              hasToolCalls: !!completion?.choices?.[0]?.message?.tool_calls,
              toolCallsCount: completion?.choices?.[0]?.message?.tool_calls?.length || 0,
            },
          }
        ),
        { status: 502 } // Bad Gateway - upstream service returned invalid response
      );
    }

    // Extract JSON from response (handle cases where model adds markdown code blocks)
    function extractJsonObject(text: string): string {
      let jsonText = text.trim();
      
      // Remove markdown code blocks if present
      if (jsonText.startsWith("```json")) {
        jsonText = jsonText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      } else if (jsonText.startsWith("```")) {
        jsonText = jsonText.replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      
      // Find the first { and last } to extract JSON object
      const firstBrace = jsonText.indexOf("{");
      const lastBrace = jsonText.lastIndexOf("}");
      
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = jsonText.substring(firstBrace, lastBrace + 1);
      }
      
      return jsonText;
    }

    // Extract and parse JSON
    let parsedReport: any;
    try {
      const jsonText = extractJsonObject(synthesizedText);
      parsedReport = JSON.parse(jsonText);
    } catch (parseError: any) {
      logger.error(`[${requestId}] [synthesize-panel] JSON parse error`, {
        requestId,
        error: parseError?.message,
        rawPreview: synthesizedText.substring(0, 500),
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.INTERNAL_ERROR,
          "Failed to parse synthesis report as JSON",
          requestId,
          {
            parseError: parseError?.message,
          }
        ),
        { status: 500 }
      );
    }

    // Check client abort before validation
    if (req.signal?.aborted) {
      logger.warn(`[${requestId}] [synthesize-panel] Request aborted before validation`, {
        requestId,
        elapsed: Date.now() - startTime,
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.CLIENT_ABORT,
          "Request cancelled by client",
          requestId
        ),
        { status: 499 }
      );
    }
    
    // Validate with Zod schema
    // This ensures the generated report matches our expected structure before storing/returning
    let validatedReport: StructuredSynthesis;
    try {
      validatedReport = StructuredSynthesisSchema.parse(parsedReport);
      // High-value production log: Schema validation passed (info level)
      logger.info(`[${requestId}] [synthesize-panel] Schema validation passed`, {
        requestId,
        elapsed: Date.now() - startTime,
        keyFindingsCount: validatedReport.keyFindings.length,
        disagreementsCount: validatedReport.disagreements.length,
        biasAndBlindSpotsCount: validatedReport.biasAndBlindSpots.length,
        openQuestionsCount: validatedReport.openQuestions.length,
      });
    } catch (validationError: any) {
      logger.error(`[${requestId}] [synthesize-panel] Schema validation failed`, {
        requestId,
        error: validationError?.message,
        errors: validationError?.errors,
        rawPreview: synthesizedText.substring(0, 500),
        parsedReportKeys: parsedReport ? Object.keys(parsedReport) : [],
      });
      
      // Retry once with "fix JSON" prompt if validation fails
      // Use the same provider that generated the initial response
      try {
        logger.debug(`[${requestId}] [synthesize-panel] Retrying with fix JSON prompt (provider: ${synthesisProvider})`, { requestId });
        const fixPrompt = `${fullPrompt}\n\nThe previous response failed validation. Please fix the JSON to match the exact schema. Ensure all required fields are present and correctly typed.`;
        
        let retryText: string | null = null;

        if (synthesisProvider === "anthropic") {
          const fallback = await callClaudeFallback(fixPrompt, requestId, combinedSignal);
          retryText = fallback.text;
        } else {
          const retryModel = model;
          const retryTokenParams = getTokenParams(retryModel, 3000);
          
          logger.debug(`[${requestId}] [synthesize-panel] Retry using token params`, {
            requestId,
            model: retryModel,
            tokenParam: Object.keys(retryTokenParams)[0],
            tokenValue: Object.values(retryTokenParams)[0],
          });
          
          const retryClient = new OpenAI({ apiKey: OPENAI_API_KEY });
          const retryCompletion = await retryClient.chat.completions.create({
            model: retryModel,
            messages: [
              {
                role: "system",
                content: "You are a research synthesis expert. You MUST output valid JSON only, no HTML tags, no markdown headings. Your response must be a valid JSON object matching the provided schema.",
              },
              {
                role: "user",
                content: fixPrompt,
              },
            ],
            temperature: 0.2,
            ...retryTokenParams,
            response_format: { type: "json_object" },
          });
          
          retryText = extractOpenAIText(retryCompletion);
        }

        if (retryText && retryText.length > 0) {
          const retryJson = extractJsonObject(retryText);
          validatedReport = StructuredSynthesisSchema.parse(JSON.parse(retryJson));
          logger.info(`[${requestId}] [synthesize-panel] Retry validation passed`, { requestId });
        } else {
          logger.error(`[${requestId}] [synthesize-panel] Retry returned no content`, { requestId });
          throw new Error("Retry returned no content");
        }
      } catch (retryError: any) {
        const isOpenAIError = retryError?.status && retryError.status >= 400 && retryError.status < 500;
        if (isOpenAIError) {
          logger.error(`[${requestId}] [synthesize-panel] API error in validation retry`, {
            requestId,
            status: retryError.status,
            message: retryError?.message || retryError,
          });
          return NextResponse.json(
            createErrorResponse(
              ERROR_CODES.OPENAI_API_ERROR,
              retryError?.message || "API request failed during validation retry",
              requestId,
              {
                status: retryError.status,
                type: retryError?.type,
                param: retryError?.param,
              }
            ),
            { status: retryError.status || 400 }
          );
        }
        return NextResponse.json(
          createErrorResponse(
            ERROR_CODES.VALIDATION_FAILED,
            `Schema validation failed: ${validationError?.message || "Invalid structure"}`,
            requestId,
            {
              validationErrors: validationError?.errors,
              receivedKeys: parsedReport ? Object.keys(parsedReport) : [],
              requiredFields: ["executiveSummary", "keyFindings", "disagreements", "biasAndBlindSpots", "openQuestions", "methodology"],
              retryFailed: true,
            }
          ),
          { status: 500 }
        );
      }
    }

    // Mark serialization start
    timing.serializationStart = Date.now();
    
    // Store in Firestore if runId is provided (with input hash for cache validation)
    if (runId && adminDb) {
      try {
        const totalElapsed = Date.now() - timing.requestStart;
        
        await adminDb.collection("runs").doc(runId).update({
          synthesizedStructuredReport: validatedReport,
          schemaVersion: 1,
          synthesizedAt: Timestamp.now(),
          synthesizedBy: synthesisProvider === "anthropic" ? CLAUDE_SYNTHESIS_MODEL : model,
          synthesisInputHash: inputHash || null, // Store input hash for cache validation
          synthesisMetadata: {
            inputSizeChars: inputSizeChars || 0,
            llmElapsedMs: llmElapsedMs,
            totalElapsedMs: totalElapsed,
            finishReason: finishReason || null,
            cached: false,
          },
        });
        
        timing.serializationEnd = Date.now();
        
        // Final detailed timing summary (dev-only)
        if (isDebugTiming) {
          logger.debug(`[${requestId}] [synthesize-panel] Performance timing summary`, {
            requestId,
            phase: "complete",
            parseMs: timing.parseEnd - timing.parseStart,
            preprocessingMs: timing.preprocessingEnd - timing.preprocessingStart,
            llmMs: timing.llmEnd - timing.llmStart,
            serializationMs: timing.serializationEnd - timing.serializationStart,
            totalElapsedMs: totalElapsed,
            promptSizeChars,
            inputSizeChars: inputSizeChars || 0,
            modelEvidenceSizeChars: modelResponsesText.length,
            finishReason: finishReason || null,
            model,
            usingEvidencePack: !!evidencePack,
          });
        }
        // Production: minimal logging (info level)
        logger.info(`[${requestId}] [synthesize-panel] Stored structured synthesis in Firestore`, { 
          requestId,
          runId,
          inputHash,
          totalElapsedMs: totalElapsed,
          inputSizeChars,
        });
      } catch (firestoreError: any) {
        logger.error(`[${requestId}] [synthesize-panel] Failed to store structured synthesis in Firestore`, {
          requestId,
          error: firestoreError?.message || firestoreError,
        });
        // Don't fail the request if Firestore write fails - still return the report
        // This ensures users get their synthesis even if caching fails
      }
    }

    // Return structured JSON response
    // Include partial flag if content was truncated (finishReason='length' with usable partial content)
    const actualModel = synthesisProvider === "anthropic" ? CLAUDE_SYNTHESIS_MODEL : model;
    const response: any = {
      ok: true,
      report: validatedReport,
      schemaVersion: 1,
      synthesizedBy: actualModel,
    };
    
    // If response was partial (hit token limit but had usable content), include warning flag
    if (isPartialContent) {
      response.partial = true;
      logger.warn(`[${requestId}] [synthesize-panel] Returning partial synthesis (hit token limit)`, {
        requestId,
      });
    }

    // Check client abort one final time before returning
    if (req.signal?.aborted) {
      logger.warn(`[${requestId}] [synthesize-panel] Request aborted before response`, {
        requestId,
        elapsed: Date.now() - startTime,
      });
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.CLIENT_ABORT,
          "Request cancelled by client",
          requestId
        ),
        { status: 499 }
      );
    }
    
    // Final summary log with detailed timing (dev-only) or minimal (production)
    // Note: isDebugTiming is defined in the handler scope earlier
    const finalSummaryTiming = process.env.NODE_ENV !== "production" || process.env.DEBUG_LOGS === "true";
    if (finalSummaryTiming) {
      const totalElapsed = Date.now() - timing.requestStart;
      logger.debug(`[${requestId}] [synthesize-panel] Performance summary (final)`, {
        requestId,
        phase: "complete",
        parseMs: timing.parseEnd - timing.parseStart,
        preprocessingMs: timing.preprocessingEnd - timing.preprocessingStart,
        llmMs: timing.llmEnd - timing.llmStart,
        serializationMs: timing.serializationEnd - timing.serializationStart,
        totalElapsedMs: totalElapsed,
        promptSizeChars,
        finishReason: finishReason || null,
        model,
        keyFindingsCount: validatedReport.keyFindings.length,
        disagreementsCount: validatedReport.disagreements.length,
        usingEvidencePack: !!evidencePack,
      });
    } else {
      // High-value production log: Returning structured synthesis response (info level)
      logger.info(`[${requestId}] [synthesize-panel] Returning structured synthesis response`, {
        requestId,
        elapsed: Date.now() - startTime,
        ok: true,
        keyFindingsCount: validatedReport.keyFindings.length,
        disagreementsCount: validatedReport.disagreements.length,
        runId,
        cached: false,
      });
    }

    return NextResponse.json(response);
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    const wasClientAbort = req.signal?.aborted;
    // Use existing requestId or generate new one if catch block reached before requestId was set
    const finalRequestId = requestId || generateRequestId();
    
    logger.error(`[${finalRequestId}] [synthesize-panel] Unexpected error`, {
      requestId: finalRequestId,
      elapsed,
      error: error?.message || error,
      stack: error?.stack,
      name: error?.name,
      wasClientAbort,
      clientSignalAborted: req.signal?.aborted || false,
    });
    
    // If client aborted, return 499
    if (wasClientAbort) {
      return NextResponse.json(
        createErrorResponse(
          ERROR_CODES.CLIENT_ABORT,
          "Request cancelled by client",
          finalRequestId
        ),
        { status: 499 }
      );
    }
    
    // Return consistent error response format
    return NextResponse.json(
      createErrorResponse(
        ERROR_CODES.INTERNAL_ERROR,
        error?.message || "Failed to generate synthesis",
        finalRequestId,
        {
          errorName: error?.name,
          elapsed: Date.now() - startTime,
        }
      ),
      { status: 500 }
    );
  }
  }); // Close getOrCreateSynthesisPromise wrapper
}

