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
import { ModelId, RunPanelApiResponse } from "@/lib/types";
import { splitQuestionAndContext } from "@/lib/questionContext";
import { resolveRequestIdentity } from "@/lib/auth/resolveRequestIdentity";
import { logIdentityResolutionFailure } from "@/lib/auth/identityResolutionTelemetry";
import { checkAndIncrementUsageForRun } from "@/lib/stripe/usageCheck";
import { validateUserSubscription } from "@/lib/stripe/subscriptionValidation";
import { createRun } from "@/lib/firestore/runs";
import { loadUserAndTeam } from "@/lib/teams/teamApiAuth";
import { logger } from "@/lib/logger";
import {
  ADAPTIVE_SCHEMAS_ENABLED,
  PERSONAL_RUN_WORKSPACE_WRITES_ENABLED,
  PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS,
  WORKSPACES_ENABLED,
} from "@/lib/env";
import { resolvePersonalRunWorkspaceBinding } from "@/lib/workspaces/personalRunWorkspaceBinding";
import { resolvePersonalRunWorkspaceWriteMode } from "@/lib/workspaces/personalRunWorkspaceWriteCanary";
import { planAdaptiveRun, AdaptivePromptPlan, buildNonExecutionPayload } from "@/lib/adaptiveSchema/orchestrate";
import { trackQueryClassified, trackRoutingOutcome } from "@/lib/adaptiveSchema/analytics";
// Phase 8C-D.1 — the shared ordinary-run execution/finalization engine,
// mechanically extracted from this route so the Team POST route
// (app/api/workspaces/[workspaceId]/runs/route.ts) can call the exact
// same code. See lib/runPanelExecution.ts's own module doc for the
// persistence-agnostic invariant this route's `createRun()` best-effort
// behavior depends on.
import { executeOrdinaryRun } from "@/lib/runPanelExecution";

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
    
    // Auth Identity Consistency Remediation, Step 7 — resolves via the
    // shared, hardened resolver (considers cookie AND bearer, fails
    // closed on a confirmed identity mismatch) rather than this route's
    // own duplicated cookie-first logic. Error-message mapping is
    // unchanged: `missing_credentials` -> "Please sign in to run a
    // panel." (errorCode "unauthorized"); everything else -> "Authentication
    // failed. Please sign in again." (errorCode "auth_error").
    const identity = await resolveRequestIdentity(req);
    if (identity.status !== "authenticated") {
      logIdentityResolutionFailure({ route: "POST /api/run-panel", method: "POST", failureCategory: identity.reason });
      const isTokenError = identity.reason !== "missing_credentials";
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
    const uid = identity.uid;

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
    // QUERY-ROUTING REDESIGN (Milestone 1.5) — PRE-EXECUTION GUARD
    // ============================================
    // routeClassifiedQuery() (called once, inside planAdaptiveRun, and
    // stored as adaptivePlan.routing) is the SAME function
    // AdaptivePanelResponse.tsx calls client-side to decide what to
    // render — never duplicated here. Only `kind: "active"` may reach
    // checkAndIncrementUsageForRun/createRun/runPanel below: a Claim/Video
    // Verification handoff, a disabled schema, a clarification-required
    // question, or an unanswerable request must invoke zero models, spend
    // zero plan quota, and never create a runs/{runId} doc that would look
    // like a completed research run.
    if (adaptivePlan && adaptivePlan.routing.kind !== "active") {
      trackQueryClassified(uid, adaptivePlan.classification);
      trackRoutingOutcome(uid, adaptivePlan.classification, adaptivePlan.routing);
      return NextResponse.json(buildNonExecutionPayload(adaptivePlan.classification, adaptivePlan.routing));
    }
    if (adaptivePlan) {
      trackQueryClassified(uid, adaptivePlan.classification);
    }

    // ============================================
    // WORKSPACE-AWARE WRITES FOR NEW PERSONAL ADAPTIVE RUNS, PHASE 3 —
    // PREREQUISITE CHECK
    // ============================================
    // Resolved here — BEFORE subscription validation, BEFORE plan-quota/
    // usage increment (checkAndIncrementUsageForRun below), BEFORE any
    // model execution (runPanel further down) — specifically so a
    // request that is already known to be unable to satisfy the Phase 3
    // write contract never spends model tokens or consumes usage quota
    // for research it cannot persist. This is a distinct failure class
    // from an ordinary createRun() failure after successful research
    // (handled separately, in its own established best-effort way, at
    // the CREATE RUN RECORD section below).
    //
    // Scoped to adaptive runs only: by this point, the routing guard
    // above has already guaranteed `adaptivePlan` is either null (adaptive
    // disabled or classification failed — a legacy/Deep-Research request)
    // or has `routing.kind === "active"` (a genuine adaptive request) — a
    // non-active routing already returned early. So `adaptivePlan !== null`
    // here IS "this is a genuine adaptive request," with no separate
    // `.routing.kind` check needed. For a null adaptivePlan (Deep
    // Research), this entire block — including write-mode resolution,
    // `loadUserAndTeam`, `getPersonalWorkspaceId`, and `getWorkspace` — is
    // skipped entirely; Phase 3 does not cover Deep Research, so no
    // Workspace lookup of any kind is ever attempted for it.
    const runId = `run-${randomUUID()}`;
    let workspaceIdForRun: string | undefined;
    // Personal Run/Project Schema Canonicalization, Phase 8C-B1.3B — only
    // ever set inside the SAME "bound" branch that sets workspaceIdForRun
    // above, so projectIdForRun can structurally never be set without a
    // real, resolved Personal workspaceId alongside it (the invariant is
    // enforced by control flow, not by a separate runtime check). No
    // longer gated by PROJECT_RUN_ASSOCIATION_WRITES_ENABLED/its canary —
    // that flag's role in suppressing this neutral `null` write was the
    // source of a rollout-transition gap (workspaceId present, projectId
    // absent) that Phase 8C-B1.3A/8C-B1.3A.1 audited and closed here. The
    // flag and its resolver remain in use elsewhere (e.g. the assign/
    // move/unassign endpoint's own eligibility gate) — only this specific
    // neutral-shape write is now unconditional.
    let projectIdForRun: null | undefined;
    if (adaptivePlan !== null) {
      // Account-Scoped Workspace Write Canary, Phase 3A — the ONLY thing
      // this adds is which uids get `writesEnabled: true` below. A
      // malformed canary allowlist is always logged (regardless of
      // whether it even mattered — see `canaryConfigInvalid`'s own doc
      // comment), but NEVER changes eligibility beyond what
      // `resolvePersonalRunWorkspaceWriteMode()` itself already decided
      // (global precedence, fail-closed-to-off for a bad list when
      // global is off) — no separate, competing "what if config is bad"
      // branch exists here.
      const writeMode = resolvePersonalRunWorkspaceWriteMode({
        uid,
        globalWritesEnabled: PERSONAL_RUN_WORKSPACE_WRITES_ENABLED,
        canaryUidsRaw: PERSONAL_RUN_WORKSPACE_WRITE_CANARY_UIDS,
      });
      if (writeMode.canaryConfigInvalid) {
        logger.error("[run-panel] personal_run_workspace_write_canary_configuration_invalid", { runId });
      }
      if (writeMode.enabled) {
        logger.info("[run-panel] personal_run_workspace_write_mode", { runId, source: writeMode.source });
        const teamCtx = await loadUserAndTeam(uid);
        const binding = await resolvePersonalRunWorkspaceBinding({
          uid,
          writesEnabled: writeMode.enabled,
          workspacesEnabled: WORKSPACES_ENABLED,
          hasTeam: !!teamCtx?.team,
        });
        switch (binding.outcome) {
          case "bound": {
            workspaceIdForRun = binding.workspaceId;
            logger.info("[run-panel] personal_run_workspace_bound", { runId });

            // Schema canonicalization, Phase 8C-B1.3B — a Personal
            // Workspace-bound run always gets an explicit `projectId: null`
            // at creation. This is neutral shape only: it creates no
            // Project, assigns no Project, and changes no Project CRUD/UI
            // eligibility (those remain gated separately by
            // PROJECTS_ENABLED/PROJECTS_UI_ENABLED/their own canaries).
            // Piggybacks exclusively on the binding this branch just
            // established — never independently resolves or manufactures
            // a Workspace association.
            projectIdForRun = null;
            break;
          }
          case "resolution_failed": {
            // Fail BEFORE model execution — never silently fall back to
            // creating a legacy (non-workspace-bound) run once write
            // rollout is enabled, and never spend model tokens on a
            // request already known to be unable to persist. Sanitized:
            // never leaks the owner uid, a Firestore path, or a raw
            // Firebase error — only a stable, generic reason code.
            logger.error("[run-panel] personal_run_workspace_resolution_failed", { runId, reason: binding.reason });
            const sanitizedReason: "workspace_missing" | "workspace_unavailable" | "workspace_invalid" =
              binding.reason === "not_found"
                ? "workspace_missing"
                : binding.reason === "lookup_failed"
                  ? "workspace_unavailable"
                  : "workspace_invalid"; // malformed | wrong_owner | wrong_type | invalid_uid
            const status = sanitizedReason === "workspace_unavailable" ? 503 : 409;
            const message =
              sanitizedReason === "workspace_missing"
                ? "Your account isn't fully set up yet. Please try signing in again."
                : sanitizedReason === "workspace_unavailable"
                  ? "We couldn't verify your account right now. Please try again in a moment."
                  : "There's a problem with your account setup. Please contact support.";
            const response: RunPanelApiResponse = { ok: false, errorCode: "workspace_prerequisite_failed", message };
            return NextResponse.json(response, { status });
          }
          case "invalid_configuration": {
            // Rollout-integrity hardening: writeMode.enabled=true (from
            // EITHER global RW or a canary match) with W=false must never
            // silently downgrade to a legacy write — whoever activated
            // write mode for this uid expects a Workspace-associated run,
            // and a silent legacy fallback would let production quietly
            // keep generating unbound records with no visible signal.
            // Rejected before any model execution or usage consumption,
            // same as a resolution failure above. Reused verbatim from
            // Phase 3's own global-RW handling — this branch has no
            // canary-specific logic at all.
            logger.error("[run-panel] personal_run_workspace_configuration_invalid", { runId, reason: binding.reason });
            const response: RunPanelApiResponse = {
              ok: false,
              errorCode: "workspace_configuration_invalid",
              message: "This feature is temporarily unavailable. Please try again later.",
            };
            return NextResponse.json(response, { status: 500 });
          }
          case "team_user":
          case "flag_off":
            // Not applicable — proceeds exactly as legacy, not a failure.
            // "flag_off" is structurally unreachable from this call site
            // (writeMode.enabled is already true here), kept only because
            // resolvePersonalRunWorkspaceBinding()'s own return type
            // still includes it for its other, direct callers/tests.
            break;
        }
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
    // `workspaceIdForRun` was already resolved (or determined not
    // applicable) further up, before any model execution — see the
    // WORKSPACE PREREQUISITE CHECK block above. This section only
    // performs the actual best-effort persistence write. A failure HERE
    // (e.g. a transient Firestore write error) is a different failure
    // class from a Workspace PREREQUISITE failure: research has not run
    // yet at this point either way, and this mirrors the pre-existing,
    // established "run creation is for tracking, not critical for
    // execution" degradation for any other createRun() failure.
    try {
      await createRun(runId, uid, trimmedQuestion, selectedModels, workspaceIdForRun, projectIdForRun);
    } catch (runError: any) {
      // Log but don't fail - run creation is for tracking, not critical for execution
      logger.error("[run-panel] Failed to create run record", { error: runError });
    }


    // ============================================
    // SHARED ORDINARY RUN EXECUTION (Phase 8C-D.1)
    // ============================================
    // Mechanically extracted into lib/runPanelExecution.ts so the Team
    // POST route can share it. Does NOT require createRun() above to
    // have succeeded — see that module's own doc comment.
    const debugRawResponseRequested = req.headers.get("x-debug-raw") === "1";
    const execution = await executeOrdinaryRun({
      uid,
      runId,
      trimmedQuestion,
      context,
      selectedModels: selectedModels as ModelId[],
      adaptivePlan,
      debugRawResponseRequested,
    });

    return NextResponse.json(
      {
        ...execution.body,
        usage: {
          runsThisMonth: usage.runsThisMonth,
          maxRunsPerMonth: usage.maxRunsPerMonth,
          maxModelsPerRun: usage.maxModelsPerRun,
        },
      },
      { status: execution.status }
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
